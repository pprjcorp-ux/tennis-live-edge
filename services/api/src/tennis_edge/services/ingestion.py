from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Protocol
from uuid import uuid4

from tennis_edge.domain import (
    Match,
    MatchAnalysis,
    MatchFreshness,
    Provider,
    ProviderMatchPayload,
    RawProviderPayload,
    Signal,
)
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.normalizer import payload_checksum
from tennis_edge.services.signal_engine import build_signals


class MatchSource(Protocol):
    async def get_today_matches(self, target_date: date) -> list[Match | ProviderMatchPayload]:
        ...


class ArchiveOddsSource(Protocol):
    async def get_tennis_h2h_events(self):
        ...


class OperationalStore(Protocol):
    def latest_analyses(self, target_date: date) -> list[MatchAnalysis]:
        ...

    def save_analyses(self, analyses: list[MatchAnalysis]) -> None:
        ...

    def save_raw_payloads(self, payloads: list[RawProviderPayload]) -> None:
        ...


@dataclass(frozen=True)
class OperationalSnapshot:
    analyses: list[MatchAnalysis]
    source: str
    persisted: bool
    generated_at: datetime
    raw_payloads_saved: int = 0


SignalGate = Callable[[Match, list[Signal]], list[Signal]]
ArchiveAugmenter = Callable[[list[Match], ArchiveOddsSource], Awaitable[list[Match]]]


class LiveIngestionPipeline:
    """Build the canonical operational snapshot for a target date.

    Provider clients fetch and parse raw external data. This pipeline owns the
    transition from provider-facing matches into decision snapshots that are
    persisted and served as the local source of truth.
    """

    def __init__(
        self,
        match_source: MatchSource,
        archive_source: ArchiveOddsSource,
        store: OperationalStore,
        *,
        signal_gate: SignalGate,
        archive_augmenter: ArchiveAugmenter,
    ) -> None:
        self.match_source = match_source
        self.archive_source = archive_source
        self.store = store
        self.signal_gate = signal_gate
        self.archive_augmenter = archive_augmenter

    async def snapshot_for_date(self, target_date: date) -> OperationalSnapshot:
        matches = await self._fetch_matches(target_date)
        provider_matches, raw_payloads = _split_provider_matches(matches)
        if not provider_matches:
            persisted = self.store.latest_analyses(target_date)
            if persisted:
                return OperationalSnapshot(
                    analyses=persisted,
                    source="persisted_fallback",
                    persisted=True,
                    generated_at=_now(),
                    raw_payloads_saved=0,
                )
            return OperationalSnapshot(
                analyses=[],
                source="empty",
                persisted=False,
                generated_at=_now(),
                raw_payloads_saved=0,
            )

        matches = await self.archive_augmenter(provider_matches, self.archive_source)
        analyses = [self._analysis_for_match(match) for match in matches]
        saved_payloads = raw_payloads or _raw_payloads_from_matches(matches)
        self.store.save_raw_payloads(saved_payloads)
        self.store.save_analyses(analyses)
        source = _snapshot_source(matches)
        return OperationalSnapshot(
            analyses=analyses,
            source=source,
            persisted=source != "sample",
            generated_at=_now(),
            raw_payloads_saved=len(saved_payloads),
        )

    async def _fetch_matches(self, target_date: date) -> list[Match | ProviderMatchPayload]:
        try:
            return await self.match_source.get_today_matches(target_date)
        except Exception:
            return []

    def _analysis_for_match(self, match: Match) -> MatchAnalysis:
        features = build_features(match)
        prediction = predict_match(match, features)
        signals = build_signals(match, prediction, features)
        signals = self.signal_gate(match, signals)
        source = _snapshot_source([match])
        return MatchAnalysis(
            match=match,
            features=features,
            prediction=prediction,
            signals=signals,
            freshness=_freshness_for_match(match, source=source, persisted=source != "sample"),
        )


def _split_provider_matches(
    records: list[Match | ProviderMatchPayload],
) -> tuple[list[Match], list[RawProviderPayload]]:
    matches: list[Match] = []
    raw_payloads: list[RawProviderPayload] = []
    for record in records:
        if isinstance(record, ProviderMatchPayload):
            matches.append(record.match)
            raw_payloads.append(record.raw_payload)
        else:
            matches.append(record)
    return matches, raw_payloads


def _raw_payloads_from_matches(matches: list[Match]) -> list[RawProviderPayload]:
    payloads: list[RawProviderPayload] = []
    for match in matches:
        provider = _primary_provider(match)
        source_ts = match.scheduled_at if match.state.status == "prematch" else _now()
        body = match.model_dump(mode="json")
        payload_type = "fixture" if match.state.status == "prematch" else "score"
        source_event_id = match.provider_match_id or match.id
        payloads.append(
            RawProviderPayload(
                id=f"raw_{provider.value}_{uuid4().hex[:16]}",
                provider=provider,
                payload_type=payload_type,
                source_event_id=source_event_id,
                source_ts=source_ts,
                payload=body,
                checksum=payload_checksum(
                    provider,
                    payload_type,
                    body,
                    source_event_id=source_event_id,
                    source_ts=source_ts,
                ),
            )
        )
    return payloads


def _primary_provider(match: Match) -> Provider:
    if "api_tennis" in match.provider_ids:
        return Provider.API_TENNIS
    if "theoddsapi" in match.provider_ids:
        return Provider.THE_ODDS_API
    return Provider.SAMPLE


def _snapshot_source(matches: list[Match]) -> str:
    if matches and all(_primary_provider(match) == Provider.SAMPLE for match in matches):
        return "sample"
    return "provider_live"


def _freshness_for_match(match: Match, source: str, persisted: bool) -> MatchFreshness:
    now = _now()
    odds_source_ts = max((quote.source_ts for quote in match.odds), default=None)
    score_source_ts = match.scheduled_at if match.state.status == "prematch" else now
    provider_lineage = [_primary_provider(match)]
    if match.odds:
        provider_lineage.append(Provider.ODDS_API_IO)
    return MatchFreshness(
        source=source,
        persisted=persisted,
        score_source_ts=score_source_ts,
        odds_source_ts=odds_source_ts,
        score_age_ms=max(0, int((now - score_source_ts).total_seconds() * 1000)),
        odds_age_ms=max(0, int((now - odds_source_ts).total_seconds() * 1000))
        if odds_source_ts
        else None,
        provider_lineage=list(dict.fromkeys(provider_lineage)),
        note="Canonical operational snapshot built by LiveIngestionPipeline.",
    )


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)

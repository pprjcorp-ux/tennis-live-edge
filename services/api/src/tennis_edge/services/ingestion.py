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
from tennis_edge.services.provider_lineage import (
    primary_provider_for_ids,
    provider_lineage_for_match,
)
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

    def save_analyses(self, analyses: list[MatchAnalysis]) -> bool:
        ...

    def save_raw_payloads(self, payloads: list[RawProviderPayload]) -> int:
        ...


@dataclass(frozen=True)
class OperationalSnapshot:
    analyses: list[MatchAnalysis]
    source: str
    persisted: bool
    generated_at: datetime
    raw_payloads_saved: int = 0
    provider_warnings: list[str] | None = None


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
        provider_warnings = _source_warnings(self.match_source)
        provider_matches, raw_payloads, score_source_ts_by_key = _split_provider_matches(matches)
        if not provider_matches:
            try:
                persisted = self.store.latest_analyses(target_date)
            except Exception as exc:
                if hasattr(self.store, "_record_read_error"):
                    self.store._record_read_error("latest_analyses", exc)
                persisted = []
            if persisted:
                return OperationalSnapshot(
                    analyses=persisted,
                    source="persisted_fallback",
                    persisted=True,
                    generated_at=_now(),
                    raw_payloads_saved=0,
                    provider_warnings=provider_warnings,
                )
            return OperationalSnapshot(
                analyses=[],
                source="empty",
                persisted=False,
                generated_at=_now(),
                raw_payloads_saved=0,
                provider_warnings=provider_warnings,
            )

        matches = await self.archive_augmenter(provider_matches, self.archive_source)
        provider_warnings = [
            *provider_warnings,
            *_source_warnings(self.archive_source),
        ]
        analyses = [
            self._analysis_for_match(
                match,
                score_source_ts=score_source_ts_by_key.get(_match_key(match)),
            )
            for match in matches
        ]
        source = _snapshot_source(matches)
        saved_payloads = raw_payloads or _raw_payloads_from_matches(matches)
        raw_payloads_saved = 0
        analyses_saved = False
        if source != "sample":
            raw_payloads_saved = self.store.save_raw_payloads(saved_payloads)
            analyses_saved = self.store.save_analyses(analyses)
        persisted = source != "sample" and (analyses_saved or raw_payloads_saved > 0)
        analyses = [_with_freshness_persisted(analysis, persisted) for analysis in analyses]
        return OperationalSnapshot(
            analyses=analyses,
            source=source,
            persisted=persisted,
            generated_at=_now(),
            raw_payloads_saved=raw_payloads_saved,
            provider_warnings=provider_warnings,
        )

    async def _fetch_matches(self, target_date: date) -> list[Match | ProviderMatchPayload]:
        try:
            return await self.match_source.get_today_matches(target_date)
        except Exception:
            return []

    def _analysis_for_match(
        self,
        match: Match,
        *,
        score_source_ts: datetime | None = None,
    ) -> MatchAnalysis:
        match = _with_score_latency(match, score_source_ts)
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
            freshness=_freshness_for_match(
                match,
                source=source,
                persisted=source != "sample",
                score_source_ts=score_source_ts,
            ),
        )


def _split_provider_matches(
    records: list[Match | ProviderMatchPayload],
) -> tuple[list[Match], list[RawProviderPayload], dict[str, datetime]]:
    matches_by_key: dict[str, Match] = {}
    raw_payloads: list[RawProviderPayload] = []
    source_timestamps_by_key: dict[str, tuple[int, datetime]] = {}
    for record in records:
        if isinstance(record, ProviderMatchPayload):
            _merge_match(matches_by_key, record.match)
            raw_payloads.append(record.raw_payload)
            _merge_source_timestamp(source_timestamps_by_key, record.raw_payload)
        else:
            _merge_match(matches_by_key, record)
    return (
        list(matches_by_key.values()),
        raw_payloads,
        {key: value[1] for key, value in source_timestamps_by_key.items()},
    )


def _source_warnings(source: MatchSource) -> list[str]:
    warnings = getattr(source, "last_warnings", [])
    if not isinstance(warnings, list):
        return []
    return [str(warning) for warning in warnings]


def _match_key(match: Match) -> str:
    return match.provider_match_id or match.id


def _merge_match(matches_by_key: dict[str, Match], match: Match) -> None:
    key = _match_key(match)
    current = matches_by_key.get(key)
    if current is None or _match_preference_rank(match) >= _match_preference_rank(current):
        matches_by_key[key] = match


def _match_preference_rank(match: Match) -> int:
    if match.state.status == "live":
        return 3
    if match.state.status == "finished":
        return 2
    return 0


def _merge_source_timestamp(
    timestamps_by_key: dict[str, tuple[int, datetime]],
    payload: RawProviderPayload,
) -> None:
    rank = _payload_freshness_rank(payload)
    if rank == 0:
        return
    current = timestamps_by_key.get(payload.source_event_id)
    if (
        current is None
        or rank > current[0]
        or (rank == current[0] and payload.source_ts > current[1])
    ):
        timestamps_by_key[payload.source_event_id] = (rank, payload.source_ts)


def _payload_freshness_rank(payload: RawProviderPayload) -> int:
    if payload.payload_type in {"score", "point"}:
        return 2
    if payload.payload_type == "fixture":
        return 1
    return 0


def _with_score_latency(match: Match, score_source_ts: datetime | None) -> Match:
    if not score_source_ts or match.state.status != "live":
        return match
    source_latency_ms = max(0, int((_now() - score_source_ts).total_seconds() * 1000))
    return match.model_copy(
        update={
            "state": match.state.model_copy(
                update={"source_latency_ms": source_latency_ms}
            )
        }
    )


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
    return primary_provider_for_ids(match.provider_ids)


def _snapshot_source(matches: list[Match]) -> str:
    if matches and all(_primary_provider(match) == Provider.SAMPLE for match in matches):
        return "sample"
    return "provider_live"


def _freshness_for_match(
    match: Match,
    source: str,
    persisted: bool,
    *,
    score_source_ts: datetime | None = None,
) -> MatchFreshness:
    now = _now()
    odds_source_ts = max((quote.source_ts for quote in match.odds), default=None)
    score_source_ts = score_source_ts or (
        match.scheduled_at if match.state.status == "prematch" else now
    )
    return MatchFreshness(
        source=source,
        persisted=persisted,
        score_source_ts=score_source_ts,
        odds_source_ts=odds_source_ts,
        score_age_ms=max(0, int((now - score_source_ts).total_seconds() * 1000)),
        odds_age_ms=max(0, int((now - odds_source_ts).total_seconds() * 1000))
        if odds_source_ts
        else None,
        provider_lineage=provider_lineage_for_match(match),
        note="Canonical operational snapshot built by LiveIngestionPipeline.",
    )


def _with_freshness_persisted(
    analysis: MatchAnalysis,
    persisted: bool,
) -> MatchAnalysis:
    if analysis.freshness is None:
        return analysis
    return analysis.model_copy(
        update={
            "freshness": analysis.freshness.model_copy(update={"persisted": persisted})
        }
    )


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)

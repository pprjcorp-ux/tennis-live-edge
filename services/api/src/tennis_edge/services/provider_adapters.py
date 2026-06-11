from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import date
from typing import Any, Protocol, runtime_checkable

from tennis_edge.domain import (
    CanonicalMatch,
    OddsTick,
    ProviderCursor,
    ProviderLatency,
    ProviderMatchPayload,
    RawProviderPayload,
)
from tennis_edge.services.normalizer import canonical_match_from_match


@runtime_checkable
class ScoreProviderAdapter(Protocol):
    """Score/fixture providers normalize into canonical match payloads.

    API-specific JSON stays inside the provider. The rest of the system consumes
    ProviderMatchPayload, whose raw payload can be replayed into ScoreTick later.
    """

    async def get_today_match_payloads(self, target_date: date) -> list[ProviderMatchPayload]:
        ...

    async def get_livescore_payloads(self) -> list[ProviderMatchPayload]:
        ...


@runtime_checkable
class OddsProviderAdapter(Protocol):
    """Live odds providers normalize messages into raw payloads, odds ticks and cursors."""

    async def stream_live_messages(
        self,
        *,
        stream: str = "tennis:moneyline",
        last_seq: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        ...

    def raw_payload_from_message(
        self,
        payload: dict[str, Any],
        stream: str = "tennis:moneyline",
    ) -> RawProviderPayload:
        ...

    def ingest_message(
        self,
        payload: dict[str, Any],
        current_cursor: ProviderCursor | None = None,
        stream: str = "tennis:moneyline",
        remember_in_process: bool = True,
    ) -> tuple[list[OddsTick], ProviderCursor]:
        ...


class ArchiveOddsEvent(Protocol):
    id: str
    quotes: list[OddsTick]
    raw_payload: RawProviderPayload | None


@runtime_checkable
class ArchiveOddsProviderAdapter(Protocol):
    """Archive/snapshot odds providers return replayable event snapshots."""

    async def get_tennis_h2h_events(self) -> list[ArchiveOddsEvent]:
        ...


def provider_latency_from_payload(
    provider_payload: RawProviderPayload,
    *,
    feed: str,
    healthy: bool = True,
) -> ProviderLatency:
    latency_ms = max(
        0,
        int(
            (provider_payload.ingested_at - provider_payload.source_ts).total_seconds()
            * 1000
        ),
    )
    return ProviderLatency(
        provider=provider_payload.provider,
        feed=feed,
        latest_source_ts=provider_payload.source_ts,
        latest_ingested_at=provider_payload.ingested_at,
        latency_ms=latency_ms,
        healthy=healthy,
    )


def canonical_match_from_provider_payload(
    provider_payload: ProviderMatchPayload,
) -> CanonicalMatch:
    return canonical_match_from_match(provider_payload.match)

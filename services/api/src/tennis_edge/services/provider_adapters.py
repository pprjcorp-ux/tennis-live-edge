from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal, Protocol, runtime_checkable

from tennis_edge.domain import (
    CanonicalMatch,
    OddsTick,
    Provider,
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


@dataclass(frozen=True)
class AdapterContractSpec:
    provider: Provider
    adapter_contract: str
    fake_api: str
    input_contracts: tuple[str, ...]
    output_contracts: tuple[str, ...]
    scenarios: tuple[str, ...]
    notes: tuple[str, ...]
    status: Literal["covered", "pending"] = "covered"


BUDGET_PROVIDER_CONTRACT_SPECS: tuple[AdapterContractSpec, ...] = (
    AdapterContractSpec(
        provider=Provider.API_TENNIS,
        adapter_contract="ScoreProviderAdapter",
        fake_api="Simulated API-Tennis fixtures/livescore",
        input_contracts=("RawProviderPayload", "CanonicalMatch"),
        output_contracts=("ScoreTick", "ProviderLatency"),
        scenarios=("score_snapshot", "live_score_state"),
        notes=("Budget replay emits API-Tennis score payloads without provider quota.",),
    ),
    AdapterContractSpec(
        provider=Provider.ODDS_API_IO,
        adapter_contract="OddsProviderAdapter",
        fake_api="Simulated Odds-API.io websocket",
        input_contracts=("RawProviderPayload", "seq", "lastSeq"),
        output_contracts=("OddsTick", "ProviderCursor", "ProviderLatency"),
        scenarios=("healthy", "gap", "resync_required"),
        notes=("Replay validates cursor gaps and resync_required before live websocket keys.",),
    ),
    AdapterContractSpec(
        provider=Provider.THE_ODDS_API,
        adapter_contract="ArchiveOddsProviderAdapter",
        fake_api="Simulated TheOddsAPI REST snapshot",
        input_contracts=("RawProviderPayload",),
        output_contracts=("OddsTick", "ProviderLatency"),
        scenarios=("archive_snapshot",),
        notes=("Archive odds replay is used as fallback/comparison before live providers.",),
    ),
)


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

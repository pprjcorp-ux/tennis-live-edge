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
    status: Literal["covered", "pending", "shadow", "deferred"] = "covered"


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


ENTERPRISE_PROVIDER_CONTRACT_SPECS: tuple[AdapterContractSpec, ...] = (
    AdapterContractSpec(
        provider=Provider.SPORTRADAR,
        adapter_contract="EnterpriseTimelineProviderAdapter",
        fake_api="Offline Sportradar live timeline fixture",
        input_contracts=("RawProviderPayload", "CanonicalMatch", "timeline_events"),
        output_contracts=(
            "ScoreTick",
            "PointEvent",
            "ProviderLatency",
            "retirement_delay_walkover_state",
        ),
        scenarios=("timeline_point", "timeline_delay", "timeline_retirement"),
        notes=(
            "Shadow/deferred only: provider_api_call_allowed=false.",
            "Fixture validates timeline semantics without a Sportradar key, quota, or live feed.",
        ),
        status="deferred",
    ),
    AdapterContractSpec(
        provider=Provider.BETRADAR_UOF,
        adapter_contract="EnterpriseMarketStateProviderAdapter",
        fake_api="Offline Betradar UOF market-state fixture",
        input_contracts=(
            "RawProviderPayload",
            "market_status",
            "betstop_or_suspension",
        ),
        output_contracts=("MarketState", "ProviderLatency", "market_suspension"),
        scenarios=("market_open", "market_suspended", "market_settled"),
        notes=(
            "Shadow/deferred only: provider_api_call_allowed=false.",
            "Fixture validates market-state semantics without a Betradar token or live package.",
        ),
        status="deferred",
    ),
    AdapterContractSpec(
        provider=Provider.TXODDS,
        adapter_contract="EnterpriseInRunningOddsProviderAdapter",
        fake_api="Offline TXODDS in-running tennis odds fixture",
        input_contracts=(
            "RawProviderPayload",
            "sequence",
            "bookmaker",
            "market",
        ),
        output_contracts=("OddsTick", "ProviderLatency", "market_odds_snapshot"),
        scenarios=("in_running_odds", "price_move", "stale_quote"),
        notes=(
            "Shadow/deferred only: provider_api_call_allowed=false.",
            "Fixture validates in-running odds semantics without TXODDS credentials or quota.",
        ),
        status="deferred",
    ),
    AdapterContractSpec(
        provider=Provider.BETFAIR,
        adapter_contract="EnterpriseExchangeMarketStreamAdapter",
        fake_api="Offline Betfair exchange market stream fixture",
        input_contracts=(
            "RawProviderPayload",
            "marketId",
            "selectionId",
            "publishTime",
        ),
        output_contracts=(
            "ProviderLatency",
            "exchange_market_depth",
            "traded_volume",
        ),
        scenarios=("market_book", "price_ladder", "market_closed"),
        notes=(
            "Shadow/deferred market-data only: provider_api_call_allowed=false.",
            "Fixture does not enable order placement, account access, or execution credentials.",
        ),
        status="deferred",
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

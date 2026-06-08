import asyncio
from datetime import date, datetime, timedelta, timezone

import pytest

from tennis_edge.config import Settings
from tennis_edge.domain import (
    AgentAutopilotRequest,
    AgentActionStatus,
    AgentRun,
    AgentRunType,
    DataQualitySnapshot,
    ExecutionOrder,
    ExecutionVenue,
    OrderRequest,
    OrderStatus,
    PaperSettlement,
    PaperSettleRequest,
    Provider,
    SignalStatus,
)
from tennis_edge.services.agent_ops import AGENT_RUNS
from tennis_edge.services.execution_engine import CANCELABLE_ORDER_STATUSES, ORDERS
from tennis_edge.services.repository import AnalysisRepository


class AgentStoreStub:
    def __init__(self, fallback) -> None:
        self.fallback = fallback
        self.saved_runs: list[AgentRun] = []
        self.saved_orders: list[ExecutionOrder] = []
        self.settle_requests: list[PaperSettleRequest] = []
        self.cancel_requests: list[str] = []
        self.cancel_results: dict[str, OrderStatus | None] = {}
        self.persisted_runs: list[AgentRun] = []
        self.persisted_orders: list[ExecutionOrder] = []
        self.persisted_data_quality: list[DataQualitySnapshot] = []

    def __getattr__(self, name):
        return getattr(self.fallback, name)

    def save_agent_run(self, run: AgentRun) -> None:
        self.saved_runs.append(run)

    def agent_runs(self) -> list[AgentRun]:
        return list(self.persisted_runs)

    def save_order(self, order: ExecutionOrder) -> None:
        self.saved_orders.append(order)

    def orders(self) -> list[ExecutionOrder]:
        return list(self.persisted_orders)

    def data_quality(self) -> list[DataQualitySnapshot]:
        return list(self.persisted_data_quality)

    def cancel_order(self, order_id: str) -> OrderStatus | None:
        self.cancel_requests.append(order_id)
        if order_id in self.cancel_results:
            return self.cancel_results[order_id]
        for index, order in enumerate(self.persisted_orders):
            if order.id == order_id and order.status in CANCELABLE_ORDER_STATUSES:
                self.persisted_orders[index] = order.model_copy(update={"status": OrderStatus.CANCELLED})
                return OrderStatus.CANCELLED
        return None

    def settle_paper_order(self, request: PaperSettleRequest) -> PaperSettlement | None:
        self.settle_requests.append(request)
        order = next(
            (item for item in self.persisted_orders if item.id == request.order_id),
            None,
        )
        if order is None:
            return None
        average_price = order.average_price or order.requested_odds
        matched = order.matched_stake or order.stake_amount
        gross = matched * (average_price - 1) if request.result_win else -matched
        commission = max(0, gross) * 0.02
        return PaperSettlement(
            order_id=order.id,
            status=OrderStatus.SETTLED,
            result_win=request.result_win,
            requested_odds=order.requested_odds,
            average_price=average_price,
            matched_stake=matched,
            gross_pnl=round(gross, 2),
            commission=round(commission, 2),
            net_pnl=round(gross - commission, 2),
            closing_odds=request.closing_odds,
            clv=round((1 / request.closing_odds) - (1 / average_price), 6),
        )


def test_agent_autopilot_persists_run_and_created_paper_orders() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    repo.store = store

    result = asyncio.run(
        repo.agent_autopilot(
            AgentAutopilotRequest(source="openclaw", create_paper_orders=True, max_paper_orders=2)
        )
    )

    assert result.paper_orders_created >= 1
    assert store.saved_runs == [result.run]
    assert len(store.saved_orders) == result.paper_orders_created
    assert store.saved_orders == result.created_orders
    assert all(order.status == OrderStatus.PAPER for order in store.saved_orders)
    assert asyncio.run(repo.agent_runs())[0] == result.run
    assert ORDERS == {}
    assert AGENT_RUNS == []


def test_agent_autopilot_blocks_paper_orders_when_provider_latency_is_critical() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    store.persisted_data_quality = [
        DataQualitySnapshot(
            id="dq_api_tennis_score",
            provider=Provider.API_TENNIS,
            feed="score/live",
            score_completeness=1,
            odds_completeness=1,
            entity_resolution_rate=1,
            sequence_health=0.5,
            latency_ms=12000,
            stale_ticks=2,
            blocked_signals=3,
            notes=["Latest provider latency rows are stale: api_tennis:score/live."],
        )
    ]
    repo.store = store
    repo.operational_state.store = store

    result = asyncio.run(
        repo.agent_autopilot(
            AgentAutopilotRequest(source="openclaw", create_paper_orders=True, max_paper_orders=2)
        )
    )

    assert result.paper_orders_created == 0
    assert result.paper_orders_skipped >= 1
    assert store.saved_orders == []
    assert store.saved_runs == [result.run]
    assert any(
        action.type == "paper_autopilot" and action.status == AgentActionStatus.BLOCKED
        for action in result.run.actions
    )
    assert any(anomaly.category == "provider_latency" for anomaly in result.anomalies)


def test_agent_runs_prefers_persisted_runs_after_restart() -> None:
    AGENT_RUNS.clear()
    run = AgentRun(
        id="agent_persisted",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Persisted OpenClaw run.",
    )
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    store.persisted_runs = [run]
    repo.store = store

    assert asyncio.run(repo.agent_runs()) == [run]


def test_agent_briefing_prefers_persisted_latest_run_over_process_memory() -> None:
    AGENT_RUNS.clear()
    stale_run = AgentRun(
        id="agent_stale_memory",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Stale process run.",
        created_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    persisted_run = AgentRun(
        id="agent_persisted_latest",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Persisted latest run.",
        created_at=datetime.now(timezone.utc),
    )
    AGENT_RUNS.append(stale_run)
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    store.persisted_runs = [persisted_run]
    repo.store = store

    briefing = asyncio.run(repo.agent_briefing())

    assert briefing.latest_run is not None
    assert briefing.latest_run.id == "agent_persisted_latest"


def test_live_agent_runs_do_not_use_process_memory_when_persisted_missing() -> None:
    AGENT_RUNS.clear()
    memory_run = AgentRun(
        id="agent_live_memory_only",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Memory-only run must not become live audit truth.",
    )
    AGENT_RUNS.append(memory_run)
    repo = AnalysisRepository(Settings(data_mode="live", database_url=None))
    store = AgentStoreStub(repo.store)
    store.persisted_runs = []
    repo.store = store

    assert asyncio.run(repo.agent_runs()) == []


def test_sample_agent_runs_do_not_use_process_memory_when_repository_cache_empty() -> None:
    AGENT_RUNS.clear()
    memory_run = AgentRun(
        id="agent_sample_memory_only",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Memory-only run must not become sample repository truth.",
    )
    AGENT_RUNS.append(memory_run)
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    store.persisted_runs = []
    repo.store = store

    assert asyncio.run(repo.agent_runs()) == []


def test_live_agent_briefing_does_not_use_memory_latest_run_when_persisted_missing() -> None:
    AGENT_RUNS.clear()
    memory_run = AgentRun(
        id="agent_live_memory_latest",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="Memory latest run must not appear in live briefing.",
    )
    AGENT_RUNS.append(memory_run)
    repo = AnalysisRepository(Settings(data_mode="live", database_url=None))
    store = AgentStoreStub(repo.store)
    store.persisted_runs = []
    repo.store = store

    briefing = asyncio.run(repo.agent_briefing())

    assert briefing.latest_run is None


def test_agent_ops_uses_persisted_orders_after_restart() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample", bankroll_starting_balance=10000))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    signal = max(
        (
            signal
            for analysis in analyses
            for signal in analysis.signals
            if signal.status == SignalStatus.ENTRY
        ),
        key=lambda signal: signal.edge,
    )
    persisted_order = ExecutionOrder(
        id="ord_persisted",
        signal_id=signal.id,
        match_id=signal.match_id,
        player_id=signal.player_id,
        player_name=signal.player_name,
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=signal.best_odds,
        accepted_odds=signal.best_odds,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=72,
        average_price=signal.best_odds,
    )
    store = AgentStoreStub(repo.store)
    store.persisted_orders = [persisted_order]
    repo.store = store

    bankroll = asyncio.run(repo.bankroll())
    briefing = asyncio.run(repo.agent_briefing())
    result = asyncio.run(
        repo.agent_autopilot(
            AgentAutopilotRequest(source="openclaw", create_paper_orders=True, max_paper_orders=1)
        )
    )

    assert bankroll.open_exposure == 100
    assert briefing.open_orders >= 1
    assert briefing.paper_orders >= 1
    assert result.paper_orders_created == 0
    assert result.paper_orders_skipped == 1
    assert store.saved_orders == []


def test_orders_prefers_persisted_order_status_over_process_memory() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample", bankroll_starting_balance=10000))
    persisted_order = ExecutionOrder(
        id="ord_conflict",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.SETTLED,
        requested_odds=1.85,
        accepted_odds=1.85,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=1.85,
        pnl=82,
        clv=0.014,
    )
    ORDERS[persisted_order.id] = persisted_order.model_copy(
        update={
            "status": OrderStatus.PAPER,
            "matched_stake": 40,
            "pnl": None,
            "clv": None,
        }
    )
    store = AgentStoreStub(repo.store)
    store.persisted_orders = [persisted_order]
    repo.store = store

    orders = asyncio.run(repo.orders())
    bankroll = asyncio.run(repo.bankroll(orders))

    assert orders[0].status == OrderStatus.SETTLED
    assert orders[0].pnl == 82
    assert bankroll.open_exposure == 0


def test_live_orders_do_not_use_process_memory_when_persisted_order_missing() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="live", database_url=None, bankroll_starting_balance=10000))
    memory_order = ExecutionOrder(
        id="ord_live_memory_only",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=72,
        average_price=2.0,
    )
    ORDERS[memory_order.id] = memory_order
    store = AgentStoreStub(repo.store)
    store.persisted_orders = []
    repo.store = store

    orders = asyncio.run(repo.orders())
    bankroll = asyncio.run(repo.bankroll())

    assert orders == []
    assert bankroll.open_exposure == 0


def test_sample_orders_do_not_use_process_memory_when_repository_cache_empty() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample", bankroll_starting_balance=10000))
    memory_order = ExecutionOrder(
        id="ord_sample_memory_only",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=72,
        average_price=2.0,
    )
    ORDERS[memory_order.id] = memory_order
    store = AgentStoreStub(repo.store)
    store.persisted_orders = []
    repo.store = store

    orders = asyncio.run(repo.orders())
    bankroll = asyncio.run(repo.bankroll())

    assert orders == []
    assert bankroll.open_exposure == 0


def test_sample_paper_order_round_trips_through_repository_cache() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = AgentStoreStub(repo.store)
    repo.store = store
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    entry = next(
        signal
        for analysis in analyses
        for signal in analysis.signals
        if signal.status == SignalStatus.ENTRY
    )

    order = asyncio.run(repo.create_paper_order(OrderRequest(signal_id=entry.id)))
    orders = asyncio.run(repo.orders())
    settlement = asyncio.run(
        repo.settle_paper(
            PaperSettleRequest(
                order_id=order.id,
                result_win=True,
                closing_odds=order.requested_odds - 0.02,
            )
        )
    )
    settled_orders = asyncio.run(repo.orders())

    assert store.saved_orders == [order]
    assert orders == [order]
    assert ORDERS == {}
    assert settlement.status == OrderStatus.SETTLED
    assert settled_orders[0].status == OrderStatus.SETTLED
    assert settled_orders[0].pnl == settlement.net_pnl


def test_settlement_prefers_persisted_order_over_stale_process_memory() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    persisted_order = ExecutionOrder(
        id="ord_settle_conflict",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    ORDERS[persisted_order.id] = persisted_order.model_copy(
        update={
            "requested_odds": 1.5,
            "accepted_odds": 1.5,
            "stake_amount": 50,
            "matched_stake": 50,
            "average_price": 1.5,
        }
    )
    store = AgentStoreStub(repo.store)
    store.persisted_orders = [persisted_order]
    repo.store = store

    settlement = asyncio.run(
        repo.settle_paper(
            PaperSettleRequest(
                order_id=persisted_order.id,
                result_win=True,
                closing_odds=1.9,
            )
        )
    )

    assert store.settle_requests
    assert settlement.average_price == 2.0
    assert settlement.matched_stake == 100
    assert settlement.net_pnl == 98


def test_live_settlement_does_not_use_process_memory_when_persisted_order_missing() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="live", database_url=None))
    memory_order = ExecutionOrder(
        id="ord_live_memory_only",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    ORDERS[memory_order.id] = memory_order
    store = AgentStoreStub(repo.store)
    store.persisted_orders = []
    repo.store = store

    with pytest.raises(KeyError):
        asyncio.run(
            repo.settle_paper(
                PaperSettleRequest(
                    order_id=memory_order.id,
                    result_win=True,
                    closing_odds=1.9,
                )
            )
        )

    assert store.settle_requests
    assert ORDERS[memory_order.id].status == OrderStatus.PAPER


def test_cancel_prefers_persisted_non_cancelable_order_over_stale_process_memory() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    persisted_order = ExecutionOrder(
        id="ord_cancel_conflict",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.SETTLED,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
        pnl=98,
        clv=0.02,
    )
    ORDERS[persisted_order.id] = persisted_order.model_copy(
        update={
            "status": OrderStatus.PAPER,
            "pnl": None,
            "clv": None,
        }
    )
    store = AgentStoreStub(repo.store)
    store.persisted_orders = [persisted_order]
    repo.store = store

    result = asyncio.run(repo.cancel_order(persisted_order.id))

    assert result.status == OrderStatus.SETTLED
    assert "not open" in result.reason
    assert ORDERS[persisted_order.id].status == OrderStatus.PAPER
    assert store.cancel_requests == []


def test_sample_cancel_does_not_use_process_memory_when_repository_cache_empty() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    memory_order = ExecutionOrder(
        id="ord_sample_cancel_memory_only",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    ORDERS[memory_order.id] = memory_order
    store = AgentStoreStub(repo.store)
    store.persisted_orders = []
    repo.store = store

    with pytest.raises(KeyError):
        asyncio.run(repo.cancel_order(memory_order.id))

    assert store.cancel_requests == []
    assert ORDERS[memory_order.id].status == OrderStatus.PAPER


def test_cancel_does_not_use_stale_memory_when_persisted_cancel_fails() -> None:
    ORDERS.clear()
    AGENT_RUNS.clear()
    repo = AnalysisRepository(Settings(data_mode="sample"))
    persisted_order = ExecutionOrder(
        id="ord_cancel_open_conflict",
        signal_id="sig_conflict",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    ORDERS[persisted_order.id] = persisted_order.model_copy(
        update={
            "status": OrderStatus.SETTLED,
            "pnl": 98,
            "clv": 0.02,
        }
    )
    store = AgentStoreStub(repo.store)
    store.persisted_orders = [persisted_order]
    store.cancel_results[persisted_order.id] = None
    repo.store = store

    result = asyncio.run(repo.cancel_order(persisted_order.id))

    assert store.cancel_requests == [persisted_order.id]
    assert result.status == OrderStatus.PAPER
    assert "could not be cancelled" in result.reason
    assert ORDERS[persisted_order.id].status == OrderStatus.SETTLED

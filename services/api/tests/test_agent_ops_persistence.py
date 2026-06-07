import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    AgentAutopilotRequest,
    AgentRun,
    AgentRunType,
    ExecutionOrder,
    ExecutionVenue,
    OrderStatus,
    SignalStatus,
)
from tennis_edge.services.agent_ops import AGENT_RUNS
from tennis_edge.services.execution_engine import ORDERS
from tennis_edge.services.repository import AnalysisRepository


class AgentStoreStub:
    def __init__(self, fallback) -> None:
        self.fallback = fallback
        self.saved_runs: list[AgentRun] = []
        self.saved_orders: list[ExecutionOrder] = []
        self.persisted_runs: list[AgentRun] = []
        self.persisted_orders: list[ExecutionOrder] = []

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
    assert all(order.status == OrderStatus.PAPER for order in store.saved_orders)


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

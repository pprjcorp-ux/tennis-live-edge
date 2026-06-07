import asyncio
from tennis_edge.config import Settings
from tennis_edge.domain import AgentAutopilotRequest, AgentRun, AgentRunType, ExecutionOrder, OrderStatus
from tennis_edge.services.agent_ops import AGENT_RUNS
from tennis_edge.services.execution_engine import ORDERS
from tennis_edge.services.repository import AnalysisRepository


class AgentStoreStub:
    def __init__(self, fallback) -> None:
        self.fallback = fallback
        self.saved_runs: list[AgentRun] = []
        self.saved_orders: list[ExecutionOrder] = []
        self.persisted_runs: list[AgentRun] = []

    def __getattr__(self, name):
        return getattr(self.fallback, name)

    def save_agent_run(self, run: AgentRun) -> None:
        self.saved_runs.append(run)

    def agent_runs(self) -> list[AgentRun]:
        return list(self.persisted_runs)

    def save_order(self, order: ExecutionOrder) -> None:
        self.saved_orders.append(order)


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

import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.services.repository import AnalysisRepository


def test_live_dashboard_read_model_builds_dashboard_snapshot_from_inputs() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample", persistence_enabled=False))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    paper = asyncio.run(repo.paper_performance())

    snapshot = repo.dashboard_read_model.snapshot(date.today(), analyses, paper)

    assert snapshot.matches == analyses
    assert snapshot.metrics.matches == len(analyses)
    assert snapshot.signals == sorted(
        [signal for analysis in analyses for signal in analysis.signals],
        key=lambda signal: signal.edge,
        reverse=True,
    )
    assert snapshot.operational_state.cost_profile.active_plan == "lean_atp"
    assert snapshot.readiness.can_submit_real_orders is False

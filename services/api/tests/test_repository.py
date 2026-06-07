import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import PaperPerformance
from tennis_edge.services.repository import AnalysisRepository


def test_repository_returns_match_analyses() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample"))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    assert analyses
    assert all(analysis.prediction.match_id == analysis.match.id for analysis in analyses)
    assert all(analysis.signals for analysis in analyses)


def test_daily_metrics_are_available() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample"))
    metrics = asyncio.run(repo.daily_metrics(date.today()))

    assert metrics.matches > 0
    assert metrics.average_model_confidence >= 0


def test_daily_metrics_include_persisted_paper_performance() -> None:
    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def paper_performance(self):
            return PaperPerformance(
                orders=4,
                settled_orders=3,
                wins=2,
                losses=1,
                open_orders=1,
                roi=0.0833,
                clv=0.0125,
                realized_pnl=25,
                max_drawdown=0.02,
                calibration_error=0.031,
                readiness_status="collecting",
                readiness_reasons=["collecting"],
                segments=[],
            )

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub(repo.store)

    metrics = asyncio.run(repo.daily_metrics(date.today()))

    assert metrics.paper_roi == 0.0833
    assert metrics.clv == 0.0125
    assert metrics.brier_score == 0.031
    assert "Paper metrics loaded" in metrics.note

import asyncio
from datetime import date

from tennis_edge.config import Settings
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

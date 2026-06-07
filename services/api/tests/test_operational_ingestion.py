import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.ingest_live_budget import run_live_budget_cycle
from tennis_edge.ingest_odds_stream import run_odds_stream_ingestion
from tennis_edge.services.repository import AnalysisRepository


def test_odds_stream_runner_skips_without_key() -> None:
    repo = AnalysisRepository(Settings(data_mode="live", odds_api_io_key=None))

    result = asyncio.run(
        run_odds_stream_ingestion(
            repo,
            max_messages=1,
            timeout_seconds=0.01,
        )
    )

    assert result["connected"] is False
    assert result["messages"] == 0
    assert result["reason"] == "ODDS_API_IO_KEY is missing or data mode is sample; websocket not opened."


def test_live_budget_cycle_reports_score_odds_and_execution_safety() -> None:
    repo = AnalysisRepository(
        Settings(
            data_mode="live",
            api_tennis_key=None,
            odds_api_io_key=None,
            persistence_enabled=False,
        )
    )

    result = asyncio.run(
        run_live_budget_cycle(
            repo,
            target_date=date(2026, 6, 7),
            odds_max_messages=1,
            odds_timeout_seconds=0.01,
        )
    )

    assert result["profile"] == "lean_atp"
    assert result["target_date"] == "2026-06-07"
    assert result["score_ingestion"]["source"] == "empty"
    assert result["odds_ingestion"]["connected"] is False
    assert result["can_submit_real_orders"] is False
    assert result["real_execution_hard_block"] is True

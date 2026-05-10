import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import SignalStatus
from tennis_edge.services.cost_profile import cost_profile, coverage_decision
from tennis_edge.services.repository import AnalysisRepository


def test_lean_atp_profile_stays_under_budget_and_defers_enterprise_feeds() -> None:
    settings = Settings(
        data_mode="sample",
        runtime_profile="lean_atp",
        enterprise_feeds_enabled=False,
        coverage="atp_main,grand_slam_men",
    )
    profile = cost_profile(settings)

    assert profile.active_plan == "lean_atp"
    assert profile.estimated_monthly_spend_usd <= 500
    assert profile.enterprise_feeds_enabled is False
    assert "atp_main" in profile.coverage_scope
    assert "grand_slam_men" in profile.coverage_scope
    assert "txodds" in profile.disabled_providers


def test_coverage_gate_allows_atp_and_blocks_wta_itf_entries() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")
    repo = AnalysisRepository(settings)
    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    atp = [analysis for analysis in analyses if analysis.match.tour == "ATP" and analysis.match.competition_level == "ATP"]
    non_covered = [analysis for analysis in analyses if not coverage_decision(analysis.match, settings).eligible]

    assert atp
    assert non_covered
    assert all(
        signal.status != SignalStatus.ENTRY
        for analysis in non_covered
        for signal in analysis.signals
    )


def test_daily_cost_report_counts_skipped_matches_and_signal_cost() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")
    repo = AnalysisRepository(settings)
    report = asyncio.run(repo.daily_cost_report(date.today()))

    assert report.estimated_monthly_spend_usd <= 500
    assert report.matches_analyzed >= report.matches_skipped_by_coverage
    assert report.matches_skipped_by_coverage >= 1
    assert {usage.provider for usage in report.api_calls_by_provider} >= {
        "api_tennis",
        "odds_api_io",
        "theoddsapi",
    }

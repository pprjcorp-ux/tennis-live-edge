import asyncio
from datetime import date, datetime, timezone

import pytest
from tennis_edge.config import Settings
from tennis_edge.domain import CompetitionLevel, Match, MatchState, SignalStatus, Surface, Tour
from tennis_edge.sample_data import PLAYERS
from tennis_edge.services.cost_profile import cost_profile, coverage_decision
from tennis_edge.services.repository import AnalysisRepository


def _grand_slam_match(tournament: str, tour: Tour) -> Match:
    player1 = PLAYERS["atp_sinner"] if tour == Tour.ATP else PLAYERS["wta_gauff"]
    player2 = PLAYERS["atp_zverev"] if tour == Tour.ATP else PLAYERS["wta_keys"]
    return Match(
        id=f"test-{tour.value.lower()}-{tournament.lower().replace(' ', '-')}",
        provider_ids={},
        provider_match_id="test",
        tournament=tournament,
        round="R64",
        tour=tour,
        competition_level=CompetitionLevel.ATP if tour == Tour.ATP else CompetitionLevel.WTA,
        surface=Surface.HARD,
        best_of=5 if tour == Tour.ATP else 3,
        scheduled_at=datetime.now(timezone.utc),
        player1=player1,
        player2=player2,
        state=MatchState(status="prematch"),
        odds=[],
    )


def test_lean_atp_profile_stays_under_budget_and_defers_enterprise_feeds() -> None:
    settings = Settings(
        data_mode="sample",
        runtime_profile="lean_atp",
        enterprise_feeds_enabled=False,
        coverage="atp_main,grand_slam_men,grand_slam_women",
    )
    profile = cost_profile(settings)

    assert profile.active_plan == "lean_atp"
    assert profile.estimated_monthly_spend_usd <= 500
    assert profile.enterprise_feeds_enabled is False
    assert "atp_main" in profile.coverage_scope
    assert "grand_slam_men" in profile.coverage_scope
    assert "grand_slam_women" in profile.coverage_scope
    assert "txodds" in profile.disabled_providers


@pytest.mark.parametrize(
    "tournament",
    ["Australian Open", "Roland Garros", "French Open", "Wimbledon", "US Open"],
)
def test_coverage_gate_recognizes_all_grand_slam_names_for_atp_and_wta(tournament: str) -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")

    assert coverage_decision(_grand_slam_match(tournament, Tour.ATP), settings).eligible
    assert coverage_decision(_grand_slam_match(tournament, Tour.WTA), settings).eligible


def test_coverage_gate_allows_atp_and_grand_slam_wta_but_blocks_wta_tour_and_itf_entries() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")
    repo = AnalysisRepository(settings)
    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    atp = [analysis for analysis in analyses if analysis.match.tour == "ATP" and analysis.match.competition_level == "ATP"]
    wta_grand_slam = [analysis for analysis in analyses if analysis.match.id == "match_gs_wta_001"]
    wta_tour = [analysis for analysis in analyses if analysis.match.id in {"match_wta_001", "match_wta_002"}]
    itf = [analysis for analysis in analyses if analysis.match.competition_level == "ITF"]
    non_covered = [analysis for analysis in analyses if not coverage_decision(analysis.match, settings).eligible]

    assert atp
    assert wta_grand_slam
    assert wta_tour
    assert itf
    assert all(coverage_decision(analysis.match, settings).eligible for analysis in wta_grand_slam)
    assert all(not coverage_decision(analysis.match, settings).eligible for analysis in wta_tour)
    assert all(not coverage_decision(analysis.match, settings).eligible for analysis in itf)
    assert any(
        signal.status == SignalStatus.ENTRY
        for analysis in wta_grand_slam
        for signal in analysis.signals
    )
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


def test_lean_atp_without_explicit_coverage_uses_valid_atp_defaults() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")

    assert settings.coverage_set >= {"atp_main", "grand_slam_men", "grand_slam_women"}
    assert coverage_decision(_grand_slam_match("US Open", Tour.ATP), settings).eligible


def test_lean_atp_default_coverage_keeps_atp_matches_actionable() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")
    repo = AnalysisRepository(settings)
    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    atp_main = [
        analysis
        for analysis in analyses
        if analysis.match.tour == Tour.ATP
        and analysis.match.competition_level == CompetitionLevel.ATP
        and not analysis.match.tournament.lower().endswith("open")
    ]

    assert atp_main
    assert all(coverage_decision(analysis.match, settings).eligible for analysis in atp_main)
    assert all(
        "Outside lean Grand Slam/ATP coverage" not in signal.reason
        for analysis in atp_main
        for signal in analysis.signals
    )


def test_enterprise_daily_cost_report_uses_api_tennis_when_score_routing_is_api_tennis() -> None:
    settings = Settings(
        data_mode="sample",
        runtime_profile="enterprise_roi_clv",
        enterprise_feeds_enabled=True,
        score_primary="api_tennis",
        monthly_budget_usd=6000,
    )
    repo = AnalysisRepository(settings)

    report = asyncio.run(repo.daily_cost_report(date.today()))
    providers = {usage.provider for usage in report.api_calls_by_provider}

    assert "api_tennis" in providers
    assert "sportradar" not in providers


def test_enterprise_daily_cost_report_uses_sportradar_when_score_routing_is_sportradar() -> None:
    settings = Settings(
        data_mode="sample",
        runtime_profile="enterprise_roi_clv",
        enterprise_feeds_enabled=True,
        score_primary="sportradar",
        monthly_budget_usd=6000,
    )
    repo = AnalysisRepository(settings)

    report = asyncio.run(repo.daily_cost_report(date.today()))
    providers = {usage.provider for usage in report.api_calls_by_provider}

    assert "sportradar" in providers
    assert "api_tennis" not in providers

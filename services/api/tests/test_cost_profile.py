import asyncio
from datetime import date, datetime, timezone

import pytest
from tennis_edge.config import Settings
from tennis_edge.domain import CompetitionLevel, Match, MatchState, Provider, SignalStatus, Surface, Tour
from tennis_edge.sample_data import PLAYERS
from tennis_edge.services.cost_profile import (
    cost_profile,
    coverage_decision,
    daily_cost_report,
    provider_health_for,
)
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


def test_live_provider_health_reports_missing_budget_keys() -> None:
    health = provider_health_for(Settings(data_mode="live"))

    by_provider = {item.provider: item for item in health}

    assert by_provider["api_tennis"].healthy is False
    assert by_provider["api_tennis"].configured is False
    assert by_provider["api_tennis"].status == "score primary key missing"
    assert by_provider["odds_api_io"].healthy is False
    assert by_provider["odds_api_io"].status == "odds websocket key missing"


def test_replay_provider_health_reports_fake_feeds_without_configured_keys() -> None:
    health = provider_health_for(Settings(data_mode="replay"))

    by_provider = {item.provider: item for item in health}

    assert by_provider[Provider.API_TENNIS].configured is False
    assert by_provider[Provider.API_TENNIS].healthy is True
    assert by_provider[Provider.API_TENNIS].quota_used == 0
    assert by_provider[Provider.API_TENNIS].status == "score primary replay fixture feed"
    assert by_provider[Provider.ODDS_API_IO].healthy is True
    assert by_provider[Provider.ODDS_API_IO].status == "odds websocket replay fixture feed"
    assert by_provider[Provider.THE_ODDS_API].healthy is True
    assert by_provider[Provider.THE_ODDS_API].status == "historical archive replay snapshot"


@pytest.mark.parametrize(
    "tournament",
    ["Australian Open", "Roland Garros", "French Open", "Wimbledon", "US Open"],
)
def test_coverage_gate_recognizes_all_grand_slam_names_for_atp_and_wta(tournament: str) -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp")

    assert coverage_decision(_grand_slam_match(tournament, Tour.ATP), settings).eligible
    assert coverage_decision(_grand_slam_match(tournament, Tour.WTA), settings).eligible


def test_lean_atp_empty_coverage_uses_default_tour_scope() -> None:
    settings = Settings(data_mode="sample", runtime_profile="lean_atp", coverage="")

    assert settings.coverage_set == {"atp_main", "grand_slam_men", "grand_slam_women"}
    assert coverage_decision(_grand_slam_match("Wimbledon", Tour.ATP), settings).eligible
    assert coverage_decision(_grand_slam_match("Wimbledon", Tour.WTA), settings).eligible


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


def test_enterprise_cost_report_only_adds_enterprise_usage_when_feeds_are_enabled() -> None:
    disabled_settings = Settings(
        data_mode="sample",
        runtime_profile="enterprise_roi_clv",
        enterprise_feeds_enabled=False,
    )
    enabled_settings = Settings(
        data_mode="sample",
        runtime_profile="enterprise_roi_clv",
        enterprise_feeds_enabled=True,
    )

    disabled_report = asyncio.run(
        AnalysisRepository(disabled_settings).daily_cost_report(date.today())
    )
    enabled_report = asyncio.run(
        AnalysisRepository(enabled_settings).daily_cost_report(date.today())
    )

    assert "sportradar" not in {
        usage.provider for usage in disabled_report.api_calls_by_provider
    }
    assert "sportradar" in {usage.provider for usage in enabled_report.api_calls_by_provider}


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


def test_daily_cost_report_prefers_persisted_provider_usage_counts() -> None:
    report = daily_cost_report(
        Settings(data_mode="live", runtime_profile="lean_atp"),
        analyses=[],
        provider_usage_counts={
            Provider.API_TENNIS: 12,
            Provider.ODDS_API_IO: 8,
            Provider.THE_ODDS_API: 3,
        },
    )
    usage = {item.provider: item for item in report.api_calls_by_provider}

    assert usage["api_tennis"].api_calls == 12
    assert usage["api_tennis"].quota_used == 12
    assert usage["odds_api_io"].api_calls == 8
    assert usage["theoddsapi"].api_calls == 3


def test_daily_cost_report_prefers_persisted_websocket_usage() -> None:
    report = daily_cost_report(
        Settings(data_mode="live", runtime_profile="lean_atp"),
        analyses=[],
        provider_websocket_minutes={Provider.ODDS_API_IO: 17},
        websocket_uptime_pct=0.5,
    )
    usage = {item.provider: item for item in report.api_calls_by_provider}

    assert report.websocket_uptime_pct == 0.5
    assert usage[Provider.ODDS_API_IO].websocket_minutes == 17

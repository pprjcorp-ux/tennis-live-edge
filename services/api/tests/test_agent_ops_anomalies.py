from tennis_edge.config import Settings
from tennis_edge.domain import (
    BankrollSnapshot,
    DailyCostReport,
    DataQualitySnapshot,
    ExecutionStage,
    ExecutionStatus,
    ExecutionVenue,
    PaperPerformance,
    Provider,
)
from tennis_edge.services.agent_ops import detect_anomalies


def _execution_status() -> ExecutionStatus:
    return ExecutionStatus(
        execution_enabled=False,
        venue=ExecutionVenue.BETFAIR,
        stage=ExecutionStage.PAPER,
        betfair_configured=False,
        betfair_live_key_approved=False,
        real_execution_hard_block=True,
        kill_switch_enabled=False,
        can_submit_real_orders=False,
        reasons=["paper-first"],
    )


def _paper_performance() -> PaperPerformance:
    return PaperPerformance(
        orders=0,
        settled_orders=0,
        wins=0,
        losses=0,
        open_orders=0,
        roi=None,
        clv=None,
        realized_pnl=0,
        max_drawdown=0,
        calibration_error=None,
        readiness_status="collecting",
        readiness_reasons=["collecting paper sample"],
    )


def _bankroll() -> BankrollSnapshot:
    return BankrollSnapshot(
        base_currency="USD",
        bankroll_amount=1000,
        available_amount=1000,
        open_exposure=0,
        execution_stage=ExecutionStage.PAPER,
        max_order_stake_fraction=0.001,
        daily_loss_limit_fraction=0.005,
        weekly_drawdown_limit_fraction=0.015,
    )


def _cost_report() -> DailyCostReport:
    return DailyCostReport(
        active_plan="lean_atp",
        estimated_monthly_spend_usd=500,
        estimated_daily_spend_usd=16.67,
        api_calls_by_provider=[],
        websocket_uptime_pct=0,
        matches_analyzed=0,
        matches_skipped_by_coverage=0,
        signals_generated=0,
        note="test report",
    )


def test_detect_anomalies_flags_stale_provider_ticks_as_latency_issue() -> None:
    anomalies = detect_anomalies(
        Settings(data_mode="live"),
        analyses=[],
        provider_health=[],
        provider_cursors=[],
        data_quality=[
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
        ],
        execution_status=_execution_status(),
        paper_performance=_paper_performance(),
        bankroll=_bankroll(),
        cost_report=_cost_report(),
    )

    latency_anomaly = next(
        anomaly for anomaly in anomalies if anomaly.category == "provider_latency"
    )

    assert latency_anomaly.severity == "critical"
    assert "stale provider ticks" in latency_anomaly.summary
    assert "stale_ticks=2" in latency_anomaly.detail
    assert "latency_ms=12000" in latency_anomaly.detail
    assert latency_anomaly.blocked_signals == 3
    assert any(anomaly.category == "data_quality" for anomaly in anomalies)

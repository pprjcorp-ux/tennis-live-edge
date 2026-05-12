from tennis_edge.domain import BacktestRunRequest
from tennis_edge.services.backtest import run_walk_forward_backtest


def test_backtest_strategy_lab_reports_requested_strategy_and_bankroll_metrics() -> None:
    metrics = run_walk_forward_backtest(
        BacktestRunRequest(
            strategy_id="clv_hunter",
            stake_policy="half_kelly",
            market="ML",
            bankroll_starting_balance=25000,
        )
    )

    assert metrics.strategy_id == "clv_hunter"
    assert metrics.stake_policy == "half_kelly"
    assert metrics.bankroll_starting_balance == 25000
    assert metrics.settled_signals == metrics.signals
    assert metrics.turnover >= 0
    assert metrics.strategy_breakdown[0]["strategy_id"] == "clv_hunter"
    assert metrics.clv > 0


def test_backtest_unknown_strategy_falls_back_to_safe_value_edge() -> None:
    metrics = run_walk_forward_backtest(BacktestRunRequest(strategy_id="unknown", stake_policy="unknown"))

    assert metrics.strategy_id == "value_edge"
    assert metrics.stake_policy == "fractional_kelly"
    assert metrics.matches >= 1

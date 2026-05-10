from uuid import uuid4

from tennis_edge.domain import BacktestMetrics


PROMOTION_GATES = {
    "min_roi": 0.015,
    "min_clv": 0.005,
    "max_brier": 0.24,
    "max_calibration_error": 0.045,
    "max_drawdown": 0.18,
}


def sample_backtest(model_version: str = "ensemble_enterprise_v0") -> BacktestMetrics:
    return BacktestMetrics(
        run_id=f"bt_{uuid4().hex[:12]}",
        model_version=model_version,
        matches=420,
        signals=64,
        roi=0.032,
        clv=0.011,
        brier_score=0.213,
        log_loss=0.604,
        calibration_error=0.031,
        max_drawdown=0.11,
    )


def evaluate_promotion(metrics: BacktestMetrics) -> BacktestMetrics:
    failures: list[str] = []
    if metrics.roi < PROMOTION_GATES["min_roi"]:
        failures.append("ROI below promotion gate")
    if metrics.clv < PROMOTION_GATES["min_clv"]:
        failures.append("CLV below promotion gate")
    if metrics.brier_score > PROMOTION_GATES["max_brier"]:
        failures.append("Brier score above promotion gate")
    if metrics.calibration_error > PROMOTION_GATES["max_calibration_error"]:
        failures.append("Calibration error above promotion gate")
    if metrics.max_drawdown > PROMOTION_GATES["max_drawdown"]:
        failures.append("Drawdown above risk gate")

    metrics.promoted = not failures
    metrics.rejection_reason = "; ".join(failures) if failures else None
    return metrics

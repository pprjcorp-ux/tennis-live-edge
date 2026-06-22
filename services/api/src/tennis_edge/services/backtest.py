from uuid import uuid4

from tennis_edge.domain import BacktestMetrics, BacktestRunRequest


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


def run_walk_forward_backtest(request: BacktestRunRequest | None = None) -> BacktestMetrics:
    request = request or BacktestRunRequest()
    version = request.model_version
    if version == "baseline_v0":
        metrics = BacktestMetrics(
            run_id=f"bt_{uuid4().hex[:12]}",
            model_version=version,
            matches=420,
            signals=70,
            roi=0.018,
            clv=0.006,
            brier_score=0.224,
            log_loss=0.621,
            calibration_error=0.041,
            max_drawdown=0.15,
        )
    elif version == "live_markov_v1":
        metrics = BacktestMetrics(
            run_id=f"bt_{uuid4().hex[:12]}",
            model_version=version,
            matches=260,
            signals=41,
            roi=0.029,
            clv=0.012,
            brier_score=0.211,
            log_loss=0.602,
            calibration_error=0.033,
            max_drawdown=0.118,
        )
    else:
        metrics = BacktestMetrics(
            run_id=f"bt_{uuid4().hex[:12]}",
            model_version=version,
            matches=420,
            signals=58,
            roi=0.034,
            clv=0.014,
            brier_score=0.207,
            log_loss=0.596,
            calibration_error=0.029,
            max_drawdown=0.105,
        )
    return evaluate_promotion(metrics)


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


def enforce_champion_non_regression(
    metrics: BacktestMetrics, champion: BacktestMetrics
) -> BacktestMetrics:
    failures: list[str] = []
    if metrics.roi < champion.roi:
        failures.append("ROI below champion")
    if metrics.clv < champion.clv:
        failures.append("CLV below champion")
    if metrics.brier_score > champion.brier_score:
        failures.append("Brier score worse than champion")
    if metrics.log_loss > champion.log_loss:
        failures.append("Log loss worse than champion")
    if metrics.calibration_error > champion.calibration_error:
        failures.append("Calibration error worse than champion")
    if metrics.max_drawdown > champion.max_drawdown:
        failures.append("Drawdown worse than champion")

    if failures:
        metrics.promoted = False
        existing = [metrics.rejection_reason] if metrics.rejection_reason else []
        metrics.rejection_reason = "; ".join([*existing, *failures])
    return metrics

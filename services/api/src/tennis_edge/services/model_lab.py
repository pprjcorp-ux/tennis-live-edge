from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from math import log
from statistics import mean
from uuid import uuid4

from tennis_edge.domain import (
    BacktestMetrics,
    BacktestRunRequest,
    CalibrationBucket,
    CalibrationReport,
    TrainingExample,
)
from tennis_edge.services.backtest import evaluate_promotion


MIN_PROBABILITY = 1e-6
MAX_PROBABILITY = 1 - MIN_PROBABILITY
SMALL_SAMPLE_CALIBRATION_PRIOR = 20


def walk_forward_from_training_examples(
    request: BacktestRunRequest | None,
    examples: Iterable[TrainingExample],
) -> BacktestMetrics:
    request = request or BacktestRunRequest()
    settled = _settled_examples(request, examples)
    if not settled:
        metrics = BacktestMetrics(
            run_id=f"bt_live_{uuid4().hex[:12]}",
            model_version=request.model_version,
            matches=0,
            signals=0,
            roi=0,
            clv=0,
            brier_score=0.25,
            log_loss=0.693147,
            calibration_error=1,
            max_drawdown=1,
        )
        return evaluate_promotion(metrics)

    outcomes = [1.0 if example.result_win else 0.0 for example in settled]
    probabilities = [_clip_probability(example.model_probability) for example in settled]
    pnl = [float(example.pnl or 0) for example in settled]
    stake = [float(example.stake_amount or 1) for example in settled]
    clv = [float(example.clv or 0) for example in settled]

    metrics = BacktestMetrics(
        run_id=f"bt_live_{uuid4().hex[:12]}",
        model_version=request.model_version,
        matches=len({example.match_id for example in settled}),
        signals=len(settled),
        roi=round(sum(pnl) / max(1.0, sum(stake)), 6),
        clv=round(mean(clv), 6),
        brier_score=round(
            mean((probability - outcome) ** 2 for probability, outcome in zip(probabilities, outcomes, strict=True)),
            6,
        ),
        log_loss=round(
            mean(
                -(
                    outcome * log(probability)
                    + (1 - outcome) * log(1 - probability)
                )
                for probability, outcome in zip(probabilities, outcomes, strict=True)
            ),
            6,
        ),
        calibration_error=round(
            _calibration_error(
                settled,
                prior_strength=SMALL_SAMPLE_CALIBRATION_PRIOR,
            ),
            6,
        ),
        max_drawdown=round(_max_drawdown(pnl, stake), 6),
    )
    return evaluate_promotion(metrics)


def calibration_from_training_examples(
    run_id: str,
    model_version: str,
    examples: Iterable[TrainingExample],
) -> CalibrationReport:
    settled = sorted(
        [
            example
            for example in examples
            if example.model_version == model_version
            and example.result_win is not None
        ],
        key=lambda example: (example.calibration_bucket, example.decision_ts),
    )
    grouped: dict[str, list[TrainingExample]] = defaultdict(list)
    for example in settled:
        grouped[_bucket_name(example)].append(example)

    buckets = [
        _calibration_bucket(bucket, bucket_examples)
        for bucket, bucket_examples in sorted(grouped.items(), key=lambda item: _bucket_bounds(item[0]))
    ]
    return CalibrationReport(
        run_id=run_id,
        model_version=model_version,
        buckets=buckets,
        brier_score=round(_brier_score(settled), 6) if settled else 0.25,
        log_loss=round(_log_loss(settled), 6) if settled else 0.693147,
        calibration_error=round(_calibration_error(settled), 6) if settled else 1,
    )


def _settled_examples(
    request: BacktestRunRequest,
    examples: Iterable[TrainingExample],
) -> list[TrainingExample]:
    start = _parse_date(request.start_date)
    end = _parse_date(request.end_date)
    filtered: list[TrainingExample] = []
    for example in examples:
        decision_date = example.decision_ts.date()
        if example.model_version != request.model_version:
            continue
        if example.result_win is None or example.pnl is None:
            continue
        if start and decision_date < start:
            continue
        if end and decision_date > end:
            continue
        filtered.append(example)
    return sorted(filtered, key=lambda example: example.decision_ts)


def _calibration_bucket(
    bucket: str,
    examples: list[TrainingExample],
) -> CalibrationBucket:
    lower, upper = _bucket_bounds(bucket)
    outcomes = [1.0 if example.result_win else 0.0 for example in examples]
    probabilities = [_clip_probability(example.model_probability) for example in examples]
    return CalibrationBucket(
        bucket=bucket,
        lower_bound=lower,
        upper_bound=upper,
        predictions=len(examples),
        average_prediction=round(mean(probabilities), 6),
        observed_win_rate=round(mean(outcomes), 6),
        brier_score=round(
            mean((probability - outcome) ** 2 for probability, outcome in zip(probabilities, outcomes, strict=True)),
            6,
        ),
        log_loss=round(
            mean(
                -(
                    outcome * log(probability)
                    + (1 - outcome) * log(1 - probability)
                )
                for probability, outcome in zip(probabilities, outcomes, strict=True)
            ),
            6,
        ),
    )


def _brier_score(examples: list[TrainingExample]) -> float:
    outcomes = [1.0 if example.result_win else 0.0 for example in examples]
    probabilities = [_clip_probability(example.model_probability) for example in examples]
    return mean(
        (probability - outcome) ** 2
        for probability, outcome in zip(probabilities, outcomes, strict=True)
    )


def _log_loss(examples: list[TrainingExample]) -> float:
    outcomes = [1.0 if example.result_win else 0.0 for example in examples]
    probabilities = [_clip_probability(example.model_probability) for example in examples]
    return mean(
        -(
            outcome * log(probability)
            + (1 - outcome) * log(1 - probability)
        )
        for probability, outcome in zip(probabilities, outcomes, strict=True)
    )


def _calibration_error(
    examples: list[TrainingExample],
    prior_strength: int = 0,
) -> float:
    grouped: dict[str, list[TrainingExample]] = defaultdict(list)
    for example in examples:
        grouped[_bucket_name(example)].append(example)
    if not grouped:
        return 1.0

    weighted_error = 0.0
    total = 0
    for bucket_examples in grouped.values():
        probabilities = [_clip_probability(example.model_probability) for example in bucket_examples]
        outcomes = [1.0 if example.result_win else 0.0 for example in bucket_examples]
        avg_prediction = mean(probabilities)
        observed = mean(outcomes)
        if prior_strength:
            observed = (
                sum(outcomes) + avg_prediction * prior_strength
            ) / (len(outcomes) + prior_strength)
        weighted_error += abs(avg_prediction - observed) * len(bucket_examples)
        total += len(bucket_examples)
    return weighted_error / total


def _max_drawdown(pnl: list[float], stake: list[float]) -> float:
    peak = 0.0
    cumulative = 0.0
    worst = 0.0
    for value in pnl:
        cumulative += value
        peak = max(peak, cumulative)
        worst = max(worst, peak - cumulative)
    return worst / max(1.0, sum(stake))


def _bucket_name(example: TrainingExample) -> str:
    if example.calibration_bucket:
        return example.calibration_bucket
    probability = _clip_probability(example.model_probability)
    lower = int(probability * 10) / 10
    return f"{lower:.1f}-{lower + 0.1:.1f}"


def _bucket_bounds(bucket: str) -> tuple[float, float]:
    try:
        lower, upper = bucket.split("-", 1)
        return float(lower), float(upper)
    except ValueError:
        return 0.0, 1.0


def _clip_probability(probability: float) -> float:
    return min(MAX_PROBABILITY, max(MIN_PROBABILITY, probability))


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    return date.fromisoformat(value)

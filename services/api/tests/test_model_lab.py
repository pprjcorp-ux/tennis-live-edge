from datetime import datetime, timedelta, timezone
import asyncio

from tennis_edge.domain import BacktestRunRequest, OrderStatus, PaperSettlement, TrainingExample
from tennis_edge.config import Settings
from tennis_edge.services.repository import AnalysisRepository
from tennis_edge.services.storage import PersistentStore
from tennis_edge.services.model_lab import (
    calibration_from_training_examples,
    walk_forward_from_training_examples,
)


def _example(
    index: int,
    probability: float,
    result_win: bool,
    pnl: float,
    clv: float,
    model_version: str = "prematch_ensemble_v1",
) -> TrainingExample:
    bucket = f"{int(probability * 10) / 10:.1f}-{int(probability * 10) / 10 + 0.1:.1f}"
    return TrainingExample(
        id=f"train_{index}",
        match_id=f"match_{index}",
        player_id=f"player_{index}",
        model_version=model_version,
        feature_snapshot_id=f"fs_{index}",
        decision_ts=datetime(2026, 5, 1, tzinfo=timezone.utc) + timedelta(days=index),
        model_probability=probability,
        market_probability=max(0.05, probability - 0.04),
        closing_probability=max(0.05, probability - clv),
        result_win=result_win,
        pnl=pnl,
        clv=clv,
        calibration_bucket=bucket,
    )


def test_walk_forward_backtest_uses_settled_training_examples_only() -> None:
    examples = [
        _example(1, 0.62, True, 0.8, 0.012),
        _example(2, 0.71, True, 0.6, 0.008),
        _example(3, 0.56, False, -0.4, 0.006),
        _example(4, 0.68, True, 0.5, 0.011),
        _example(5, 0.74, False, -0.3, 0.007),
        _example(99, 0.9, True, 3.0, 0.2, model_version="future_candidate"),
        _example(100, 0.55, True, 2.0, 0.01).model_copy(update={"result_win": None}),
    ]

    metrics = walk_forward_from_training_examples(
        BacktestRunRequest(model_version="prematch_ensemble_v1", walk_forward=True),
        examples,
    )

    assert metrics.model_version == "prematch_ensemble_v1"
    assert metrics.matches == 5
    assert metrics.signals == 5
    assert metrics.roi > 0
    assert metrics.clv > 0.005
    assert 0 < metrics.brier_score < 0.24
    assert metrics.log_loss < 0.7
    assert metrics.promoted is True


def test_calibration_report_is_built_by_probability_bucket() -> None:
    examples = [
        _example(1, 0.54, True, 0.4, 0.01),
        _example(2, 0.57, False, -0.2, 0.006),
        _example(3, 0.66, True, 0.5, 0.008),
        _example(4, 0.69, True, 0.7, 0.012),
    ]

    report = calibration_from_training_examples(
        "bt_test",
        "prematch_ensemble_v1",
        examples,
    )

    assert report.run_id == "bt_test"
    assert [bucket.bucket for bucket in report.buckets] == ["0.5-0.6", "0.6-0.7"]
    assert report.buckets[0].predictions == 2
    assert report.buckets[1].observed_win_rate == 1
    assert report.calibration_error > 0


def test_walk_forward_rejects_better_roi_with_bad_clv_and_calibration() -> None:
    examples = [
        _example(1, 0.9, True, 1.0, -0.02),
        _example(2, 0.88, False, -0.1, -0.015),
        _example(3, 0.86, True, 1.0, -0.012),
        _example(4, 0.84, False, -0.1, -0.018),
    ]

    metrics = walk_forward_from_training_examples(
        BacktestRunRequest(model_version="prematch_ensemble_v1", walk_forward=True),
        examples,
    )

    assert metrics.roi > 0
    assert metrics.promoted is False
    assert metrics.rejection_reason is not None
    assert "CLV" in metrics.rejection_reason


def test_walk_forward_roi_uses_staked_exposure_when_available() -> None:
    examples = [
        _example(1, 0.62, True, 10, 0.012).model_copy(update={"stake_amount": 100}),
        _example(2, 0.71, False, -5, 0.008).model_copy(update={"stake_amount": 50}),
    ]

    metrics = walk_forward_from_training_examples(
        BacktestRunRequest(model_version="prematch_ensemble_v1"),
        examples,
    )

    assert metrics.roi == 0.033333


def test_training_example_uses_decision_timestamp_and_matched_stake() -> None:
    prediction_created_at = datetime(2026, 5, 1, 14, tzinfo=timezone.utc)
    settlement = PaperSettlement(
        order_id="paper_1",
        status=OrderStatus.SETTLED,
        result_win=True,
        requested_odds=2.0,
        average_price=2.02,
        matched_stake=75,
        gross_pnl=76.5,
        commission=1.53,
        net_pnl=74.97,
        closing_odds=1.95,
        clv=0.017,
        settled_at=datetime(2026, 5, 3, 20, tzinfo=timezone.utc),
    )

    class CursorStub:
        def __init__(self) -> None:
            self.insert_params = None

        def execute(self, query, params):
            if "SELECT" in query:
                return self
            self.insert_params = params
            return self

        def fetchone(self):
            return {
                "external_order_ref": "paper_1",
                "match_id": "match_1",
                "player_id": "player_1",
                "stake_amount": 100,
                "matched_stake": 75,
                "order_created_at": datetime(2026, 5, 1, 13, tzinfo=timezone.utc),
                "model_prob": 0.62,
                "market_prob": 0.58,
                "model_version_id": "prematch_ensemble_v1",
                "feature_snapshot_id": 123,
                "prediction_created_at": prediction_created_at,
            }

    cursor = CursorStub()
    PersistentStore(Settings(data_mode="sample"))._insert_training_example(
        cursor,
        paper_order_id=1,
        settlement=settlement,
    )

    assert cursor.insert_params is not None
    assert cursor.insert_params[5] == prediction_created_at
    assert cursor.insert_params[12] == 75


def test_repository_prefers_persisted_model_lab_reports() -> None:
    report = calibration_from_training_examples(
        "bt_store",
        "prematch_ensemble_v1",
        [
            _example(1, 0.54, True, 0.4, 0.01),
            _example(2, 0.57, False, -0.2, 0.006),
        ],
    )
    metrics = walk_forward_from_training_examples(
        BacktestRunRequest(model_version="prematch_ensemble_v1"),
        [
            _example(1, 0.62, True, 0.8, 0.012),
            _example(2, 0.71, True, 0.6, 0.008),
            _example(3, 0.56, False, -0.4, 0.006),
        ],
    )

    class StoreStub:
        def model_registry(self):
            return ["persisted-registry"]

        def champion_model(self):
            return "persisted-champion"

        def calibration_report(self, run_id):
            assert run_id == "bt_store"
            return report

        def backtest_metrics(self, request):
            return metrics

        def save_backtest(self, metrics_arg, request):
            self.saved = (metrics_arg, request)

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub()

    assert asyncio.run(repo.model_registry()) == ["persisted-registry"]
    assert asyncio.run(repo.champion_model()) == "persisted-champion"
    assert asyncio.run(repo.calibration_report("bt_store")) == report
    assert asyncio.run(repo.run_backtest(BacktestRunRequest(model_version="prematch_ensemble_v1"))) == metrics

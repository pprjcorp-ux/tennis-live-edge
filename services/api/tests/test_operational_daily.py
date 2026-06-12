import asyncio
import json

from tennis_edge.domain import (
    AutoPaperSettleResult,
    BacktestMetrics,
    ExecutionStage,
    ExecutionStatus,
    ExecutionVenue,
    ReplayContractRunRequest,
    ReplayContractRunResult,
    ReplayContractScenarioResult,
)
from tennis_edge.operational_daily import _run, run_daily_operational_loop


def _replay_result(*, passed: bool = True) -> ReplayContractRunResult:
    return ReplayContractRunResult(
        match_id="match_atp_002",
        passed=passed,
        scenarios=[
            ReplayContractScenarioResult(
                scenario="healthy",
                run_id="replay_daily",
                final_status="completed" if passed else "degraded",
                events_replayed=3 if passed else 0,
                score_ticks=1 if passed else 0,
                odds_ticks=2 if passed else 0,
                providers_seen=[],
                output_contracts=[],
                passed=passed,
            )
        ],
    )


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


def _backtest_metrics() -> BacktestMetrics:
    return BacktestMetrics(
        run_id="bt_daily",
        model_version="prematch_ensemble_v1",
        matches=4,
        signals=4,
        roi=0.04,
        clv=0.012,
        brier_score=0.21,
        log_loss=0.62,
        calibration_error=0.03,
        max_drawdown=0.01,
    )


class RepoStub:
    def __init__(self, *, replay_passed: bool = True, backtest_available: bool = True) -> None:
        self.replay_passed = replay_passed
        self.backtest_available = backtest_available
        self.replay_request: ReplayContractRunRequest | None = None
        self.replay_source: str | None = None
        self.auto_settle_request = None
        self.backtest_request = None

    async def run_replay_contracts(self, request, *, source):
        self.replay_request = request
        self.replay_source = source
        return _replay_result(passed=self.replay_passed)

    async def auto_settle_paper(self, request):
        self.auto_settle_request = request
        return AutoPaperSettleResult(
            evaluated_orders=2,
            settled_orders=1,
            skipped_orders=1,
            training_examples_ready=1,
            reasons=["ord_live: latest score state is not finished."],
        )

    async def run_backtest(self, request):
        self.backtest_request = request
        if not self.backtest_available:
            raise KeyError("No persisted training examples available for live backtest")
        return _backtest_metrics()

    async def execution_status(self):
        return _execution_status()


def test_daily_operational_loop_runs_replay_settlement_and_backtest() -> None:
    repo = RepoStub()

    result = asyncio.run(
        run_daily_operational_loop(
            repo,
            match_id="match_atp_002",
            settle_match_id="match_atp_002",
            max_orders=7,
            scenarios=["healthy"],
            model_version="prematch_ensemble_v1",
            feature_set="live_budget_v1",
        )
    )

    assert result.status == "completed"
    assert result.source == "cli"
    assert result.live_api_calls == 0
    assert result.replay_contracts.passed is True
    assert result.paper_auto_settlement.training_examples_ready == 1
    assert result.model_lab_backtest.status == "completed"
    assert result.model_lab_backtest.run_id == "bt_daily"
    assert result.execution.can_submit_real_orders is False
    assert result.execution.real_execution_hard_block is True
    assert repo.replay_source == "cli"
    assert repo.replay_request is not None
    assert repo.replay_request.scenarios == ["healthy"]
    assert repo.auto_settle_request.match_id == "match_atp_002"
    assert repo.auto_settle_request.max_orders == 7
    assert repo.backtest_request.feature_set == "live_budget_v1"


def test_daily_operational_loop_collects_when_training_examples_are_missing() -> None:
    result = asyncio.run(
        run_daily_operational_loop(
            RepoStub(backtest_available=False),
            match_id="match_atp_002",
        )
    )

    assert result.status == "collecting"
    assert result.replay_contracts.passed is True
    assert result.model_lab_backtest.status == "skipped"
    assert result.model_lab_backtest.reason is not None
    assert "No persisted training examples" in result.model_lab_backtest.reason


def test_daily_operational_cli_exit_codes(monkeypatch, capsys) -> None:
    class RepoFactory:
        def __init__(self, _settings) -> None:
            self.repo = RepoStub(replay_passed=False, backtest_available=False)

        def __getattr__(self, name):
            return getattr(self.repo, name)

    monkeypatch.setattr("tennis_edge.operational_daily.get_settings", lambda: object())
    monkeypatch.setattr("tennis_edge.operational_daily.AnalysisRepository", RepoFactory)

    exit_code = asyncio.run(_run(["--match-id", "match_atp_002", "--require-backtest"]))
    captured = capsys.readouterr()

    assert exit_code == 2
    assert '"status": "degraded"' in captured.out
    assert '"live_api_calls": 0' in captured.out


def test_daily_operational_cli_can_require_backtest(monkeypatch, capsys) -> None:
    class RepoFactory:
        def __init__(self, _settings) -> None:
            self.repo = RepoStub(replay_passed=True, backtest_available=False)

        def __getattr__(self, name):
            return getattr(self.repo, name)

    monkeypatch.setattr("tennis_edge.operational_daily.get_settings", lambda: object())
    monkeypatch.setattr("tennis_edge.operational_daily.AnalysisRepository", RepoFactory)

    exit_code = asyncio.run(_run(["--match-id", "match_atp_002", "--require-backtest"]))
    captured = capsys.readouterr()
    body = json.loads(captured.out)

    assert exit_code == 3
    assert body["status"] == "collecting"
    assert body["model_lab_backtest"]["feature_set"] == "live_budget_v1"
    assert body["model_lab_backtest"]["status"] == "skipped"

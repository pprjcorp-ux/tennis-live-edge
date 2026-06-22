import asyncio
import json

from tennis_edge.domain import (
    AutoPaperSettleDecision,
    AutoPaperSettleResult,
    BacktestMetrics,
    ExecutionStage,
    ExecutionStatus,
    ExecutionVenue,
    PaperRehearsalResult,
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
        self.paper_rehearsal_model_version = None
        self.backtest_request = None
        self.ingestion_run_calls = []

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
            decisions=[
                AutoPaperSettleDecision(
                    order_id="ord_daily_settled",
                    match_id="match_atp_002",
                    player_id="p1",
                    status="settled",
                    reason="settlement persisted and training_example is ready.",
                    result_win=True,
                    closing_odds=1.8,
                    training_example_ready=True,
                ),
                AutoPaperSettleDecision(
                    order_id="ord_live",
                    match_id="match_atp_002",
                    player_id="p1",
                    status="skipped",
                    reason="latest score state is not finished.",
                ),
            ],
            reasons=["ord_live: latest score state is not finished."],
        )

    async def run_paper_rehearsal(self, *, model_version):
        self.paper_rehearsal_model_version = model_version
        return PaperRehearsalResult(
            enabled=True,
            match_id="match_paper_rehearsal",
            signal_id="sig_paper_rehearsal",
            order_id="ord_paper_rehearsal",
            settled_orders=1,
            training_examples_ready=1,
            settlement_decisions=[
                AutoPaperSettleDecision(
                    order_id="ord_paper_rehearsal",
                    match_id="match_paper_rehearsal",
                    player_id="p1",
                    status="settled",
                    reason="settlement persisted and training_example is ready.",
                    result_win=True,
                    closing_odds=1.8,
                    training_example_ready=True,
                )
            ],
            live_api_calls=0,
            notes=["rehearsal"],
        )

    async def run_backtest(self, request):
        self.backtest_request = request
        if not self.backtest_available:
            raise KeyError("No persisted training examples available for live backtest")
        return _backtest_metrics()

    async def execution_status(self):
        return _execution_status()

    def record_ingestion_run(self, run_type, summary, *, source="system", started_at=None):
        self.ingestion_run_calls.append(
            {
                "run_type": run_type,
                "summary": summary,
                "source": source,
                "started_at": started_at,
            }
        )


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
    assert len(result.paper_auto_settlement.decisions) == 2
    assert result.model_lab_backtest.status == "completed"
    assert result.model_lab_backtest.run_id == "bt_daily"
    assert result.execution.can_submit_real_orders is False
    assert result.execution.real_execution_hard_block is True
    assert repo.replay_source == "cli"
    assert repo.replay_request is not None
    assert repo.replay_request.scenarios == ["healthy"]
    assert repo.auto_settle_request.match_id == "match_atp_002"
    assert repo.auto_settle_request.max_orders == 7
    assert repo.paper_rehearsal_model_version is None
    assert repo.backtest_request.feature_set == "live_budget_v1"
    assert len(repo.ingestion_run_calls) == 1
    ingestion_run = repo.ingestion_run_calls[0]
    assert ingestion_run["run_type"] == "daily_operational_run"
    assert ingestion_run["source"] == "cli"
    assert ingestion_run["started_at"] is not None
    assert ingestion_run["summary"]["run_kind"] == "daily_operational_run"
    assert ingestion_run["summary"]["trigger_source"] == "cli"
    assert ingestion_run["summary"]["status"] == "completed"
    assert ingestion_run["summary"]["live_api_calls"] == 0
    assert ingestion_run["summary"]["replay_contracts"]["passed"] is True
    assert ingestion_run["summary"]["execution"]["can_submit_real_orders"] is False
    assert ingestion_run["summary"]["execution"]["real_execution_hard_block"] is True
    assert len(ingestion_run["summary"]["paper_auto_settlement"]["decisions"]) == 2


def test_daily_operational_loop_collects_when_training_examples_are_missing() -> None:
    repo = RepoStub(backtest_available=False)
    result = asyncio.run(
        run_daily_operational_loop(
            repo,
            match_id="match_atp_002",
        )
    )

    assert result.status == "collecting"
    assert result.replay_contracts.passed is True
    assert result.model_lab_backtest.status == "skipped"
    assert result.model_lab_backtest.reason is not None
    assert "No persisted training examples" in result.model_lab_backtest.reason
    assert repo.ingestion_run_calls[0]["summary"]["status"] == "collecting"


def test_daily_operational_loop_can_run_explicit_paper_rehearsal() -> None:
    repo = RepoStub()

    result = asyncio.run(
        run_daily_operational_loop(
            repo,
            match_id="match_atp_002",
            model_version="paper_rehearsal_v1",
            run_paper_rehearsal=True,
        )
    )

    assert result.status == "completed"
    assert result.paper_rehearsal is not None
    assert result.paper_rehearsal.enabled is True
    assert result.paper_rehearsal.live_api_calls == 0
    assert result.paper_rehearsal.training_examples_ready == 1
    assert len(result.paper_rehearsal.settlement_decisions) == 1
    assert repo.paper_rehearsal_model_version == "paper_rehearsal_v1"
    assert repo.ingestion_run_calls[0]["summary"]["paper_rehearsal"]["order_id"] == "ord_paper_rehearsal"
    assert (
        repo.ingestion_run_calls[0]["summary"]["paper_rehearsal"]["settlement_decisions"][0]["status"]
        == "settled"
    )


def test_daily_operational_loop_uses_rehearsal_model_when_flag_has_default_model() -> None:
    repo = RepoStub()

    asyncio.run(
        run_daily_operational_loop(
            repo,
            match_id="match_atp_002",
            run_paper_rehearsal=True,
        )
    )

    assert repo.paper_rehearsal_model_version == "paper_rehearsal_v1"
    assert repo.backtest_request.model_version == "prematch_ensemble_v1"


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

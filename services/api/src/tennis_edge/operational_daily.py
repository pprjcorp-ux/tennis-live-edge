from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Literal

from tennis_edge.config import get_settings
from tennis_edge.domain import (
    AutoPaperSettleRequest,
    BacktestRunRequest,
    DailyOperationalBacktestStatus,
    DailyOperationalExecutionSnapshot,
    DailyOperationalRunResult,
    PaperRehearsalResult,
    ReplayContractScenario,
)
from tennis_edge.replay_contracts import run_replay_contracts
from tennis_edge.services.repository import AnalysisRepository


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the paper-first daily operational loop without live API calls: "
            "replay contracts, paper auto-settlement and Model Lab backtest."
        )
    )
    parser.add_argument(
        "--match-id",
        default="match_atp_002",
        help="Fixture/canonical match id for replay contracts. Defaults to match_atp_002.",
    )
    parser.add_argument(
        "--settle-match-id",
        default=None,
        help="Optional match id filter for paper auto-settlement.",
    )
    parser.add_argument(
        "--max-orders",
        type=int,
        default=100,
        help="Maximum paper orders to evaluate for auto-settlement.",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        choices=["healthy", "gap", "resync_required"],
        help="Replay contract scenario to run. Repeat for multiple scenarios.",
    )
    parser.add_argument(
        "--model-version",
        default="prematch_ensemble_v1",
        help="Model version for the persisted training_examples backtest.",
    )
    parser.add_argument(
        "--feature-set",
        default="live_budget_v1",
        help="Feature set for the persisted training_examples backtest.",
    )
    parser.add_argument(
        "--require-backtest",
        action="store_true",
        help="Exit non-zero when no persisted training examples are available.",
    )
    parser.add_argument(
        "--run-paper-rehearsal",
        action="store_true",
        help=(
            "Create and settle one explicit paper rehearsal fixture before backtesting. "
            "Use only with a rehearsal model version; this does not call live APIs."
        ),
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output for humans.",
    )
    return parser.parse_args(argv)


async def run_daily_operational_loop(
    repo: AnalysisRepository,
    *,
    match_id: str = "match_atp_002",
    settle_match_id: str | None = None,
    max_orders: int = 100,
    scenarios: list[ReplayContractScenario] | None = None,
    model_version: str = "prematch_ensemble_v1",
    feature_set: str = "live_budget_v1",
    run_paper_rehearsal: bool = False,
    source: Literal["api", "cli", "openclaw", "cron", "system"] = "cli",
) -> DailyOperationalRunResult:
    started_at = datetime.now(timezone.utc)
    replay = await run_replay_contracts(
        repo,
        match_id=match_id,
        scenarios=scenarios,
        source=source,
    )
    settlement = await repo.auto_settle_paper(
        AutoPaperSettleRequest(match_id=settle_match_id, max_orders=max_orders)
    )
    paper_rehearsal: PaperRehearsalResult | None = None
    if run_paper_rehearsal:
        rehearsal_model_version = (
            model_version
            if model_version.startswith("paper_rehearsal")
            else "paper_rehearsal_v1"
        )
        paper_rehearsal = await repo.run_paper_rehearsal(model_version=rehearsal_model_version)
    backtest_request = BacktestRunRequest(
        model_version=model_version,
        feature_set=feature_set,
    )
    backtest_status: DailyOperationalBacktestStatus
    try:
        backtest = await repo.run_backtest(backtest_request)
        backtest_status = DailyOperationalBacktestStatus(
            status="completed",
            run_id=backtest.run_id,
            model_version=backtest.model_version,
            feature_set=feature_set,
            signals=backtest.signals,
            roi=backtest.roi,
            clv=backtest.clv,
            brier_score=backtest.brier_score,
            log_loss=backtest.log_loss,
            calibration_error=backtest.calibration_error,
            max_drawdown=backtest.max_drawdown,
        )
    except KeyError as exc:
        backtest_status = DailyOperationalBacktestStatus(
            status="skipped",
            reason=str(exc.args[0]) if exc.args else str(exc),
            model_version=model_version,
            feature_set=feature_set,
        )

    execution = await repo.execution_status()
    status = "completed" if replay.passed else "degraded"
    if backtest_status.status == "skipped":
        status = "collecting" if replay.passed else "degraded"

    result = DailyOperationalRunResult(
        status=status,
        generated_at=datetime.now(timezone.utc),
        source=source,
        live_api_calls=0,
        match_id=match_id,
        replay_contracts=replay,
        paper_rehearsal=paper_rehearsal,
        paper_auto_settlement=settlement,
        model_lab_backtest=backtest_status,
        execution=DailyOperationalExecutionSnapshot(
            can_submit_real_orders=execution.can_submit_real_orders,
            real_execution_hard_block=execution.real_execution_hard_block,
            stage=execution.stage,
        ),
    )
    repo.record_ingestion_run(
        "daily_operational_run",
        {
            **result.model_dump(mode="json"),
            "run_kind": "daily_operational_run",
            "trigger_source": source,
        },
        source=source,
        started_at=started_at,
    )
    return result


async def _run(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    repo = AnalysisRepository(get_settings())
    result = await run_daily_operational_loop(
        repo,
        match_id=args.match_id,
        settle_match_id=args.settle_match_id,
        max_orders=args.max_orders,
        scenarios=args.scenario,
        model_version=args.model_version,
        feature_set=args.feature_set,
        run_paper_rehearsal=args.run_paper_rehearsal,
        source="cli",
    )
    print(_json(result.model_dump(mode="json"), pretty=args.pretty))
    if not result.replay_contracts.passed:
        return 2
    if args.require_backtest and result.model_lab_backtest.status == "skipped":
        return 3
    return 0


def _json(payload: dict[str, Any], *, pretty: bool) -> str:
    return json.dumps(payload, indent=2 if pretty else None, sort_keys=True)


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()

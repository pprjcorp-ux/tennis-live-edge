#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
API_SRC = ROOT / "services/api/src"
VENV_PYTHON = ROOT / ".venv/bin/python"
if (
    VENV_PYTHON.exists()
    and Path(sys.executable) != VENV_PYTHON
    and os.environ.get("TENNIS_EDGE_RUNTIME_CHECK_BOOTSTRAPPED") != "1"
):
    os.environ["TENNIS_EDGE_RUNTIME_CHECK_BOOTSTRAPPED"] = "1"
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), *sys.argv])

if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))


from tennis_edge.config import Settings  # noqa: E402
from tennis_edge.domain import SignalStatus  # noqa: E402
from tennis_edge.operational_daily import run_daily_operational_loop  # noqa: E402
from tennis_edge.services.repository import AnalysisRepository  # noqa: E402


REQUIRED_TABLES = {
    "raw_provider_payloads",
    "matches",
    "score_ticks",
    "odds_ticks",
    "provider_cursors",
    "provider_latency",
    "ingestion_runs",
    "paper_orders",
    "paper_settlements",
    "closing_line_snapshots",
    "training_examples",
}


@dataclass
class RuntimeCheck:
    name: str
    passed: bool
    detail: str
    evidence: dict[str, Any] = field(default_factory=dict)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Validate the local paper-first operational truth path: Postgres schema, "
            "fake-provider replay contracts, dashboard persisted state, execution hard block, "
            "and rehearsal-only training examples without live API calls."
        )
    )
    parser.add_argument(
        "--skip-paper-rehearsal",
        action="store_true",
        help="Do not create the paper rehearsal order/training example smoke row.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON evidence.",
    )
    return parser.parse_args(argv)


def _settings() -> Settings:
    _load_env_file(ROOT / ".env")
    return Settings()


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            os.environ.setdefault(key, value)


def _add(
    checks: list[RuntimeCheck],
    name: str,
    passed: bool,
    detail: str,
    **evidence: Any,
) -> None:
    checks.append(RuntimeCheck(name=name, passed=passed, detail=detail, evidence=evidence))


def _schema_check(settings: Settings) -> RuntimeCheck:
    if not settings.persistence_enabled:
        return RuntimeCheck(
            "postgres_schema",
            False,
            "Persistence is disabled; operational truth requires Postgres/Timescale.",
        )
    if not settings.database_url:
        return RuntimeCheck(
            "postgres_schema",
            False,
            "DATABASE_URL is missing.",
        )
    try:
        import psycopg

        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                rows = cur.execute(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                    """
                ).fetchall()
                present = {str(row[0]) for row in rows}
                missing = sorted(REQUIRED_TABLES - present)
                if missing:
                    return RuntimeCheck(
                        "postgres_schema",
                        False,
                        "Required operational tables are missing; apply infra/schema.sql.",
                        {"missing_tables": missing},
                    )
                counts = {}
                for table in sorted(REQUIRED_TABLES):
                    count_row = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
                    counts[table] = int(count_row[0]) if count_row else 0
                return RuntimeCheck(
                    "postgres_schema",
                    True,
                    "Required operational tables exist.",
                    {"table_counts": counts},
                )
    except Exception as exc:
        return RuntimeCheck(
            "postgres_schema",
            False,
            f"Could not validate Postgres schema: {type(exc).__name__}: {exc}",
        )


def _latest_persisted_match_date(settings: Settings) -> date:
    if not settings.persistence_enabled or not settings.database_url:
        return date.today()
    try:
        import psycopg

        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                row = cur.execute("SELECT MAX(scheduled_at::date) FROM matches").fetchone()
                if row and row[0]:
                    return row[0]
    except Exception:
        return date.today()
    return date.today()


async def _runtime_checks(settings: Settings, *, run_paper_rehearsal: bool) -> list[RuntimeCheck]:
    repo = AnalysisRepository(settings)
    checks: list[RuntimeCheck] = [_schema_check(settings)]
    dashboard_date = _latest_persisted_match_date(settings)

    _add(
        checks,
        "runtime_mode",
        settings.data_mode != "sample",
        (
            "Runtime is using persisted operational mode."
            if settings.data_mode != "sample"
            else "TENNIS_EDGE_DATA_MODE=sample bypasses the persisted operational store."
        ),
        data_mode=settings.data_mode,
        runtime_profile=settings.runtime_profile,
        coverage=sorted(settings.coverage_set),
    )

    daily = await run_daily_operational_loop(
        repo,
        run_paper_rehearsal=run_paper_rehearsal,
        source="system",
    )
    _add(
        checks,
        "fake_provider_replay_contracts",
        daily.live_api_calls == 0 and daily.replay_contracts.passed,
        (
            "Replay contracts passed without live API calls."
            if daily.live_api_calls == 0 and daily.replay_contracts.passed
            else "Replay contracts failed or attempted live API calls."
        ),
        live_api_calls=daily.live_api_calls,
        replay_passed=daily.replay_contracts.passed,
        scenarios=[scenario.scenario for scenario in daily.replay_contracts.scenarios],
    )

    if run_paper_rehearsal:
        rehearsal = daily.paper_rehearsal
        _add(
            checks,
            "paper_rehearsal_training_example",
            bool(
                rehearsal
                and rehearsal.live_api_calls == 0
                and rehearsal.training_examples_ready >= 1
                and len(rehearsal.settlement_decisions) >= rehearsal.settled_orders
            ),
            (
                "Paper rehearsal created settled rehearsal training evidence without live API calls."
                if rehearsal
                and rehearsal.live_api_calls == 0
                and rehearsal.training_examples_ready >= 1
                and len(rehearsal.settlement_decisions) >= rehearsal.settled_orders
                else "Paper rehearsal did not create settled rehearsal training evidence."
            ),
            live_api_calls=rehearsal.live_api_calls if rehearsal else None,
            training_examples_ready=rehearsal.training_examples_ready if rehearsal else 0,
            settled_orders=rehearsal.settled_orders if rehearsal else 0,
            settlement_decisions=len(rehearsal.settlement_decisions) if rehearsal else 0,
        )

    dashboard = await repo.live_dashboard_snapshot(dashboard_date)
    operational = dashboard.operational_state
    matrix_modes = {step.mode for step in operational.provider_mode_matrix}
    _add(
        checks,
        "dashboard_provider_modes",
        matrix_modes == {"sample", "replay", "live_without_keys", "live_with_keys"},
        "Dashboard operational state exposes all provider modes.",
        active_mode=operational.provider_mode,
        modes=sorted(matrix_modes),
        reason=operational.provider_mode_reason,
        dashboard_date=dashboard_date,
    )
    replay_persistence = operational.replay_lab.last_contract_persistence
    replay_persistence_complete = (
        len(replay_persistence) == 3
        and all(item.raw_payloads_saved > 0 for item in replay_persistence)
        and all(item.score_ticks_saved > 0 for item in replay_persistence)
        and any(item.odds_ticks_saved > 0 for item in replay_persistence)
        and all(item.provider_cursors_replayed > 0 for item in replay_persistence)
        and all(item.provider_latency_saved > 0 for item in replay_persistence)
        and all(len(item.provider_contracts) == 3 for item in replay_persistence)
        and all(
            all(contract.passed for contract in item.provider_contracts)
            for item in replay_persistence
        )
    )
    _add(
        checks,
        "dashboard_replay_persistence_evidence",
        replay_persistence_complete,
        (
            "Dashboard Replay Lab exposes persisted contract evidence by scenario."
            if replay_persistence_complete
            else "Dashboard Replay Lab is missing persisted contract evidence."
        ),
        scenarios=[
            {
                "scenario": item.scenario,
                "raw_payloads_saved": item.raw_payloads_saved,
                "score_ticks_saved": item.score_ticks_saved,
                "odds_ticks_saved": item.odds_ticks_saved,
                "provider_cursors_replayed": item.provider_cursors_replayed,
                "cursors_saved": item.cursors_saved,
                "provider_latency_saved": item.provider_latency_saved,
                "provider_contracts": [
                    {
                        "provider": contract.provider.value,
                        "adapter_contract": contract.adapter_contract,
                        "passed": contract.passed,
                        "observed_outputs": contract.observed_output_contracts,
                    }
                    for contract in item.provider_contracts
                ],
                "resync_required": item.resync_required,
            }
            for item in replay_persistence
        ],
    )
    freshness_rows = operational.source_summary.match_freshness
    freshness_complete = (
        operational.source_summary.total_matches > 0
        and len(freshness_rows) == operational.source_summary.total_matches
        and all(row.persisted for row in freshness_rows)
    )
    _add(
        checks,
        "dashboard_persisted_source",
        operational.source_summary.total_matches > 0
        and operational.source_summary.persisted_matches == operational.source_summary.total_matches
        and freshness_complete,
        (
            "Dashboard matches are coming from persisted canonical state."
            if operational.source_summary.total_matches > 0
            and operational.source_summary.persisted_matches == operational.source_summary.total_matches
            and freshness_complete
            else "Dashboard still has volatile or empty match state."
        ),
        total_matches=operational.source_summary.total_matches,
        persisted_matches=operational.source_summary.persisted_matches,
        dashboard_date=dashboard_date,
        match_freshness_rows=len(freshness_rows),
        match_freshness_preview=[
            {
                "match_id": row.match_id,
                "source": row.source,
                "persisted": row.persisted,
                "score_age_ms": row.score_age_ms,
                "odds_age_ms": row.odds_age_ms,
            }
            for row in freshness_rows[:3]
        ],
        source_counts=operational.source_summary.source_counts,
    )
    _add(
        checks,
        "signals_fail_closed_in_replay",
        all(signal.status != SignalStatus.ENTRY for signal in dashboard.signals),
        "Replay/fallback dashboard signals are monitor-only or blocked, not Entrada.",
        signal_statuses=[signal.status for signal in dashboard.signals],
    )
    _add(
        checks,
        "real_execution_blocked",
        (
            daily.execution.can_submit_real_orders is False
            and daily.execution.real_execution_hard_block is True
            and operational.execution_status.can_submit_real_orders is False
        ),
        "Real execution remains hard-blocked.",
        daily_can_submit=daily.execution.can_submit_real_orders,
        dashboard_can_submit=operational.execution_status.can_submit_real_orders,
        real_execution_hard_block=daily.execution.real_execution_hard_block,
        stage=daily.execution.stage,
    )
    _add(
        checks,
        "model_lab_training_examples",
        (
            operational.model_lab.source == "training_examples"
            and operational.model_lab.total_training_examples
            >= operational.model_lab.training_examples
            and operational.model_lab.rehearsal_training_examples >= 0
        ),
        "Model Lab readiness is derived from persisted training_examples lineage.",
        status=operational.model_lab.status,
        production_training_examples=operational.model_lab.production_training_examples,
        rehearsal_training_examples=operational.model_lab.rehearsal_training_examples,
        total_training_examples=operational.model_lab.total_training_examples,
        can_run_live_backtest=operational.model_lab.can_run_live_backtest,
        reasons=operational.model_lab.reasons,
    )
    _add(
        checks,
        "api_onboarding_core_gate",
        operational.api_onboarding.core_ready is True,
        "API onboarding sees the local core as ready before paid providers are added.",
        current_step=operational.api_onboarding.current_step,
        budget_chain_completed=operational.api_onboarding.budget_chain_completed,
        enterprise_eligible=operational.api_onboarding.enterprise_eligible,
        warnings=operational.api_onboarding.warnings,
    )
    return checks


async def _run(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    settings = _settings()
    checks = await _runtime_checks(
        settings,
        run_paper_rehearsal=not args.skip_paper_rehearsal,
    )
    passed = all(check.passed for check in checks)
    payload = {
        "passed": passed,
        "checks": [
            {
                "name": check.name,
                "passed": check.passed,
                "detail": check.detail,
                "evidence": check.evidence,
            }
            for check in checks
        ],
    }
    print(json.dumps(payload, indent=2 if args.pretty else None, sort_keys=True, default=str))
    return 0 if passed else 2


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()

from __future__ import annotations

from pathlib import Path
import os
import re
import sys

from check_cloudflare_private_runtime import validate_cloudflare_private_runtime


ROOT = Path(__file__).resolve().parents[1]


def duplicate_schema_columns(schema_text: str) -> list[str]:
    duplicates: list[str] = []
    table_pattern = re.compile(
        r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][\w]*)\s*\((.*?)\);",
        re.IGNORECASE | re.DOTALL,
    )
    table_constraints = {"CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "EXCLUDE"}
    for table_match in table_pattern.finditer(schema_text):
        table = table_match.group(1)
        columns: set[str] = set()
        for raw_line in table_match.group(2).splitlines():
            line = raw_line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            column = line.split(None, 1)[0].strip('"')
            if not column or column.upper() in table_constraints:
                continue
            if column in columns:
                duplicates.append(f"{table}.{column}")
            columns.add(column)
    return duplicates


def _require_text(
    errors: list[str],
    *,
    label: str,
    text: str,
    required: list[str],
) -> None:
    for marker in required:
        if marker not in text:
            errors.append(f"{label} missing {marker}")


def validate_api_last_core_contract(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    source = root / "services/api/src/tennis_edge"
    tests = root / "services/api/tests"
    provider_adapters = (source / "services/provider_adapters.py").read_text()
    runtime_modes = (source / "runtime_modes.py").read_text()
    replay_engine = (source / "services/replay_engine.py").read_text()
    ingestion_pipeline = (source / "services/ingestion.py").read_text()
    replay_fixtures = (source / "services/budget_replay_fixtures.py").read_text()
    repository = (source / "services/repository.py").read_text()
    domain = (source / "domain.py").read_text()
    operational_state = (source / "services/operational_state.py").read_text()
    operational_session = (source / "services/operational_session.py").read_text()
    signal_gates = (source / "services/signal_gates.py").read_text()
    risk_engine = (source / "services/risk_engine.py").read_text()
    model_lab = (source / "services/model_lab.py").read_text()
    storage = (source / "services/storage.py").read_text()
    provider_tests = (tests / "test_enterprise_providers.py").read_text()
    enterprise_tests = (tests / "test_enterprise_upgrade.py").read_text()
    cost_tests = (tests / "test_cost_profile.py").read_text()
    persistence_tests = (tests / "test_live_budget_persistence.py").read_text()
    repository_tests = (tests / "test_repository.py").read_text()
    risk_tests = (tests / "test_enterprise_risk.py").read_text()
    signal_tests = (tests / "test_signal_engine.py").read_text()
    model_tests = (tests / "test_model_lab.py").read_text()
    operational_session_tests = (tests / "test_operational_session.py").read_text()
    operational_tests = (tests / "test_operational_state.py").read_text()
    agent_ops_tests = (tests / "test_agent_ops_anomalies.py").read_text()
    dashboard_read_model_tests = (tests / "test_live_dashboard_read_model.py").read_text()
    v1_tests = (tests / "test_v1_api.py").read_text()
    web_types = (root / "apps/web/lib/types.ts").read_text()
    data_health_panel = (
        root / "apps/web/app/components/data-health-panel.tsx"
    ).read_text()
    web_page = (root / "apps/web/app/page.tsx").read_text()
    web_api = (root / "apps/web/lib/api.ts").read_text()
    runtime_check = (root / "scripts/check_operational_truth_runtime.py").read_text()
    package_json = (root / "package.json").read_text()

    _require_text(
        errors,
        label="provider adapter contract",
        text=provider_adapters + runtime_modes,
        required=[
            "class ScoreProviderAdapter",
            "class OddsProviderAdapter",
            "class ArchiveOddsProviderAdapter",
            'OFFLINE_PROVIDER_MODES = frozenset({"sample", "replay"})',
            "uses_offline_provider_fixtures",
            "RawProviderPayload",
            "CanonicalMatch",
            "ProviderCursor",
            "ProviderLatency",
            "ProviderMatchPayload",
            "OddsTick",
            "canonical_match_from_provider_payload",
            "input_contracts",
        ],
    )
    _require_text(
        errors,
        label="replay engine contract",
        text=replay_engine,
        required=[
            "parse_api_tennis_score",
            "OddsApiIoClient",
            "TheOddsApiClient",
            "ProviderCursor",
            "ScoreTick",
            "ReplayRunResult",
            "resync_required",
        ],
    )
    _require_text(
        errors,
        label="provider failure warning contract",
        text=ingestion_pipeline + persistence_tests,
        required=[
            "score/live fetch failed",
            "archive augmentation failed",
            "test_live_ingestion_pipeline_records_raw_match_source_exception_as_warning",
            "test_live_ingestion_pipeline_records_archive_exception_as_warning",
        ],
    )
    _require_text(
        errors,
        label="budget replay fixtures",
        text=replay_fixtures,
        required=[
            'ReplayOddsScenario = Literal["healthy", "gap", "resync_required"]',
            "_api_tennis_score_payload",
            "_odds_api_io_payloads",
            "_the_odds_api_payload",
            '"resync_required"',
            '"lastSeq"',
        ],
    )
    _require_text(
        errors,
        label="repository replay journal",
        text=repository,
        required=[
            '"replay_run"',
            '"source": "replay"',
            "self.record_ingestion_run(",
            "if result.resync_required or state.notes",
            "notes = [*(state.notes or []), *(persisted.get(\"notes\") or [])]",
            '"payload_source": payload_source',
            '"use_fixture_seed": request.use_fixture_seed',
        ],
    )
    _require_text(
        errors,
        label="replay contract aggregate evidence",
        text=domain + repository + web_types + web_page + repository_tests + v1_tests,
        required=[
            "adapter_contracts",
            "input_contracts",
            "_replay_adapter_contracts",
            "_replay_input_contracts",
            "scenario.adapter_contracts",
            "scenario.input_contracts",
            "scenario.provider_latency_saved",
            "provider_latency_saved",
            "ReplayContractScenarioEvidence",
            "last_contract_persistence",
            '"ScoreProviderAdapter"',
            '"OddsProviderAdapter"',
            '"ArchiveOddsProviderAdapter"',
        ],
    )
    _require_text(
        errors,
        label="provider runtime modes",
        text=domain + web_types + operational_state + operational_session,
        required=[
            'ProviderRuntimeMode = Literal["sample", "replay", "live_without_keys", "live_with_keys"]',
            '"sample" | "replay" | "live_without_keys" | "live_with_keys"',
            "class OperationalSession",
            "snapshot.source != \"sample\" and snapshot.persisted",
            "self.store.latest_analyses(target_date)",
            "snapshot.source == \"persisted_fallback\"",
            "class ProviderModeStep",
            "ProviderModeEntryGate",
            "provider_mode_matrix",
            '"replay_run"',
            "class ApiOnboardingSnapshot",
            "ApiOnboardingStep",
            "class ModelLabReadinessSnapshot",
            "total_training_examples",
            "production_training_examples",
            "rehearsal_training_examples",
            "model_lab_readiness",
            "class ReplayLabSnapshot",
            "class OperationalSourceSummary",
            "source_summary",
            "ReplayContractProvider",
            "replay_lab_readiness",
            "source=\"budget_replay_fixtures\"",
            "use_fixture_seed: bool = False",
            "source=\"training_examples\"",
            "core_ready",
            "live_odds_websocket",
            "budget_stack_configured_enterprise_deferred",
        ],
    )
    _require_text(
        errors,
        label="signal safety gates",
        text=signal_gates + risk_engine,
        required=[
            "odds_ws_resync_required_blocks_signals",
            "Odds websocket cursor requires resync",
            "Odds feed is stale for live decisioning.",
            "Live score feed is stale for decisioning.",
            "Live score state is incomplete.",
        ],
    )
    _require_text(
        errors,
        label="paper learning persistence",
        text=storage + model_lab + web_page + web_api,
        required=[
            "paper_settlements",
            "closing_line_snapshots",
            "training_examples",
            "walk_forward_from_training_examples",
            "calibration_from_training_examples",
            "training_example_lineage_counts",
            "paper_rehearsal%",
            "matched_stake <= 0",
            "matched_stake > 0",
            "THEN matched_stake ELSE 0 END",
            "_winner_from_finished_state",
            "retirement/walkover score requires explicit provider winner",
            "autoSettlePaperOrders",
            "triggerAutoPaperSettlement",
            "Auto-settle paper",
        ],
    )
    _require_text(
        errors,
        label="core contract tests",
        text=(
            provider_tests
            + enterprise_tests
            + cost_tests
            + persistence_tests
            + repository_tests
            + risk_tests
            + signal_tests
            + model_tests
            + operational_session_tests
            + operational_tests
            + agent_ops_tests
            + dashboard_read_model_tests
            + v1_tests
        ),
        required=[
            "test_budget_replay_fixtures_exercise_provider_contracts_without_keys",
            "test_budget_adapter_contract_matrix_outputs_internal_formats_without_live_keys",
            "test_replay_mode_provider_clients_use_fake_api_without_live_calls",
            "test_replay_provider_health_reports_fake_feeds_without_configured_keys",
            "test_operational_state_marks_explicit_replay_mode_without_live_keys",
            "test_repository_regates_persisted_fallback_when_odds_cursor_requires_resync",
            "test_auto_settle_paper_orders_uses_explicit_winner_for_retirement",
            "test_auto_settle_paper_orders_skips_unsettleable_candidates",
            "test_walk_forward_backtest_uses_settled_training_examples_only",
            "test_walk_forward_ignores_invalid_zero_stake_examples",
            "test_paper_performance_uses_positive_matched_stake_only",
            "test_paper_performance_ignores_unmatched_settled_orders",
            "test_stale_live_odds_are_blocked",
            "test_invalid_live_score_state_blocks_entries_and_zeroes_stake",
            "test_persisted_fallback_match_state_uses_latest_score_source_latency",
            "test_provider_health_marks_exhausted_quota_unhealthy_without_latency_rows",
            "test_detect_anomalies_marks_exhausted_provider_quota_critical",
            "test_live_readiness_blocks_entries_when_critical_provider_health_is_unhealthy",
            "test_live_readiness_blocks_entries_when_provider_quota_is_exhausted",
            "test_live_readiness_blocks_entries_when_data_quality_reports_stale_ticks",
            "test_direct_paper_order_blocks_when_live_readiness_cannot_generate_entries",
            "test_api_onboarding_guides_budget_provider_sequence_after_archive_key",
            "test_api_onboarding_blocks_live_odds_step_when_cursor_requires_resync",
            "test_model_lab_readiness_uses_persisted_training_examples_dataset",
            "test_live_readiness_warns_when_only_rehearsal_training_examples_exist",
            "test_model_lab_readiness_excludes_rehearsal_examples_from_production",
            "test_model_lab_readiness_blocks_without_persistent_truth",
            "test_replay_lab_readiness_exposes_fake_api_contracts_without_live_keys",
            "test_replay_lab_readiness_collects_until_replay_run_is_persisted",
            "test_live_replay_uses_fixture_seed_only_when_explicitly_requested",
            "test_live_fixture_seed_replay_preserves_existing_provider_cursor",
            "test_replay_runner_degrades_unparseable_provider_payloads",
            "test_v1_replay_accepts_explicit_fixture_seed",
            "test_provider_mode_matrix_explains_replay_monitor_mode",
            "test_provider_mode_matrix_blocks_live_with_keys_when_cursor_requires_resync",
            "test_provider_mode_matrix_blocks_live_with_keys_when_provider_health_fails",
            "test_provider_mode_matrix_blocks_live_with_keys_when_data_quality_fails",
            "test_operational_session_reloads_canonical_persisted_snapshot_after_provider_write",
            "test_operational_session_gates_persisted_fallback_signals",
            "test_operational_source_summary_counts_persisted_and_runtime_sources",
            "test_signal_engine_blocks_stale_odds_even_with_large_edge",
            "test_signal_engine_blocks_invalid_live_score_state",
            "test_signal_engine_emits_no_signal_without_complete_moneyline",
        ],
    )
    _require_text(
        errors,
        label="dashboard operational truth",
        text=data_health_panel,
        required=[
            "Replay Contracts",
            "Provider Mode Matrix",
            "Source truth",
            "Readiness gate",
            "Cursor/freshness blocks",
            "sourceSummary.persisted_matches",
            "readiness?.can_generate_entries",
            "providerModeMatrix.map",
            "replayLab.providers",
            "replayLab.last_contract_persistence",
            "raw_payloads_saved",
            "provider_latency_saved",
            "run.run_type === \"replay_run\"",
            "events_replayed",
            "resync required",
            "Ingestion Journal",
        ],
    )
    _require_text(
        errors,
        label="integrated operational truth runtime check",
        text=runtime_check + package_json,
        required=[
            "api:check:operational-truth",
            "check_operational_truth_runtime.py",
            "REQUIRED_TABLES",
            "run_daily_operational_loop",
            "run_paper_rehearsal",
            "dashboard_persisted_source",
            "signals_fail_closed_in_replay",
            "real_execution_blocked",
            "model_lab_training_examples",
            "live_api_calls == 0",
        ],
    )
    return errors


def main() -> int:
    config = ROOT / "infra/cloudflare/tunnel-config.example.yml"
    schema = ROOT / "infra/schema.sql"
    env = ROOT / ".env.example"
    openclaw_skill = ROOT / "openclaw/skills/tennis-edge-ops/SKILL.md"
    openclaw_script = ROOT / "openclaw/skills/tennis-edge-ops/scripts/tennis_edge_ops.mjs"
    openclaw_policy = ROOT / "openclaw/openclaw.autopilot.example.json"

    errors: list[str] = []
    if "api.edge.example.com" not in config.read_text():
        errors.append("Cloudflare API hostname example missing")
    if "edge.example.com" not in config.read_text():
        errors.append("Cloudflare dashboard hostname example missing")
    cloudflare_errors = validate_cloudflare_private_runtime(
        tunnel_config=config.read_text(),
        env={
            "PRIVATE_ALLOWED_EMAILS": "operator@example.com",
            "ADMIN_API_TOKEN": "local-admin",
            "TENNIS_EDGE_CORS_ORIGIN": "http://localhost:3000,https://edge.example.com",
        },
        require_real_hosts=False,
    )
    errors.extend(f"Cloudflare example invalid: {error}" for error in cloudflare_errors)
    schema_text = schema.read_text()
    for duplicate_column in duplicate_schema_columns(schema_text):
        errors.append(f"Schema duplicate column {duplicate_column}")
    errors.extend(validate_api_last_core_contract(ROOT))
    for table in [
        "raw_provider_payloads",
        "point_events",
        "market_suspensions",
        "provider_latency",
        "model_versions",
        "paper_orders",
        "execution_orders",
        "bankroll_snapshots",
        "learning_runs",
        "model_promotion_decisions",
        "execution_audit_events",
        "provider_cursors",
        "data_quality_snapshots",
        "canonical_entity_conflicts",
        "paper_fills",
        "paper_settlements",
        "closing_line_snapshots",
        "training_examples",
        "calibration_reports",
    ]:
        if table not in schema_text:
            errors.append(f"Schema missing {table}")
    env_text = env.read_text()
    for key in [
        "SPORTRADAR_API_KEY",
        "BETRADAR_UOF_TOKEN",
        "TXODDS_USER",
        "TXODDS_PASSWORD",
        "THE_ODDS_API_KEY",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "PRIVATE_ALLOWED_EMAILS",
        "ADMIN_API_TOKEN",
        "EXECUTION_VENUE=betfair",
        "EXECUTION_STAGE=paper",
        "BANKROLL_BASE_CURRENCY",
        "BETFAIR_APP_KEY",
        "BETFAIR_USERNAME",
        "BETFAIR_CERT_PATH",
        "BETFAIR_KEY_PATH",
        "BETFAIR_PASSWORD_SECRET_REF",
        "BETFAIR_LIVE_KEY_APPROVED=false",
        "REAL_EXECUTION_HARD_BLOCK=true",
        "MODEL_CHAMPION_VERSION=baseline_v0",
        "MIN_PAPER_SIGNALS_FOR_REAL_REVIEW=500",
        "MIN_PAPER_DAYS_FOR_REAL_REVIEW=60",
        "ODDS_WS_RESYNC_REQUIRED_BLOCKS_SIGNALS=true",
        "MODEL_PROMOTION_REQUIRE_CLV=true",
        "OPENCLAW_AUTOPILOT_ENABLED=true",
        "OPENCLAW_TRIAGE_MODEL=gpt-5.4-mini",
        "OPENCLAW_CRITICAL_MODEL=gpt-5.5",
        "OPENCLAW_ROUTER_POLICY=cost_optimized",
        "TENNIS_EDGE_CORS_ORIGIN",
        "TENNIS_EDGE_RUNTIME_PROFILE=lean_atp",
        "TENNIS_EDGE_COVERAGE=atp_main,grand_slam_men,grand_slam_women",
        "TENNIS_EDGE_MONTHLY_BUDGET_USD=500",
        "ENTERPRISE_FEEDS_ENABLED=false",
        "EXECUTION_ENABLED=false",
    ]:
        if key not in env_text:
            errors.append(f".env.example missing {key}")
    if os.environ.get("EXECUTION_ENABLED", "false").lower() != "false":
        errors.append("EXECUTION_ENABLED must remain false for budget v1")
    if os.environ.get("REAL_EXECUTION_HARD_BLOCK", "true").lower() != "true":
        errors.append("REAL_EXECUTION_HARD_BLOCK must remain true for paper-first budget phase")
    for path in [openclaw_skill, openclaw_script, openclaw_policy]:
        if not path.exists():
            errors.append(f"OpenClaw artifact missing {path.relative_to(ROOT)}")
    if openclaw_script.exists():
        script_text = openclaw_script.read_text()
        for forbidden in ["readFileSync", "readFile(", "betfair.com", "placeOrders"]:
            if forbidden in script_text:
                errors.append(f"OpenClaw script contains forbidden reference {forbidden}")
    if openclaw_policy.exists():
        policy_text = openclaw_policy.read_text()
        for required in ["\"critical_model\": \"gpt-5.5\"", "\"allow_betfair_direct_api\": false"]:
            if required not in policy_text:
                errors.append(f"OpenClaw policy missing {required}")

    if errors:
        sys.stderr.write("\n".join(errors) + "\n")
        return 1
    print("private runtime checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

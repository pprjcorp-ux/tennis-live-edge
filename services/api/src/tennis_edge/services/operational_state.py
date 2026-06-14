from __future__ import annotations

from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    ApiOnboardingSnapshot,
    ApiOnboardingStep,
    ApiOnboardingStatus,
    BacktestRunRequest,
    CostProfile,
    DailyCostReport,
    DataQualitySnapshot,
    ExecutionStatus,
    IngestionRunRecord,
    LiveReadinessCheck,
    LiveReadinessSnapshot,
    MatchAnalysis,
    ModelLabReadinessSnapshot,
    OperationalStateSnapshot,
    OperationalSourceSummary,
    PaperPerformance,
    Provider,
    ProviderCursor,
    ProviderHealth,
    ProviderModeStep,
    ReplayContractProvider,
    ReplayProviderContractEvidence,
    ReplayContractScenarioEvidence,
    ReplayLabSnapshot,
)
from tennis_edge.services.cost_profile import (
    cost_profile,
    daily_cost_report,
)
from tennis_edge.services.enterprise_analytics import data_quality_snapshots
from tennis_edge.services.execution_engine import execution_status
from tennis_edge.services.provider_adapters import BUDGET_PROVIDER_CONTRACT_SPECS
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.storage import PersistentStore


def _replay_contract_scenarios(summary: dict) -> list[str]:
    scenario_rows = summary.get("scenarios")
    if not isinstance(scenario_rows, list):
        return []
    scenarios: list[str] = []
    for row in scenario_rows:
        if not isinstance(row, dict):
            continue
        scenario = row.get("scenario")
        if isinstance(scenario, str):
            scenarios.append(scenario)
    return scenarios


def _summary_int(row: dict, key: str) -> int:
    value = row.get(key)
    return value if isinstance(value, int) else 0


def _latest_ingestion_run(
    runs: list[IngestionRunRecord],
    *,
    run_type: str,
    run_kind: str | None = None,
) -> IngestionRunRecord | None:
    matching = [
        run
        for run in runs
        if run.run_type == run_type
        and (run_kind is None or run.summary.get("run_kind") == run_kind)
    ]
    return max(matching, key=lambda run: run.completed_at, default=None)


def _smoke_completed(run: IngestionRunRecord | None) -> bool:
    return run is not None and run.status == "completed"


def _replay_contract_persistence(
    summary: dict,
) -> list[ReplayContractScenarioEvidence]:
    scenario_rows = summary.get("scenarios")
    if not isinstance(scenario_rows, list):
        return []
    evidence: list[ReplayContractScenarioEvidence] = []
    for row in scenario_rows:
        if not isinstance(row, dict):
            continue
        scenario = row.get("scenario")
        if scenario not in {"healthy", "gap", "resync_required"}:
            continue
        evidence.append(
            ReplayContractScenarioEvidence(
                scenario=scenario,
                final_status=str(row.get("final_status") or "unknown"),
                passed=bool(row.get("passed") is True),
                provider_contracts=_provider_contract_evidence(row),
                raw_payloads_saved=_summary_int(row, "raw_payloads_saved"),
                score_ticks_saved=_summary_int(row, "score_ticks_saved"),
                odds_ticks_saved=_summary_int(row, "odds_ticks_saved"),
                provider_cursors_replayed=_summary_int(
                    row,
                    "provider_cursors_replayed",
                )
                or (
                    len(row["provider_cursors"])
                    if isinstance(row.get("provider_cursors"), list)
                    else 0
                ),
                cursors_saved=_summary_int(row, "cursors_saved"),
                provider_latency_saved=_summary_int(row, "provider_latency_saved"),
                resync_required=bool(row.get("resync_required") is True),
            )
        )
    return evidence


def _provider_contract_evidence(row: dict) -> list[ReplayProviderContractEvidence]:
    contract_rows = row.get("provider_contracts")
    if not isinstance(contract_rows, list):
        return []
    evidence: list[ReplayProviderContractEvidence] = []
    for contract in contract_rows:
        if not isinstance(contract, dict):
            continue
        try:
            evidence.append(ReplayProviderContractEvidence.model_validate(contract))
        except ValueError:
            continue
    return evidence


class OperationalStateService:
    def __init__(self, settings: Settings, store: PersistentStore) -> None:
        self.settings = settings
        self.store = store

    def provider_health(self) -> list[ProviderHealth]:
        return self.store.provider_health()

    def cost_profile(self) -> CostProfile:
        return cost_profile(self.settings)

    def daily_cost_report(
        self,
        target_date: date,
        analyses: list[MatchAnalysis],
        paper_performance: PaperPerformance,
    ) -> DailyCostReport:
        provider_usage_counts = getattr(
            self.store,
            "provider_usage_counts",
            lambda _target_date: {},
        )(target_date)
        odds_stream_usage = getattr(
            self.store,
            "odds_stream_usage",
            lambda _target_date: {},
        )(target_date)
        return daily_cost_report(
            self.settings,
            analyses,
            paper_performance,
            provider_usage_counts=provider_usage_counts,
            provider_websocket_minutes=odds_stream_usage.get(
                "provider_websocket_minutes",
                {},
            ),
            websocket_uptime_pct=odds_stream_usage.get("websocket_uptime_pct"),
        )

    def data_quality(self) -> list[DataQualitySnapshot]:
        persisted = self.store.data_quality()
        if persisted:
            return persisted
        if self.settings.data_mode == "sample":
            return data_quality_snapshots(self.settings)
        return []

    def provider_cursors(self) -> list[ProviderCursor]:
        persisted = self.store.provider_cursors()
        defaults_by_key = {
            (cursor.provider, cursor.stream): cursor
            for cursor in self.fallback_provider_cursors()
        }
        for cursor in persisted:
            defaults_by_key[(cursor.provider, cursor.stream)] = cursor
        return sorted(defaults_by_key.values(), key=lambda item: (item.provider, item.stream))

    def fallback_provider_cursors(self) -> list[ProviderCursor]:
        return default_provider_cursors(
            self.settings,
            use_process_cache=False,
        )

    def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self.store.ingestion_runs()

    def execution_status(self) -> ExecutionStatus:
        kill_switch_state = getattr(self.store, "kill_switch_state", lambda: None)()
        persistence_issue = getattr(self.store, "last_error", None)
        if (
            kill_switch_state is None
            and self.settings.data_mode != "sample"
        ):
            if (
                persistence_issue
                or not self.settings.persistence_enabled
                or not self.settings.database_url
            ):
                reason = persistence_issue or "kill switch persistence is not configured"
                kill_switch_state = {
                    "enabled": True,
                    "reason": f"kill switch state unavailable: {reason}",
                }
            else:
                kill_switch_state = {"enabled": False, "reason": "not set"}
        return execution_status(self.settings, kill_switch_state)

    def provider_mode(self) -> tuple[str, str]:
        if self.settings.data_mode == "sample":
            return (
                "sample",
                "Runtime uses bundled deterministic sample fixtures; no paid provider calls are required.",
            )
        if self.settings.data_mode == "replay":
            return (
                "replay",
                "Replay mode is selected; budget replay fixtures act as fake provider APIs and no paid provider calls are allowed.",
            )
        if self.settings.api_tennis_key and self.settings.odds_api_io_key:
            return (
                "live_with_keys",
                "API-Tennis and Odds-API.io keys are configured; live provider ingestion can run when cursors and persistence are healthy.",
            )
        has_replay_activity = getattr(self.store, "has_replay_activity", lambda: False)()
        if has_replay_activity:
            return (
                "replay",
                "Persisted replay score or odds feeds are available; dashboard can validate the pipeline without live provider keys.",
            )
        return (
            "live_without_keys",
            "Live mode is selected, but required score or odds provider keys are missing; entries remain blocked.",
        )

    def provider_mode_matrix(
        self,
        *,
        active_mode: str | None = None,
        provider_health: list[ProviderHealth] | None = None,
        provider_cursors: list[ProviderCursor] | None = None,
        data_quality: list[DataQualitySnapshot] | None = None,
    ) -> list[ProviderModeStep]:
        mode = active_mode or self.provider_mode()[0]
        persistence_ready, persistence_error = self._persistence_ready()
        explicit_replay = self.settings.data_mode == "replay"
        replay_available = explicit_replay or getattr(self.store, "has_replay_activity", lambda: False)()
        score_key_configured = bool(self.settings.api_tennis_key)
        odds_key_configured = bool(self.settings.odds_api_io_key)
        provider_cursors = provider_cursors if provider_cursors is not None else self.provider_cursors()
        provider_health = provider_health if provider_health is not None else self.provider_health()
        data_quality = data_quality if data_quality is not None else self.data_quality()
        cursor_resync = any(cursor.resync_required for cursor in provider_cursors)
        critical_provider_failures = [
            health
            for health in provider_health
            if health.provider in {Provider.API_TENNIS, Provider.ODDS_API_IO}
            and not health.healthy
        ]
        data_quality_failures = [
            snapshot
            for snapshot in data_quality
            if snapshot.stale_ticks > 0 or snapshot.blocked_signals > 0
        ]
        live_key_blockers = []
        if not score_key_configured:
            live_key_blockers.append("API_TENNIS_KEY missing")
        if not odds_key_configured:
            live_key_blockers.append("ODDS_API_IO_KEY missing")
        if not persistence_ready:
            live_key_blockers.append(persistence_error or "persistent store unavailable")
        if cursor_resync:
            live_key_blockers.append("provider cursor requires resync")
        live_operational_blockers = list(live_key_blockers)
        live_operational_blockers.extend(
            f"{health.provider.value} unhealthy: {health.status}"
            for health in critical_provider_failures
        )
        live_operational_blockers.extend(
            f"{snapshot.provider.value}/{snapshot.feed} data quality blocks entries"
            for snapshot in data_quality_failures
        )

        sample_active = mode == "sample"
        replay_active = mode == "replay"
        live_without_keys_active = mode == "live_without_keys"
        live_with_keys_active = mode == "live_with_keys"
        live_with_keys_ready = not live_operational_blockers

        return [
            ProviderModeStep(
                mode="sample",
                active=sample_active,
                status="active" if sample_active else "deferred",
                entry_gate="monitor",
                summary="Bundled deterministic fixtures; no paid providers or live claims.",
                evidence=[
                    f"TENNIS_EDGE_DATA_MODE={self.settings.data_mode}",
                    "Sample data is safe for UI/model smoke only.",
                ],
                blockers=[] if sample_active else ["Not the selected runtime mode."],
                next_action="Use only for local development; do not treat sample signals as live.",
            ),
            ProviderModeStep(
                mode="replay",
                active=replay_active,
                status="active" if replay_active else ("ready" if replay_available else "blocked"),
                entry_gate="monitor",
                summary="Persisted replay score/odds feeds validate provider contracts without live keys.",
                evidence=[
                    (
                        "Replay runtime selected; fixture-backed provider contracts are available without live keys."
                        if explicit_replay
                        else "Persisted replay activity found."
                        if replay_available
                        else "No persisted replay activity yet."
                    ),
                    "Replay entries stay monitor-only until live providers are configured.",
                ],
                blockers=[] if replay_available else ["Run /api/v1/replay/run with use_fixture_seed=true."],
                next_action=(
                    "Review Replay Lab and cursor output before adding API keys."
                    if replay_available
                    else "Run an explicit fixture-seeded replay."
                ),
            ),
            ProviderModeStep(
                mode="live_without_keys",
                active=live_without_keys_active,
                status="active" if live_without_keys_active else "blocked",
                entry_gate="block",
                summary="Live mode selected, but budget score/odds keys are incomplete.",
                evidence=[
                    "API-Tennis key configured." if score_key_configured else "API-Tennis key missing.",
                    "Odds-API.io key configured." if odds_key_configured else "Odds-API.io key missing.",
                ],
                blockers=[
                    blocker
                    for blocker in ["API_TENNIS_KEY missing", "ODDS_API_IO_KEY missing"]
                    if blocker in live_key_blockers
                ],
                next_action="Add APIs one at a time after replay remains green.",
            ),
            ProviderModeStep(
                mode="live_with_keys",
                active=live_with_keys_active,
                status=(
                    "active"
                    if live_with_keys_active
                    else ("ready" if live_with_keys_ready else "blocked")
                ),
                entry_gate="allow" if live_with_keys_ready else "block",
                summary="Budget live providers are configured; signal gates still enforce freshness and cursor health.",
                evidence=[
                    "API-Tennis key configured." if score_key_configured else "API-Tennis key missing.",
                    "Odds-API.io key configured." if odds_key_configured else "Odds-API.io key missing.",
                    "Postgres persistence ready." if persistence_ready else f"Persistence blocked: {persistence_error}",
                    "Provider cursors trusted." if not cursor_resync else "At least one provider cursor requires resync.",
                    (
                        "Critical provider health clean."
                        if not critical_provider_failures
                        else f"{len(critical_provider_failures)} critical provider health failure(s)."
                    ),
                    (
                        "Data freshness gates clean."
                        if not data_quality_failures
                        else f"{len(data_quality_failures)} data freshness/blocking issue(s)."
                    ),
                ],
                blockers=live_operational_blockers,
                next_action=(
                    "Run live ingestion and let signal gates decide Entrada."
                    if live_with_keys_ready
                    else "Clear keys, persistence, cursor, provider health, and data freshness blockers before live entries."
                ),
            ),
        ]

    def _persistence_ready(self) -> tuple[bool, str | None]:
        persistence_error = getattr(self.store, "last_error", None)
        ready = (
            self.settings.persistence_enabled
            and bool(self.settings.database_url)
            and not persistence_error
        )
        if ready:
            return True, None
        if persistence_error:
            return False, persistence_error
        if self.settings.persistence_enabled:
            return False, "DATABASE_URL is missing."
        return False, "TENNIS_EDGE_PERSISTENCE_ENABLED=false"

    def _training_example_count(
        self,
        request: BacktestRunRequest | None = None,
    ) -> int:
        counter = getattr(
            self.store,
            "training_example_count",
            lambda *_args, **_kwargs: 0,
        )
        try:
            return int(counter(request))
        except TypeError:
            return int(counter())

    def _training_example_lineage_counts(
        self,
        request: BacktestRunRequest | None = None,
    ) -> dict[str, int]:
        counter = getattr(self.store, "training_example_lineage_counts", None)
        if callable(counter):
            try:
                counts = counter(request)
            except TypeError:
                counts = counter()
            return {
                "total": int(counts.get("total", 0)),
                "production": int(counts.get("production", 0)),
                "rehearsal": int(counts.get("rehearsal", 0)),
            }
        total = self._training_example_count()
        return {"total": total, "production": total, "rehearsal": 0}

    def model_lab_readiness(self) -> ModelLabReadinessSnapshot:
        default_request = BacktestRunRequest()
        request = BacktestRunRequest(
            model_version=(
                self.settings.model_champion_version
                if self.settings.model_champion_version != "baseline_v0"
                else default_request.model_version
            ),
            feature_set=default_request.feature_set,
        )
        persistence_ready, persistence_detail = self._persistence_ready()
        lineage_counts = {"total": 0, "production": 0, "rehearsal": 0}
        examples = self._training_example_count(request) if persistence_ready else 0
        if persistence_ready:
            lineage_counts = self._training_example_lineage_counts(request)
        if persistence_ready:
            persistence_detail = getattr(self.store, "last_error", None)
            if persistence_detail:
                persistence_ready = False
                examples = 0
                lineage_counts = {"total": 0, "production": 0, "rehearsal": 0}
        reasons: list[str] = []
        if not persistence_ready:
            reasons.append(
                f"Postgres persistence is required before live Model Lab backtests. {persistence_detail}"
            )
        if examples <= 0:
            reasons.append(
                "No settled persisted training_examples are available for this model_version/feature_set."
            )
        if lineage_counts["rehearsal"] > 0 and examples <= 0:
            reasons.append(
                "Only rehearsal training_examples are present; they stay excluded from production Model Lab evidence."
            )
        can_run = persistence_ready and examples > 0
        return ModelLabReadinessSnapshot(
            status="ready" if can_run else "collecting" if persistence_ready else "blocked",
            source="training_examples",
            model_version=request.model_version,
            feature_set=request.feature_set,
            training_examples=examples,
            total_training_examples=lineage_counts["total"],
            production_training_examples=lineage_counts["production"],
            rehearsal_training_examples=lineage_counts["rehearsal"],
            can_run_live_backtest=can_run,
            reasons=reasons,
        )

    def replay_lab_readiness(self) -> ReplayLabSnapshot:
        ingestion_runs = self.ingestion_runs()
        replay_runs = [run for run in ingestion_runs if run.run_type == "replay_run"]
        contract_runs = [
            run for run in ingestion_runs if run.run_type == "replay_contract_run"
        ]
        last_run = replay_runs[0] if replay_runs else None
        last_contract = contract_runs[0] if contract_runs else None
        last_summary = last_run.summary if last_run else {}
        last_contract_summary = last_contract.summary if last_contract else {}
        last_contract_passed = bool(last_contract_summary.get("passed") is True)
        last_contract_scenarios = _replay_contract_scenarios(last_contract_summary)
        last_contract_persistence = _replay_contract_persistence(
            last_contract_summary
        )
        providers = [
            ReplayContractProvider(
                provider=spec.provider,
                adapter_contract=spec.adapter_contract,
                fake_api=spec.fake_api,
                input_contracts=list(spec.input_contracts),
                output_contracts=list(spec.output_contracts),
                scenarios=list(spec.scenarios),
                status=spec.status,
                notes=list(spec.notes),
            )
            for spec in BUDGET_PROVIDER_CONTRACT_SPECS
        ]
        notes = [
            "Replay fixtures are the fake API layer; live provider keys are not required.",
            "Run healthy, gap, and resync_required odds scenarios before enabling live websocket ingestion.",
        ]
        if last_contract is None:
            notes.append("No persisted replay_contract_run has been recorded yet.")
        elif not last_contract_passed:
            notes.append("Last replay_contract_run did not pass; keep paid provider onboarding blocked.")
        if last_run is None:
            notes.append("No persisted replay_run has been recorded yet.")
        return ReplayLabSnapshot(
            status=(
                "ready"
                if last_contract_passed
                else "blocked"
                if last_contract is not None
                else "collecting"
            ),
            source="budget_replay_fixtures",
            providers=providers,
            scenarios=["healthy", "gap", "resync_required"],
            last_contract_run_id=last_contract.id if last_contract else None,
            last_contract_status=last_contract.status if last_contract else None,
            last_contract_passed=last_contract_passed,
            last_contract_scenarios=last_contract_scenarios,
            last_contract_persistence=last_contract_persistence,
            last_replay_run_id=last_run.id if last_run else None,
            last_replay_status=last_run.status if last_run else None,
            last_replay_events=int(last_summary.get("events_replayed") or 0),
            last_replay_score_ticks=int(last_summary.get("score_ticks") or 0),
            last_replay_odds_ticks=int(last_summary.get("odds_ticks") or 0),
            last_replay_resync_required=bool(last_summary.get("resync_required") is True),
            can_validate_without_live_keys=True,
            notes=notes,
        )

    def api_onboarding(self) -> ApiOnboardingSnapshot:
        core_ready, persistence_error = self._persistence_ready()
        replay_lab = self.replay_lab_readiness()
        replay_contract_ready = replay_lab.last_contract_passed
        ingestion_runs = self.ingestion_runs()
        archive_smoke = _latest_ingestion_run(
            ingestion_runs,
            run_type="archive_odds_sync",
            run_kind="archive_odds_sync",
        )
        score_smoke = _latest_ingestion_run(
            ingestion_runs,
            run_type="score_snapshot",
            run_kind="api_tennis_score_sync",
        )
        odds_stream_smoke = _latest_ingestion_run(
            ingestion_runs,
            run_type="odds_stream",
        )
        archive_smoke_completed = _smoke_completed(archive_smoke)
        score_smoke_completed = _smoke_completed(score_smoke)
        odds_stream_smoke_completed = _smoke_completed(odds_stream_smoke)
        warnings: list[str] = []
        if not core_ready:
            warnings.append(
                "Postgres/Timescale operational truth must be healthy before enabling more provider calls."
            )
            if persistence_error:
                warnings.append(persistence_error)
        if not replay_contract_ready:
            warnings.append(
                "Run /api/v1/replay/contracts/run and keep all replay contracts passing before enabling paid provider keys."
            )

        odds_cursor_resync = any(
            cursor.provider == Provider.ODDS_API_IO and cursor.resync_required
            for cursor in self.provider_cursors()
        )
        if odds_cursor_resync:
            warnings.append(
                "Odds-API.io websocket cursor requires resync; keep entries blocked until replay/resync passes."
            )

        the_odds_api_configured = bool(self.settings.the_odds_api_key)
        api_tennis_configured = bool(self.settings.api_tennis_key)
        odds_api_io_configured = bool(self.settings.odds_api_io_key)
        enterprise_configured = (
            bool(self.settings.sportradar_api_key)
            and bool(self.settings.betradar_uof_token)
            and bool(self.settings.txodds_user)
            and bool(self.settings.txodds_password)
        )
        archive_prerequisites_ready = core_ready and replay_contract_ready
        score_prerequisites_ready = (
            archive_prerequisites_ready
            and the_odds_api_configured
            and archive_smoke_completed
        )
        odds_prerequisites_ready = (
            score_prerequisites_ready
            and api_tennis_configured
            and score_smoke_completed
        )
        budget_chain_completed = (
            odds_prerequisites_ready
            and odds_api_io_configured
            and odds_stream_smoke_completed
            and not odds_cursor_resync
        )
        enterprise_eligible = (
            budget_chain_completed and self.settings.enterprise_feeds_enabled
        )

        def setup_status(
            *,
            configured: bool,
            prerequisites_met: bool,
            deferred: bool = False,
        ) -> ApiOnboardingStatus:
            if deferred:
                return "deferred"
            if configured:
                return "configured"
            if core_ready and prerequisites_met:
                return "ready_next"
            return "blocked"

        def enterprise_setup_status() -> ApiOnboardingStatus:
            if not self.settings.enterprise_feeds_enabled:
                return "deferred"
            if not budget_chain_completed:
                return "blocked"
            if enterprise_configured:
                return "configured"
            return "ready_next"

        steps = [
            ApiOnboardingStep(
                order=1,
                provider=Provider.THE_ODDS_API,
                capability="archive_odds",
                configured=the_odds_api_configured,
                status=setup_status(
                    configured=the_odds_api_configured,
                    prerequisites_met=replay_contract_ready,
                ),
                last_smoke_status=archive_smoke.status if archive_smoke else None,
                last_smoke_at=archive_smoke.completed_at if archive_smoke else None,
                smoke_completed=archive_smoke_completed,
                required_before_enable=[]
                if core_ready and replay_contract_ready
                else [
                    requirement
                    for requirement, satisfied in [
                        ("Healthy Postgres/Timescale persistence", core_ready),
                        ("Passing replay contract run", replay_contract_ready),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Complete replay contracts before running TheOddsAPI archive smoke."
                    if the_odds_api_configured and not archive_prerequisites_ready
                    else "Run TheOddsAPI archive-sync smoke and confirm persisted payload evidence."
                    if the_odds_api_configured and not archive_smoke_completed
                    else "Keep as REST archive/comparison and never override fresher persisted live odds."
                    if the_odds_api_configured
                    else "Run replay contracts first, then set THE_ODDS_API_KEY and run an archive snapshot smoke check."
                ),
                notes=[
                    "Lowest-risk paid provider to connect first because it is REST/archive, not live decisioning."
                ],
            ),
            ApiOnboardingStep(
                order=2,
                provider=Provider.API_TENNIS,
                capability="score_livescore",
                configured=api_tennis_configured,
                status=setup_status(
                    configured=api_tennis_configured,
                    prerequisites_met=score_prerequisites_ready,
                ),
                last_smoke_status=score_smoke.status if score_smoke else None,
                last_smoke_at=score_smoke.completed_at if score_smoke else None,
                smoke_completed=score_smoke_completed,
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Healthy Postgres/Timescale persistence", core_ready),
                        ("Passing replay contract run", replay_contract_ready),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                        ("TheOddsAPI archive smoke completed", archive_smoke_completed),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Complete TheOddsAPI archive smoke before API-Tennis score smoke."
                    if api_tennis_configured and not score_prerequisites_ready
                    else "Run API-Tennis score-sync smoke and confirm fixture/score payload evidence."
                    if api_tennis_configured and not score_smoke_completed
                    else "Run API-Tennis fixtures/livescore ingestion and verify score ticks plus freshness."
                    if api_tennis_configured
                    else "Set API_TENNIS_KEY after archive odds are stable; keep signals monitor-only until score state is valid."
                ),
                notes=[
                    "Score/livescore becomes the primary match state feed for ATP main and Grand Slam singles."
                ],
            ),
            ApiOnboardingStep(
                order=3,
                provider=Provider.ODDS_API_IO,
                capability="live_odds_websocket",
                configured=odds_api_io_configured,
                status=(
                    "blocked"
                    if odds_api_io_configured and odds_cursor_resync
                    else setup_status(
                        configured=odds_api_io_configured,
                        prerequisites_met=(
                            odds_prerequisites_ready
                        ),
                    )
                ),
                last_smoke_status=(
                    odds_stream_smoke.status if odds_stream_smoke else None
                ),
                last_smoke_at=(
                    odds_stream_smoke.completed_at if odds_stream_smoke else None
                ),
                smoke_completed=odds_stream_smoke_completed,
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Healthy Postgres/Timescale persistence", core_ready),
                        ("Passing replay contract run", replay_contract_ready),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                        ("TheOddsAPI archive smoke completed", archive_smoke_completed),
                        ("API-Tennis score/livescore configured", api_tennis_configured),
                        ("API-Tennis score smoke completed", score_smoke_completed),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Complete API-Tennis score smoke before Odds-API.io stream smoke."
                    if odds_api_io_configured and not odds_prerequisites_ready
                    else "Run Odds-API.io stream-smoke and confirm cursor/odds payload evidence."
                    if odds_api_io_configured and not odds_stream_smoke_completed
                    else "Run websocket replay/resync smoke before allowing live entries."
                    if odds_api_io_configured
                    else "Set ODDS_API_IO_KEY last among budget feeds; validate seq/lastSeq, gaps and stale odds gates."
                ),
                notes=[
                    "Most fragile budget feed because entries depend on fresh moneyline odds and trusted cursor state."
                ],
            ),
            ApiOnboardingStep(
                order=4,
                provider=Provider.SPORTRADAR,
                capability="enterprise_feeds",
                configured=enterprise_configured,
                status=enterprise_setup_status(),
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Enable ENTERPRISE_FEEDS_ENABLED only after budget paper proof", self.settings.enterprise_feeds_enabled),
                        ("Budget provider chain complete", budget_chain_completed),
                        ("Passing replay contract run", replay_contract_ready),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                        ("TheOddsAPI archive smoke completed", archive_smoke_completed),
                        ("API-Tennis score/livescore configured", api_tennis_configured),
                        ("API-Tennis score smoke completed", score_smoke_completed),
                        ("Odds-API.io websocket configured", odds_api_io_configured),
                        ("Odds-API.io stream smoke completed", odds_stream_smoke_completed),
                        ("Odds-API.io cursor healthy", not odds_cursor_resync),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Keep Sportradar/Betradar/TXODDS deferred until budget paper data proves a latency or coverage bottleneck."
                    if not self.settings.enterprise_feeds_enabled
                    else "Validate enterprise contracts through the same provider adapter and replay contracts."
                ),
                notes=[
                    "Enterprise feeds must enter through the same RawProviderPayload, tick and cursor contracts."
                ],
            ),
        ]

        def needs_smoke(step: ApiOnboardingStep) -> bool:
            if not step.configured or step.last_smoke_status == "completed":
                return False
            if step.provider == Provider.THE_ODDS_API:
                return archive_prerequisites_ready
            if step.provider == Provider.API_TENNIS:
                return score_prerequisites_ready
            if step.provider == Provider.ODDS_API_IO:
                return odds_prerequisites_ready
            return False

        current = next((step for step in steps if needs_smoke(step)), None) or next(
            (step for step in steps if step.status in {"ready_next", "blocked"}),
            None,
        )
        steps = [
            step.model_copy(update={"current": bool(current and step.order == current.order)})
            for step in steps
        ]
        return ApiOnboardingSnapshot(
            core_ready=core_ready,
            current_step=(
                f"{current.order}. {current.provider}:{current.capability}"
                if current
                else "enterprise_stack_configured"
                if enterprise_eligible and enterprise_configured
                else "budget_stack_configured_enterprise_deferred"
            ),
            budget_chain_completed=budget_chain_completed,
            enterprise_eligible=enterprise_eligible,
            steps=steps,
            warnings=warnings,
        )

    def source_summary(self, analyses: list[MatchAnalysis]) -> OperationalSourceSummary:
        source_counts: dict[str, int] = {}
        provider_values: set[Provider] = set()
        persisted_matches = 0
        match_freshness = []
        for analysis in analyses:
            freshness = analysis.freshness
            source = freshness.source if freshness else "sample"
            source_counts[source] = source_counts.get(source, 0) + 1
            if freshness and freshness.persisted:
                persisted_matches += 1
            if freshness:
                provider_values.update(freshness.provider_lineage)
            match_freshness.append(
                {
                    "match_id": analysis.match.id,
                    "source": source,
                    "persisted": bool(freshness and freshness.persisted),
                    "score_age_ms": freshness.score_age_ms if freshness else None,
                    "odds_age_ms": freshness.odds_age_ms if freshness else None,
                    "provider_lineage": freshness.provider_lineage if freshness else [],
                    "note": freshness.note if freshness else "No freshness metadata was attached.",
                }
            )

        total_matches = len(analyses)
        volatile_matches = max(0, total_matches - persisted_matches)
        if not total_matches:
            note = "No matches loaded from live, replay, persisted fallback, or sample sources."
        elif volatile_matches:
            note = (
                f"{persisted_matches}/{total_matches} matches are backed by persisted state; "
                f"{volatile_matches} are runtime-only."
            )
        else:
            note = f"All {total_matches} loaded matches are backed by persisted state."
        return OperationalSourceSummary(
            total_matches=total_matches,
            persisted_matches=persisted_matches,
            volatile_matches=volatile_matches,
            source_counts=source_counts,
            provider_lineage=sorted(provider_values, key=lambda provider: provider.value),
            match_freshness=match_freshness,
            note=note,
        )

    def snapshot(
        self,
        *,
        cost_report: DailyCostReport,
        analyses: list[MatchAnalysis] | None = None,
    ) -> OperationalStateSnapshot:
        provider_mode, provider_mode_reason = self.provider_mode()
        provider_health = self.provider_health()
        data_quality = self.data_quality()
        provider_cursors = self.provider_cursors()
        return OperationalStateSnapshot(
            provider_mode=provider_mode,
            provider_mode_reason=provider_mode_reason,
            provider_mode_matrix=self.provider_mode_matrix(
                active_mode=provider_mode,
                provider_health=provider_health,
                provider_cursors=provider_cursors,
                data_quality=data_quality,
            ),
            source_summary=self.source_summary(analyses or []),
            provider_health=provider_health,
            cost_profile=self.cost_profile(),
            daily_cost_report=cost_report,
            data_quality=data_quality,
            provider_cursors=provider_cursors,
            ingestion_runs=self.ingestion_runs(),
            execution_status=self.execution_status(),
            api_onboarding=self.api_onboarding(),
            model_lab=self.model_lab_readiness(),
            replay_lab=self.replay_lab_readiness(),
        )

    def live_readiness(
        self,
        operational_state: OperationalStateSnapshot,
    ) -> LiveReadinessSnapshot:
        data_mode_live = self.settings.data_mode == "live"
        score_key_configured = bool(self.settings.api_tennis_key)
        odds_key_configured = bool(self.settings.odds_api_io_key)
        odds_cursor_resync = any(
            cursor.provider == Provider.ODDS_API_IO and cursor.resync_required
            for cursor in operational_state.provider_cursors
        )
        critical_provider_health = [
            health
            for health in operational_state.provider_health
            if health.provider in {Provider.API_TENNIS, Provider.ODDS_API_IO}
        ]
        provider_health_failures = [
            health for health in critical_provider_health if not health.healthy
        ]
        data_quality_failures = [
            snapshot
            for snapshot in operational_state.data_quality
            if snapshot.stale_ticks > 0 or snapshot.blocked_signals > 0
        ]
        provider_health_ok = not provider_health_failures
        data_quality_ok = not data_quality_failures
        persistence_ready, persistence_error = self._persistence_ready()
        model_lab = operational_state.model_lab
        if persistence_ready:
            persistence_error = getattr(self.store, "last_error", None)
            if persistence_error or model_lab.status == "blocked":
                persistence_ready = False
        if persistence_ready:
            persistence_detail = None
        elif persistence_error:
            persistence_detail = persistence_error
        elif self.settings.persistence_enabled:
            persistence_detail = "DATABASE_URL is missing."
        else:
            persistence_detail = "TENNIS_EDGE_PERSISTENCE_ENABLED=false"
        can_analyze_live = data_mode_live and score_key_configured
        can_generate_entries = (
            can_analyze_live
            and odds_key_configured
            and not odds_cursor_resync
            and persistence_ready
            and provider_health_ok
            and data_quality_ok
        )
        can_submit_real_orders = operational_state.execution_status.can_submit_real_orders

        checks = [
            LiveReadinessCheck(
                name="data_mode",
                status="pass" if data_mode_live else "fail",
                summary="Live data mode is active."
                if data_mode_live
                else "Runtime is not in live data mode.",
                detail=(
                    None
                    if data_mode_live
                    else f"TENNIS_EDGE_DATA_MODE={self.settings.data_mode}"
                ),
            ),
            LiveReadinessCheck(
                name="score_provider",
                status="pass" if score_key_configured else "fail",
                summary="API-Tennis score key is configured."
                if score_key_configured
                else "API_TENNIS_KEY is missing.",
                detail="Required for live fixtures and score state.",
            ),
            LiveReadinessCheck(
                name="odds_provider",
                status="pass" if odds_key_configured else "fail",
                summary="Odds-API.io websocket key is configured."
                if odds_key_configured
                else "ODDS_API_IO_KEY is missing.",
                detail="Required for fresh live moneyline odds.",
            ),
            LiveReadinessCheck(
                name="odds_cursor",
                status="fail" if odds_cursor_resync else "pass",
                summary="Odds websocket cursor is trusted."
                if not odds_cursor_resync
                else "Odds websocket cursor requires resync before entries.",
                detail=None,
            ),
            LiveReadinessCheck(
                name="persistence",
                status="pass" if persistence_ready else "fail",
                summary="Postgres persistence is configured and healthy."
                if persistence_ready
                else "Postgres persistence is required for live operational truth.",
                detail=persistence_detail,
            ),
            LiveReadinessCheck(
                name="provider_health",
                status="pass" if provider_health_ok else "fail",
                summary=(
                    "Critical budget providers are healthy."
                    if provider_health_ok
                    else "Critical budget provider health is unhealthy or stale."
                ),
                detail=(
                    None
                    if provider_health_ok
                    else "; ".join(
                        f"{health.provider}: {health.status}"
                        for health in provider_health_failures
                    )
                ),
            ),
            LiveReadinessCheck(
                name="data_quality",
                status="pass" if data_quality_ok else "fail",
                summary=(
                    "Persisted data quality has no stale or blocking ticks."
                    if data_quality_ok
                    else "Persisted data quality reports stale or blocking provider ticks."
                ),
                detail=(
                    None
                    if data_quality_ok
                    else "; ".join(
                        f"{snapshot.provider}/{snapshot.feed}: stale_ticks={snapshot.stale_ticks}, blocked_signals={snapshot.blocked_signals}"
                        for snapshot in data_quality_failures
                    )
                ),
            ),
            LiveReadinessCheck(
                name="model_learning_dataset",
                status=(
                    "pass"
                    if model_lab.can_run_live_backtest
                    else "fail"
                    if model_lab.status == "blocked"
                    else "warn"
                ),
                summary=(
                    f"{model_lab.training_examples} settled production training examples available for {model_lab.model_version}/{model_lab.feature_set}."
                    if model_lab.can_run_live_backtest
                    else f"Only rehearsal training examples are available ({model_lab.rehearsal_training_examples}); production Model Lab is still collecting."
                    if model_lab.rehearsal_training_examples > 0
                    and model_lab.production_training_examples <= 0
                    else f"{model_lab.total_training_examples} settled training examples exist, but none match {model_lab.model_version}/{model_lab.feature_set}."
                    if model_lab.total_training_examples > 0
                    else "No settled persisted training examples are available yet."
                ),
                detail=(
                    None
                    if model_lab.can_run_live_backtest
                    else "; ".join(model_lab.reasons)
                    if model_lab.reasons
                    else "Live backtests and model promotion require settled production paper orders; /api/v1/backtests/run will return 409 until examples exist."
                    if persistence_ready and data_mode_live
                    else "Dataset count is unavailable until live persistence is healthy."
                ),
            ),
            LiveReadinessCheck(
                name="real_execution",
                status="pass" if not can_submit_real_orders else "warn",
                summary="Real execution is blocked as designed for paper-first mode."
                if not can_submit_real_orders
                else "Real execution can submit orders.",
                detail="Paper-first readiness does not require real order submission.",
            ),
        ]
        blockers = [check.summary for check in checks if check.status == "fail"]
        warnings = [check.summary for check in checks if check.status == "warn"]
        status = (
            "ready"
            if can_generate_entries
            else "degraded"
            if can_analyze_live
            else "blocked"
        )

        return LiveReadinessSnapshot(
            status=status,
            can_analyze_live=can_analyze_live,
            can_generate_entries=can_generate_entries,
            can_submit_real_orders=can_submit_real_orders,
            blockers=blockers,
            warnings=warnings,
            checks=checks,
        )

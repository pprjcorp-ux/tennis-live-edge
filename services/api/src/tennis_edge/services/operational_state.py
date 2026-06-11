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
    PaperPerformance,
    Provider,
    ProviderCursor,
    ProviderHealth,
    ProviderModeStep,
    ReplayContractProvider,
    ReplayLabSnapshot,
)
from tennis_edge.services.cost_profile import (
    cost_profile,
    daily_cost_report,
)
from tennis_edge.services.enterprise_analytics import data_quality_snapshots
from tennis_edge.services.execution_engine import execution_status
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.storage import PersistentStore


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
    ) -> list[ProviderModeStep]:
        mode = active_mode or self.provider_mode()[0]
        persistence_ready, persistence_error = self._persistence_ready()
        replay_available = getattr(self.store, "has_replay_activity", lambda: False)()
        score_key_configured = bool(self.settings.api_tennis_key)
        odds_key_configured = bool(self.settings.odds_api_io_key)
        cursor_resync = any(cursor.resync_required for cursor in self.provider_cursors())
        live_key_blockers = []
        if not score_key_configured:
            live_key_blockers.append("API_TENNIS_KEY missing")
        if not odds_key_configured:
            live_key_blockers.append("ODDS_API_IO_KEY missing")
        if not persistence_ready:
            live_key_blockers.append(persistence_error or "persistent store unavailable")
        if cursor_resync:
            live_key_blockers.append("provider cursor requires resync")

        sample_active = mode == "sample"
        replay_active = mode == "replay"
        live_without_keys_active = mode == "live_without_keys"
        live_with_keys_active = mode == "live_with_keys"
        live_with_keys_ready = not live_key_blockers

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
                    "Persisted replay activity found."
                    if replay_available
                    else "No persisted replay activity yet.",
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
                ],
                blockers=live_key_blockers,
                next_action=(
                    "Run live ingestion and let signal gates decide Entrada."
                    if live_with_keys_ready
                    else "Clear missing keys, persistence, and cursor blockers before live entries."
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
        examples = self._training_example_count(request) if persistence_ready else 0
        if persistence_ready:
            persistence_detail = getattr(self.store, "last_error", None)
            if persistence_detail:
                persistence_ready = False
                examples = 0
        reasons: list[str] = []
        if not persistence_ready:
            reasons.append(
                f"Postgres persistence is required before live Model Lab backtests. {persistence_detail}"
            )
        if examples <= 0:
            reasons.append(
                "No settled persisted training_examples are available for this model_version/feature_set."
            )
        can_run = persistence_ready and examples > 0
        return ModelLabReadinessSnapshot(
            status="ready" if can_run else "collecting" if persistence_ready else "blocked",
            source="training_examples",
            model_version=request.model_version,
            feature_set=request.feature_set,
            training_examples=examples,
            can_run_live_backtest=can_run,
            reasons=reasons,
        )

    def replay_lab_readiness(self) -> ReplayLabSnapshot:
        replay_runs = [run for run in self.ingestion_runs() if run.run_type == "replay_run"]
        last_run = replay_runs[0] if replay_runs else None
        last_summary = last_run.summary if last_run else {}
        providers = [
            ReplayContractProvider(
                provider=Provider.API_TENNIS,
                adapter_contract="ScoreProviderAdapter",
                fake_api="Simulated API-Tennis fixtures/livescore",
                input_contracts=["RawProviderPayload", "CanonicalMatch"],
                output_contracts=["ScoreTick", "ProviderLatency"],
                scenarios=["score_snapshot", "live_score_state"],
                status="covered",
                notes=["Budget replay emits API-Tennis score payloads without provider quota."],
            ),
            ReplayContractProvider(
                provider=Provider.ODDS_API_IO,
                adapter_contract="OddsProviderAdapter",
                fake_api="Simulated Odds-API.io websocket",
                input_contracts=["RawProviderPayload", "seq", "lastSeq"],
                output_contracts=["OddsTick", "ProviderCursor", "ProviderLatency"],
                scenarios=["healthy", "gap", "resync_required"],
                status="covered",
                notes=["Replay validates cursor gaps and resync_required before live websocket keys."],
            ),
            ReplayContractProvider(
                provider=Provider.THE_ODDS_API,
                adapter_contract="ArchiveOddsProviderAdapter",
                fake_api="Simulated TheOddsAPI REST snapshot",
                input_contracts=["RawProviderPayload"],
                output_contracts=["OddsTick", "ProviderLatency"],
                scenarios=["archive_snapshot"],
                status="covered",
                notes=["Archive odds replay is used as fallback/comparison before live providers."],
            ),
        ]
        notes = [
            "Replay fixtures are the fake API layer; live provider keys are not required.",
            "Run healthy, gap, and resync_required odds scenarios before enabling live websocket ingestion.",
        ]
        if last_run is None:
            notes.append("No persisted replay_run has been recorded yet.")
        return ReplayLabSnapshot(
            status="ready" if last_run else "collecting",
            source="budget_replay_fixtures",
            providers=providers,
            scenarios=["healthy", "gap", "resync_required"],
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
        warnings: list[str] = []
        if not core_ready:
            warnings.append(
                "Postgres/Timescale operational truth must be healthy before enabling more provider calls."
            )
            if persistence_error:
                warnings.append(persistence_error)

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

        steps = [
            ApiOnboardingStep(
                order=1,
                provider=Provider.THE_ODDS_API,
                capability="archive_odds",
                configured=the_odds_api_configured,
                status=setup_status(
                    configured=the_odds_api_configured,
                    prerequisites_met=True,
                ),
                required_before_enable=[]
                if core_ready
                else ["Healthy Postgres/Timescale persistence"],
                next_action=(
                    "Keep as REST archive/comparison and never override fresher persisted live odds."
                    if the_odds_api_configured
                    else "Set THE_ODDS_API_KEY and run an archive snapshot smoke check."
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
                    prerequisites_met=the_odds_api_configured,
                ),
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Healthy Postgres/Timescale persistence", core_ready),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Run API-Tennis fixtures/livescore ingestion and verify score ticks plus freshness."
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
                        prerequisites_met=the_odds_api_configured and api_tennis_configured,
                    )
                ),
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Healthy Postgres/Timescale persistence", core_ready),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                        ("API-Tennis score/livescore configured", api_tennis_configured),
                    ]
                    if not satisfied
                ],
                next_action=(
                    "Run websocket replay/resync smoke before allowing live entries."
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
                status=setup_status(
                    configured=enterprise_configured,
                    prerequisites_met=(
                        the_odds_api_configured
                        and api_tennis_configured
                        and odds_api_io_configured
                    ),
                    deferred=not self.settings.enterprise_feeds_enabled,
                ),
                required_before_enable=[
                    requirement
                    for requirement, satisfied in [
                        ("Enable ENTERPRISE_FEEDS_ENABLED only after budget paper proof", self.settings.enterprise_feeds_enabled),
                        ("TheOddsAPI archive/comparison configured", the_odds_api_configured),
                        ("API-Tennis score/livescore configured", api_tennis_configured),
                        ("Odds-API.io websocket configured", odds_api_io_configured),
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

        current = next(
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
                else "budget_stack_configured_enterprise_deferred"
            ),
            steps=steps,
            warnings=warnings,
        )

    def snapshot(self, *, cost_report: DailyCostReport) -> OperationalStateSnapshot:
        provider_mode, provider_mode_reason = self.provider_mode()
        return OperationalStateSnapshot(
            provider_mode=provider_mode,
            provider_mode_reason=provider_mode_reason,
            provider_mode_matrix=self.provider_mode_matrix(active_mode=provider_mode),
            provider_health=self.provider_health(),
            cost_profile=self.cost_profile(),
            daily_cost_report=cost_report,
            data_quality=self.data_quality(),
            provider_cursors=self.provider_cursors(),
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
        persistence_ready, persistence_error = self._persistence_ready()
        training_examples_count = 0
        if persistence_ready:
            training_examples_count = self._training_example_count()
            persistence_error = getattr(self.store, "last_error", None)
            if persistence_error:
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
                name="model_learning_dataset",
                status="pass" if training_examples_count > 0 else "warn",
                summary=(
                    f"{training_examples_count} settled persisted training examples available."
                    if training_examples_count > 0
                    else "No settled persisted training examples are available yet."
                ),
                detail=(
                    None
                    if training_examples_count > 0
                    else "Live backtests and model promotion require settled paper orders; /api/v1/backtests/run will return 409 until examples exist."
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

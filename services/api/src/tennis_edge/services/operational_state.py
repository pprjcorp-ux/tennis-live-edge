from __future__ import annotations

from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CostProfile,
    DailyCostReport,
    DataQualitySnapshot,
    ExecutionStatus,
    IngestionRunRecord,
    LiveReadinessCheck,
    LiveReadinessSnapshot,
    MatchAnalysis,
    OperationalStateSnapshot,
    PaperPerformance,
    Provider,
    ProviderCursor,
    ProviderHealth,
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
        return daily_cost_report(
            self.settings,
            analyses,
            paper_performance,
            provider_usage_counts=provider_usage_counts,
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

    def snapshot(self, *, cost_report: DailyCostReport) -> OperationalStateSnapshot:
        return OperationalStateSnapshot(
            provider_health=self.provider_health(),
            cost_profile=self.cost_profile(),
            daily_cost_report=cost_report,
            data_quality=self.data_quality(),
            provider_cursors=self.provider_cursors(),
            ingestion_runs=self.ingestion_runs(),
            execution_status=self.execution_status(),
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
        persistence_error = getattr(self.store, "last_error", None)
        persistence_ready = (
            self.settings.persistence_enabled
            and bool(self.settings.database_url)
            and not persistence_error
        )
        training_examples_count = 0
        if persistence_ready:
            training_examples_count = getattr(
                self.store,
                "training_example_count",
                lambda *_args, **_kwargs: 0,
            )()
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

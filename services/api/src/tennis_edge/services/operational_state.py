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
        return daily_cost_report(self.settings, analyses, paper_performance)

    def data_quality(self) -> list[DataQualitySnapshot]:
        persisted = self.store.data_quality()
        return persisted or data_quality_snapshots(self.settings)

    def provider_cursors(self) -> list[ProviderCursor]:
        persisted = self.store.provider_cursors()
        return persisted or self.fallback_provider_cursors()

    def fallback_provider_cursors(self) -> list[ProviderCursor]:
        return default_provider_cursors(
            self.settings,
            use_process_cache=self.settings.data_mode == "sample",
        )

    def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self.store.ingestion_runs()

    def execution_status(self) -> ExecutionStatus:
        return execution_status(self.settings)

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
        persistence_enabled = self.settings.persistence_enabled
        can_analyze_live = data_mode_live and score_key_configured
        can_generate_entries = (
            can_analyze_live and odds_key_configured and not odds_cursor_resync
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
                status="pass" if persistence_enabled else "warn",
                summary="Persistence is enabled."
                if persistence_enabled
                else "Persistence is disabled; live truth will not survive restarts.",
                detail=None,
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

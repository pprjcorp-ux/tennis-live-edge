from __future__ import annotations

from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CostProfile,
    DailyCostReport,
    DataQualitySnapshot,
    ExecutionStatus,
    IngestionRunRecord,
    MatchAnalysis,
    OperationalStateSnapshot,
    PaperPerformance,
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

    def snapshot(self) -> OperationalStateSnapshot:
        return OperationalStateSnapshot(
            provider_health=self.provider_health(),
            cost_profile=self.cost_profile(),
            data_quality=self.data_quality(),
            provider_cursors=self.provider_cursors(),
            ingestion_runs=self.ingestion_runs(),
            execution_status=self.execution_status(),
        )

from __future__ import annotations

from collections.abc import Callable
from datetime import date

from tennis_edge.domain import (
    ExecutionOrder,
    LiveDashboardSnapshot,
    Match,
    MatchAnalysis,
    OperationalStateSnapshot,
    PaperPerformance,
    Signal,
)
from tennis_edge.services.ingestion import LiveIngestionPipeline
from tennis_edge.services.live_dashboard import LiveDashboardReadModel
from tennis_edge.services.storage import PersistentStore


SignalGate = Callable[[Match, list[Signal]], list[Signal]]


class OperationalSession:
    """Read canonical match state for operator-facing surfaces.

    Provider ingestion can produce a fresh snapshot, but persisted Postgres
    state is the source served to the dashboard once a provider snapshot has
    been written. This keeps operational reads deterministic across restarts.
    """

    def __init__(
        self,
        ingestion: LiveIngestionPipeline,
        store: PersistentStore,
        signal_gate: SignalGate,
        dashboard_read_model: LiveDashboardReadModel,
    ) -> None:
        self.ingestion = ingestion
        self.store = store
        self.signal_gate = signal_gate
        self.dashboard_read_model = dashboard_read_model

    async def analyses_for_date(self, target_date: date) -> list[MatchAnalysis]:
        snapshot = await self.ingestion.snapshot_for_date(target_date)
        if snapshot.source != "sample" and snapshot.persisted:
            persisted = self._persisted_analyses_for_date(target_date)
            if persisted:
                return persisted
        if snapshot.source == "persisted_fallback":
            return self._gate_analyses(snapshot.analyses)
        return snapshot.analyses

    def _persisted_analyses_for_date(self, target_date: date) -> list[MatchAnalysis]:
        try:
            analyses = self.store.latest_analyses(target_date)
        except Exception as exc:
            if hasattr(self.store, "_record_read_error"):
                self.store._record_read_error("latest_analyses", exc)
            return []
        return self._gate_analyses(analyses)

    def _gate_analyses(self, analyses: list[MatchAnalysis]) -> list[MatchAnalysis]:
        return [
            analysis.model_copy(
                update={
                    "signals": self.signal_gate(
                        analysis.match,
                        analysis.signals,
                    )
                }
            )
            for analysis in analyses
        ]

    async def match_detail(self, match_id: str, target_date: date) -> MatchAnalysis | None:
        analyses = await self.analyses_for_date(target_date)
        for analysis in analyses:
            if analysis.match.id == match_id:
                return analysis
        return None

    async def live_signals(self, target_date: date) -> list[Signal]:
        analyses = await self.analyses_for_date(target_date)
        return self.dashboard_read_model.sorted_signals(analyses)

    async def operational_state_snapshot(
        self,
        target_date: date,
        paper: PaperPerformance,
    ) -> OperationalStateSnapshot:
        analyses = await self.analyses_for_date(target_date)
        return self.dashboard_read_model.operational_state_snapshot(
            target_date,
            analyses,
            paper,
        )

    async def live_dashboard_snapshot(
        self,
        target_date: date,
        paper: PaperPerformance,
    ) -> LiveDashboardSnapshot:
        analyses = await self.analyses_for_date(target_date)
        return self.dashboard_read_model.snapshot(target_date, analyses, paper)

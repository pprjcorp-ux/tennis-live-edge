from datetime import datetime, timezone

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CursorStatus,
    DataQualitySnapshot,
    IngestionRunRecord,
    PaperPerformance,
    Provider,
    ProviderCursor,
)
from tennis_edge.services.operational_state import OperationalStateService
from tennis_edge.services.provider_cursor import CURSORS, mark_resynced


class StoreStub:
    def __init__(
        self,
        *,
        cursors: list[ProviderCursor] | None = None,
        data_quality: list[DataQualitySnapshot] | None = None,
        ingestion_runs: list[IngestionRunRecord] | None = None,
    ) -> None:
        self._cursors = cursors or []
        self._data_quality = data_quality or []
        self._ingestion_runs = ingestion_runs or []

    def provider_health(self):
        return []

    def provider_cursors(self) -> list[ProviderCursor]:
        return self._cursors

    def data_quality(self) -> list[DataQualitySnapshot]:
        return self._data_quality

    def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self._ingestion_runs


def test_operational_state_prefers_persisted_health_inputs() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    cursor = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        last_seq=42,
        expected_next_seq=43,
        status=CursorStatus.HEALTHY,
        note="persisted cursor",
    )
    quality = DataQualitySnapshot(
        id="dq_persisted",
        provider=Provider.ODDS_API_IO,
        feed="odds/tennis:moneyline",
        score_completeness=0,
        odds_completeness=1,
        entity_resolution_rate=1,
        sequence_health=1,
        generated_at=generated_at,
    )
    run = IngestionRunRecord(
        id="ingest_1",
        run_type="live_budget_cycle",
        source="cli",
        status="skipped",
        summary={"reason": "missing keys"},
        started_at=generated_at,
        completed_at=generated_at,
    )
    service = OperationalStateService(
        Settings(data_mode="live"),
        StoreStub(cursors=[cursor], data_quality=[quality], ingestion_runs=[run]),
    )
    cost_report = service.daily_cost_report(
        generated_at.date(),
        [],
        PaperPerformance(
            orders=0,
            settled_orders=0,
            wins=0,
            losses=0,
            open_orders=0,
            roi=None,
            clv=None,
            realized_pnl=0,
            max_drawdown=0,
            calibration_error=None,
            readiness_status="collecting",
            readiness_reasons=["test"],
        ),
    )

    assert service.provider_cursors() == [cursor]
    assert service.data_quality() == [quality]
    assert service.ingestion_runs() == [run]

    snapshot = service.snapshot(cost_report=cost_report)

    assert snapshot.provider_cursors == [cursor]
    assert snapshot.data_quality == [quality]
    assert snapshot.ingestion_runs == [run]
    assert snapshot.cost_profile.active_plan == "lean_atp"
    assert snapshot.daily_cost_report.active_plan == "lean_atp"
    assert snapshot.execution_status.can_submit_real_orders is False
    readiness = service.live_readiness(snapshot)
    assert readiness.status == "blocked"
    assert readiness.can_analyze_live is False
    assert readiness.can_generate_entries is False
    assert readiness.can_submit_real_orders is False
    assert "API_TENNIS_KEY is missing." in readiness.blockers
    assert "ODDS_API_IO_KEY is missing." in readiness.blockers


def test_operational_state_falls_back_to_safe_runtime_defaults() -> None:
    service = OperationalStateService(Settings(data_mode="live"), StoreStub())

    cursors = service.provider_cursors()
    status = service.execution_status()

    assert any(cursor.provider == Provider.ODDS_API_IO for cursor in cursors)
    assert any(cursor.resync_required for cursor in cursors)
    assert status.real_execution_hard_block is True
    assert status.can_submit_real_orders is False


def test_sample_operational_state_fallback_ignores_process_cursor_cache() -> None:
    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)
        service = OperationalStateService(Settings(data_mode="sample"), StoreStub())

        cursors = service.provider_cursors()
        quality = service.data_quality()
        odds_cursor = next(cursor for cursor in cursors if cursor.provider == Provider.ODDS_API_IO)
        odds_quality = next(
            snapshot for snapshot in quality if snapshot.provider == Provider.ODDS_API_IO
        )

        assert odds_cursor.last_seq == 1024
        assert odds_cursor.expected_next_seq == 1025
        assert odds_quality.sequence_health == 0.98
        assert odds_quality.blocked_signals == 0
    finally:
        CURSORS.clear()

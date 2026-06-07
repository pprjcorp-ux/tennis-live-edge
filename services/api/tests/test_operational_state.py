from datetime import datetime, timezone

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CursorStatus,
    DataQualitySnapshot,
    IngestionRunRecord,
    Provider,
    ProviderCursor,
)
from tennis_edge.services.operational_state import OperationalStateService


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

    assert service.provider_cursors() == [cursor]
    assert service.data_quality() == [quality]
    assert service.ingestion_runs() == [run]

    snapshot = service.snapshot()

    assert snapshot.provider_cursors == [cursor]
    assert snapshot.data_quality == [quality]
    assert snapshot.ingestion_runs == [run]
    assert snapshot.cost_profile.active_plan == "lean_atp"
    assert snapshot.execution_status.can_submit_real_orders is False


def test_operational_state_falls_back_to_safe_runtime_defaults() -> None:
    service = OperationalStateService(Settings(data_mode="live"), StoreStub())

    cursors = service.provider_cursors()
    status = service.execution_status()

    assert any(cursor.provider == Provider.ODDS_API_IO for cursor in cursors)
    assert any(cursor.resync_required for cursor in cursors)
    assert status.real_execution_hard_block is True
    assert status.can_submit_real_orders is False

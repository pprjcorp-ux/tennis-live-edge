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
from tennis_edge.services.execution_engine import KILL_SWITCH
from tennis_edge.services.provider_cursor import CURSORS, mark_resynced
from tennis_edge.services.storage import PersistentStore


class StoreStub:
    def __init__(
        self,
        *,
        cursors: list[ProviderCursor] | None = None,
        data_quality: list[DataQualitySnapshot] | None = None,
        ingestion_runs: list[IngestionRunRecord] | None = None,
        training_examples_count: int = 0,
        last_error: str | None = None,
    ) -> None:
        self._cursors = cursors or []
        self._data_quality = data_quality or []
        self._ingestion_runs = ingestion_runs or []
        self._training_examples_count = training_examples_count
        self.last_error = last_error

    def provider_health(self):
        return []

    def provider_cursors(self) -> list[ProviderCursor]:
        return self._cursors

    def data_quality(self) -> list[DataQualitySnapshot]:
        return self._data_quality

    def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self._ingestion_runs

    def training_example_count(self) -> int:
        return self._training_examples_count


def _healthy_odds_cursor() -> ProviderCursor:
    return ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        last_seq=42,
        expected_next_seq=43,
        status=CursorStatus.HEALTHY,
        resync_required=False,
        note="persisted healthy cursor",
    )


def _paper_performance() -> PaperPerformance:
    return PaperPerformance(
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
    )


def _snapshot(service: OperationalStateService, generated_at: datetime):
    return service.snapshot(
        cost_report=service.daily_cost_report(
            generated_at.date(),
            [],
            _paper_performance(),
        )
    )


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
        Settings(data_mode="live", database_url=None),
        StoreStub(cursors=[cursor], data_quality=[quality], ingestion_runs=[run]),
    )

    cursors = service.provider_cursors()
    odds_cursor = next(item for item in cursors if item.provider == Provider.ODDS_API_IO)
    sportradar_cursor = next(item for item in cursors if item.provider == Provider.SPORTRADAR)

    assert odds_cursor == cursor
    assert sportradar_cursor.resync_required is True
    assert service.data_quality() == [quality]
    assert service.ingestion_runs() == [run]

    snapshot = _snapshot(service, generated_at)

    assert snapshot.provider_cursors == cursors
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
    assert "Postgres persistence is required for live operational truth." in readiness.blockers


def test_live_readiness_blocks_entries_without_persistent_truth() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url=None,
        ),
        StoreStub(cursors=[_healthy_odds_cursor()]),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))

    assert readiness.status == "degraded"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is False
    assert "Postgres persistence is required for live operational truth." in readiness.blockers
    persistence_check = next(check for check in readiness.checks if check.name == "persistence")
    assert persistence_check.status == "fail"
    assert persistence_check.detail == "DATABASE_URL is missing."


def test_live_readiness_blocks_entries_when_persisted_odds_cursor_is_missing() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    score_only_cursor = ProviderCursor(
        provider=Provider.API_TENNIS,
        stream="score/live",
        status=CursorStatus.HEALTHY,
        resync_required=False,
        note="score cursor persisted",
    )
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[score_only_cursor]),
    )

    snapshot = _snapshot(service, generated_at)
    readiness = service.live_readiness(snapshot)
    odds_cursor = next(
        cursor for cursor in snapshot.provider_cursors if cursor.provider == Provider.ODDS_API_IO
    )

    assert odds_cursor.status == CursorStatus.RESYNC_REQUIRED
    assert odds_cursor.resync_required is True
    assert readiness.status == "degraded"
    assert readiness.can_generate_entries is False
    assert "Odds websocket cursor requires resync before entries." in readiness.blockers


def test_live_readiness_blocks_entries_when_store_reports_error() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[_healthy_odds_cursor()], last_error="connection refused"),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))

    assert readiness.status == "degraded"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is False
    persistence_check = next(check for check in readiness.checks if check.name == "persistence")
    assert persistence_check.status == "fail"
    assert persistence_check.detail == "connection refused"


def test_live_readiness_allows_entries_with_persistent_truth_and_trusted_cursor() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[_healthy_odds_cursor()]),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))

    assert readiness.status == "ready"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is True
    assert readiness.blockers == []
    persistence_check = next(check for check in readiness.checks if check.name == "persistence")
    assert persistence_check.status == "pass"
    assert persistence_check.detail is None
    dataset_check = next(
        check for check in readiness.checks if check.name == "model_learning_dataset"
    )
    assert dataset_check.status == "warn"
    assert "No settled persisted training examples" in dataset_check.summary


def test_live_readiness_reports_persisted_training_examples() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[_healthy_odds_cursor()], training_examples_count=42),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))

    assert readiness.status == "ready"
    dataset_check = next(
        check for check in readiness.checks if check.name == "model_learning_dataset"
    )
    assert dataset_check.status == "pass"
    assert dataset_check.summary == "42 settled persisted training examples available."
    assert dataset_check.detail is None


def test_live_readiness_blocks_entries_when_persistent_store_cannot_connect() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    settings = Settings(
        data_mode="live",
        api_tennis_key="score-key",
        odds_api_io_key="odds-key",
        persistence_enabled=True,
        database_url="postgresql://tennis:tennis@127.0.0.1:1/tennis_edge?connect_timeout=1",
    )
    store = PersistentStore(settings)
    service = OperationalStateService(settings, store)

    readiness = service.live_readiness(_snapshot(service, generated_at))

    assert store.last_error
    assert readiness.status == "degraded"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is False
    persistence_check = next(check for check in readiness.checks if check.name == "persistence")
    assert persistence_check.status == "fail"
    assert persistence_check.detail == store.last_error


def test_operational_state_falls_back_to_safe_runtime_defaults() -> None:
    service = OperationalStateService(Settings(data_mode="live"), StoreStub())

    cursors = service.provider_cursors()
    quality = service.data_quality()
    status = service.execution_status()

    assert any(cursor.provider == Provider.ODDS_API_IO for cursor in cursors)
    assert any(cursor.resync_required for cursor in cursors)
    assert quality == []
    assert status.real_execution_hard_block is True
    assert status.can_submit_real_orders is False


def test_live_execution_status_ignores_process_global_when_persistence_has_no_row() -> None:
    settings = Settings(
        data_mode="live",
        persistence_enabled=True,
        database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
    )
    KILL_SWITCH["enabled"] = True
    KILL_SWITCH["reason"] = "stale process stop"
    try:
        service = OperationalStateService(settings, StoreStub())

        status = service.execution_status()

        assert status.kill_switch_enabled is False
        assert not any("stale process stop" in reason for reason in status.reasons)
    finally:
        KILL_SWITCH["enabled"] = False
        KILL_SWITCH["reason"] = "not set"


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

from datetime import datetime, timezone

from tennis_edge.config import Settings
from tennis_edge.domain import (
    CursorStatus,
    DataQualitySnapshot,
    IngestionRunRecord,
    PaperPerformance,
    Provider,
    ProviderCursor,
    ProviderHealth,
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
        provider_health: list[ProviderHealth] | None = None,
        provider_usage_counts: dict[Provider, int] | None = None,
        odds_stream_usage: dict | None = None,
        replay_activity: bool = False,
        last_error: str | None = None,
    ) -> None:
        self._cursors = cursors or []
        self._data_quality = data_quality or []
        self._ingestion_runs = ingestion_runs or []
        self._training_examples_count = training_examples_count
        self._provider_health = provider_health or []
        self._provider_usage_counts = provider_usage_counts or {}
        self._odds_stream_usage = odds_stream_usage or {}
        self._replay_activity = replay_activity
        self.last_error = last_error

    def provider_health(self):
        return self._provider_health

    def provider_cursors(self) -> list[ProviderCursor]:
        return self._cursors

    def data_quality(self) -> list[DataQualitySnapshot]:
        return self._data_quality

    def ingestion_runs(self) -> list[IngestionRunRecord]:
        return self._ingestion_runs

    def training_example_count(self) -> int:
        return self._training_examples_count

    def provider_usage_counts(self, target_date) -> dict[Provider, int]:
        return self._provider_usage_counts

    def odds_stream_usage(self, target_date) -> dict:
        return self._odds_stream_usage

    def has_replay_activity(self) -> bool:
        return self._replay_activity


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


def _replay_contract_run(
    *,
    passed: bool = True,
    generated_at: datetime | None = None,
) -> IngestionRunRecord:
    completed_at = generated_at or datetime(2026, 6, 7, tzinfo=timezone.utc)
    return IngestionRunRecord(
        id="ingest_replay_contract_1",
        run_type="replay_contract_run",
        source="api",
        status="completed" if passed else "failed",
        summary={
            "passed": passed,
            "scenarios": [
                {"scenario": "healthy", "passed": passed},
                {"scenario": "gap", "passed": passed},
                {"scenario": "resync_required", "passed": passed},
            ],
        },
        started_at=completed_at,
        completed_at=completed_at,
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
    assert snapshot.provider_mode == "live_without_keys"
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


def test_daily_cost_report_uses_persisted_provider_usage_counts() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(data_mode="live", runtime_profile="lean_atp"),
        StoreStub(
            provider_usage_counts={
                Provider.API_TENNIS: 14,
                Provider.ODDS_API_IO: 9,
                Provider.THE_ODDS_API: 2,
            }
        ),
    )

    report = service.daily_cost_report(generated_at.date(), [], _paper_performance())
    usage = {item.provider: item for item in report.api_calls_by_provider}

    assert usage[Provider.API_TENNIS].api_calls == 14
    assert usage[Provider.ODDS_API_IO].quota_used == 9
    assert usage[Provider.THE_ODDS_API].api_calls == 2


def test_operational_state_marks_sample_provider_mode() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(Settings(data_mode="sample"), StoreStub())

    snapshot = _snapshot(service, generated_at)

    assert snapshot.provider_mode == "sample"
    assert "sample fixtures" in snapshot.provider_mode_reason


def test_operational_state_marks_replay_provider_mode_when_persisted_replay_exists() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(data_mode="live", persistence_enabled=True),
        StoreStub(replay_activity=True),
    )

    snapshot = _snapshot(service, generated_at)

    assert snapshot.provider_mode == "replay"
    assert "Persisted replay" in snapshot.provider_mode_reason


def test_operational_state_marks_explicit_replay_mode_without_live_keys() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(data_mode="replay", persistence_enabled=True),
        StoreStub(replay_activity=False),
    )

    snapshot = _snapshot(service, generated_at)
    matrix = {step.mode: step for step in snapshot.provider_mode_matrix}

    assert snapshot.provider_mode == "replay"
    assert "no paid provider calls" in snapshot.provider_mode_reason
    assert matrix["replay"].active is True
    assert matrix["replay"].status == "active"
    assert matrix["replay"].entry_gate == "monitor"
    assert not matrix["replay"].blockers
    assert "fixture-backed provider contracts" in matrix["replay"].evidence[0]


def test_operational_state_marks_live_with_keys_provider_mode() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
        ),
        StoreStub(replay_activity=True),
    )

    snapshot = _snapshot(service, generated_at)

    assert snapshot.provider_mode == "live_with_keys"
    assert "keys are configured" in snapshot.provider_mode_reason


def test_provider_mode_matrix_explains_replay_monitor_mode() -> None:
    service = OperationalStateService(
        Settings(data_mode="live", persistence_enabled=True),
        StoreStub(replay_activity=True),
    )

    matrix = {step.mode: step for step in service.provider_mode_matrix(active_mode="replay")}

    assert matrix["replay"].active is True
    assert matrix["replay"].status == "active"
    assert matrix["replay"].entry_gate == "monitor"
    assert not matrix["replay"].blockers
    assert matrix["live_without_keys"].entry_gate == "block"
    assert "API_TENNIS_KEY missing" in matrix["live_without_keys"].blockers
    assert "ODDS_API_IO_KEY missing" in matrix["live_without_keys"].blockers


def test_provider_mode_matrix_blocks_live_with_keys_when_cursor_requires_resync() -> None:
    resync_cursor = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        status=CursorStatus.RESYNC_REQUIRED,
        resync_required=True,
        note="Sequence gap needs REST resync.",
    )
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[resync_cursor]),
    )

    matrix = {step.mode: step for step in service.provider_mode_matrix(active_mode="live_with_keys")}

    assert matrix["live_with_keys"].active is True
    assert matrix["live_with_keys"].status == "active"
    assert matrix["live_with_keys"].entry_gate == "block"
    assert "provider cursor requires resync" in matrix["live_with_keys"].blockers


def test_api_onboarding_guides_budget_provider_sequence_after_archive_key() -> None:
    service = OperationalStateService(
        Settings(
            data_mode="live",
            the_odds_api_key="archive-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(ingestion_runs=[_replay_contract_run()]),
    )

    onboarding = service.api_onboarding()
    steps = {step.provider: step for step in onboarding.steps}

    assert onboarding.core_ready is True
    assert onboarding.current_step == "2. api_tennis:score_livescore"
    assert steps[Provider.THE_ODDS_API].status == "configured"
    assert steps[Provider.API_TENNIS].status == "ready_next"
    assert steps[Provider.API_TENNIS].current is True
    assert steps[Provider.ODDS_API_IO].status == "blocked"
    assert "API-Tennis score/livescore configured" in steps[Provider.ODDS_API_IO].required_before_enable
    assert steps[Provider.SPORTRADAR].status == "deferred"


def test_api_onboarding_blocks_paid_keys_until_replay_contract_passes() -> None:
    service = OperationalStateService(
        Settings(
            data_mode="live",
            the_odds_api_key=None,
            api_tennis_key=None,
            odds_api_io_key=None,
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(),
    )

    onboarding = service.api_onboarding()
    archive_step = next(
        step for step in onboarding.steps if step.provider == Provider.THE_ODDS_API
    )

    assert onboarding.core_ready is True
    assert onboarding.current_step == "1. theoddsapi:archive_odds"
    assert archive_step.status == "blocked"
    assert archive_step.current is True
    assert "Passing replay contract run" in archive_step.required_before_enable
    assert any("replay/contracts/run" in warning for warning in onboarding.warnings)


def test_api_onboarding_blocks_live_odds_step_when_cursor_requires_resync() -> None:
    resync_cursor = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        last_seq=7,
        expected_next_seq=8,
        status=CursorStatus.RESYNC_REQUIRED,
        gap_count=1,
        resync_required=True,
        note="gap before live entries",
    )
    service = OperationalStateService(
        Settings(
            data_mode="live",
            the_odds_api_key="archive-key",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(cursors=[resync_cursor], ingestion_runs=[_replay_contract_run()]),
    )

    onboarding = service.api_onboarding()
    odds_step = next(step for step in onboarding.steps if step.provider == Provider.ODDS_API_IO)

    assert onboarding.current_step == "3. odds_api_io:live_odds_websocket"
    assert odds_step.configured is True
    assert odds_step.status == "blocked"
    assert odds_step.current is True
    assert any("cursor requires resync" in warning for warning in onboarding.warnings)


def test_daily_cost_report_uses_persisted_odds_stream_usage() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(data_mode="live", runtime_profile="lean_atp"),
        StoreStub(
            odds_stream_usage={
                "websocket_uptime_pct": 0.25,
                "provider_websocket_minutes": {Provider.ODDS_API_IO: 6},
            }
        ),
    )

    report = service.daily_cost_report(generated_at.date(), [], _paper_performance())
    usage = {item.provider: item for item in report.api_calls_by_provider}

    assert report.websocket_uptime_pct == 0.25
    assert usage[Provider.ODDS_API_IO].websocket_minutes == 6


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


def test_live_readiness_blocks_entries_when_critical_provider_health_is_unhealthy() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(
            cursors=[_healthy_odds_cursor()],
            provider_health=[
                ProviderHealth(
                    provider=Provider.API_TENNIS,
                    configured=True,
                    healthy=False,
                    status="stale persisted feed: score/live",
                    cost_tier="$80/mo",
                    coverage_scope="score",
                ),
                ProviderHealth(
                    provider=Provider.ODDS_API_IO,
                    configured=True,
                    healthy=True,
                    status="odds websocket primary configured",
                    cost_tier="£198/mo Starter+WS",
                    coverage_scope="odds",
                ),
            ],
        ),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))
    provider_check = next(check for check in readiness.checks if check.name == "provider_health")

    assert readiness.status == "degraded"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is False
    assert provider_check.status == "fail"
    assert "stale persisted feed" in (provider_check.detail or "")
    assert "Critical budget provider health is unhealthy or stale." in readiness.blockers


def test_live_readiness_blocks_entries_when_data_quality_reports_stale_ticks() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(
            data_mode="live",
            api_tennis_key="score-key",
            odds_api_io_key="odds-key",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        StoreStub(
            cursors=[_healthy_odds_cursor()],
            data_quality=[
                DataQualitySnapshot(
                    id="dq_stale_odds",
                    provider=Provider.ODDS_API_IO,
                    feed="odds/tennis:moneyline",
                    score_completeness=1,
                    odds_completeness=1,
                    entity_resolution_rate=1,
                    sequence_health=1,
                    stale_ticks=2,
                    blocked_signals=2,
                    generated_at=generated_at,
                )
            ],
        ),
    )

    readiness = service.live_readiness(_snapshot(service, generated_at))
    data_quality_check = next(check for check in readiness.checks if check.name == "data_quality")

    assert readiness.status == "degraded"
    assert readiness.can_analyze_live is True
    assert readiness.can_generate_entries is False
    assert data_quality_check.status == "fail"
    assert "stale_ticks=2" in (data_quality_check.detail or "")
    assert "Persisted data quality reports stale or blocking provider ticks." in readiness.blockers


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


def test_model_lab_readiness_uses_persisted_training_examples_dataset() -> None:
    class StoreWithRequest(StoreStub):
        def __init__(self) -> None:
            super().__init__(cursors=[_healthy_odds_cursor()], training_examples_count=42)
            self.request_seen = None

        def training_example_count(self, request=None) -> int:
            self.request_seen = request
            return self._training_examples_count

    store = StoreWithRequest()
    service = OperationalStateService(
        Settings(
            data_mode="live",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        store,
    )

    model_lab = service.model_lab_readiness()

    assert store.request_seen is not None
    assert store.request_seen.model_version == "prematch_ensemble_v1"
    assert store.request_seen.feature_set == "live_budget_v1"
    assert model_lab.status == "ready"
    assert model_lab.source == "training_examples"
    assert model_lab.training_examples == 42
    assert model_lab.can_run_live_backtest is True
    assert model_lab.reasons == []


def test_model_lab_readiness_blocks_without_persistent_truth() -> None:
    service = OperationalStateService(
        Settings(data_mode="live", persistence_enabled=True, database_url=None),
        StoreStub(training_examples_count=42),
    )

    model_lab = service.model_lab_readiness()

    assert model_lab.status == "blocked"
    assert model_lab.training_examples == 0
    assert model_lab.can_run_live_backtest is False
    assert any("Postgres persistence is required" in reason for reason in model_lab.reasons)


def test_model_lab_readiness_fails_closed_when_dataset_count_sets_store_error() -> None:
    class ErroringStore(StoreStub):
        def training_example_count(self, request=None) -> int:
            self.last_error = "training_example_count failed: connection refused"
            return 0

    service = OperationalStateService(
        Settings(
            data_mode="live",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        ),
        ErroringStore(),
    )

    model_lab = service.model_lab_readiness()

    assert model_lab.status == "blocked"
    assert model_lab.training_examples == 0
    assert model_lab.can_run_live_backtest is False
    assert any("connection refused" in reason for reason in model_lab.reasons)


def test_replay_lab_readiness_exposes_fake_api_contracts_without_live_keys() -> None:
    generated_at = datetime(2026, 6, 7, tzinfo=timezone.utc)
    service = OperationalStateService(
        Settings(data_mode="live", persistence_enabled=True),
        StoreStub(
            ingestion_runs=[
                _replay_contract_run(generated_at=generated_at),
                IngestionRunRecord(
                    id="ingest_replay_1",
                    run_type="replay_run",
                    source="api",
                    status="degraded",
                    summary={
                        "events_replayed": 3,
                        "score_ticks": 1,
                        "odds_ticks": 12,
                        "resync_required": True,
                    },
                    started_at=generated_at,
                    completed_at=generated_at,
                )
            ]
        ),
    )

    replay_lab = service.replay_lab_readiness()
    providers = {provider.provider: provider for provider in replay_lab.providers}

    assert replay_lab.status == "ready"
    assert replay_lab.source == "budget_replay_fixtures"
    assert replay_lab.can_validate_without_live_keys is True
    assert replay_lab.last_contract_run_id == "ingest_replay_contract_1"
    assert replay_lab.last_contract_status == "completed"
    assert replay_lab.last_contract_passed is True
    assert replay_lab.last_contract_scenarios == ["healthy", "gap", "resync_required"]
    assert replay_lab.last_replay_run_id == "ingest_replay_1"
    assert replay_lab.last_replay_status == "degraded"
    assert replay_lab.last_replay_events == 3
    assert replay_lab.last_replay_score_ticks == 1
    assert replay_lab.last_replay_odds_ticks == 12
    assert replay_lab.last_replay_resync_required is True
    assert replay_lab.scenarios == ["healthy", "gap", "resync_required"]
    assert providers[Provider.API_TENNIS].adapter_contract == "ScoreProviderAdapter"
    assert "ScoreTick" in providers[Provider.API_TENNIS].output_contracts
    assert providers[Provider.ODDS_API_IO].adapter_contract == "OddsProviderAdapter"
    assert "ProviderCursor" in providers[Provider.ODDS_API_IO].output_contracts
    assert providers[Provider.THE_ODDS_API].adapter_contract == "ArchiveOddsProviderAdapter"
    assert "RawProviderPayload" in providers[Provider.THE_ODDS_API].input_contracts


def test_replay_lab_readiness_collects_until_contract_run_is_persisted() -> None:
    service = OperationalStateService(Settings(data_mode="live"), StoreStub())

    replay_lab = service.replay_lab_readiness()

    assert replay_lab.status == "collecting"
    assert replay_lab.last_contract_run_id is None
    assert replay_lab.last_contract_passed is False
    assert replay_lab.last_replay_run_id is None
    assert replay_lab.last_replay_events == 0
    assert any("No persisted replay_contract_run" in note for note in replay_lab.notes)


def test_replay_lab_contract_matrix_freezes_provider_adapter_outputs() -> None:
    service = OperationalStateService(Settings(data_mode="replay"), StoreStub())

    replay_lab = service.replay_lab_readiness()
    matrix = {
        provider.provider: {
            "adapter_contract": provider.adapter_contract,
            "fake_api": provider.fake_api,
            "input_contracts": provider.input_contracts,
            "output_contracts": provider.output_contracts,
            "scenarios": provider.scenarios,
            "status": provider.status,
        }
        for provider in replay_lab.providers
    }

    assert matrix == {
        Provider.API_TENNIS: {
            "adapter_contract": "ScoreProviderAdapter",
            "fake_api": "Simulated API-Tennis fixtures/livescore",
            "input_contracts": ["RawProviderPayload", "CanonicalMatch"],
            "output_contracts": ["ScoreTick", "ProviderLatency"],
            "scenarios": ["score_snapshot", "live_score_state"],
            "status": "covered",
        },
        Provider.ODDS_API_IO: {
            "adapter_contract": "OddsProviderAdapter",
            "fake_api": "Simulated Odds-API.io websocket",
            "input_contracts": ["RawProviderPayload", "seq", "lastSeq"],
            "output_contracts": ["OddsTick", "ProviderCursor", "ProviderLatency"],
            "scenarios": ["healthy", "gap", "resync_required"],
            "status": "covered",
        },
        Provider.THE_ODDS_API: {
            "adapter_contract": "ArchiveOddsProviderAdapter",
            "fake_api": "Simulated TheOddsAPI REST snapshot",
            "input_contracts": ["RawProviderPayload"],
            "output_contracts": ["OddsTick", "ProviderLatency"],
            "scenarios": ["archive_snapshot"],
            "status": "covered",
        },
    }


def test_replay_lab_readiness_collects_until_replay_run_is_persisted() -> None:
    test_replay_lab_readiness_collects_until_contract_run_is_persisted()


def test_replay_lab_readiness_blocks_failed_contract_run() -> None:
    service = OperationalStateService(
        Settings(data_mode="live"),
        StoreStub(ingestion_runs=[_replay_contract_run(passed=False)]),
    )

    replay_lab = service.replay_lab_readiness()

    assert replay_lab.status == "blocked"
    assert replay_lab.last_contract_passed is False
    assert replay_lab.last_contract_scenarios == ["healthy", "gap", "resync_required"]
    assert any("did not pass" in note for note in replay_lab.notes)


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

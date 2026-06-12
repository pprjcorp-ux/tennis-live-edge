import asyncio
from contextlib import contextmanager
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone
import sys
from types import ModuleType

from tennis_edge.config import Settings
from tennis_edge.domain import AgentRun
from tennis_edge.domain import AgentRunType
from tennis_edge.domain import AutoPaperSettleRequest
from tennis_edge.domain import BacktestMetrics
from tennis_edge.domain import BacktestRunRequest
from tennis_edge.domain import CursorStatus
from tennis_edge.domain import ExecutionOrder
from tennis_edge.domain import ExecutionVenue
from tennis_edge.domain import IngestionRunRecord
from tennis_edge.domain import KillSwitchRequest
from tennis_edge.domain import MatchFreshness
from tennis_edge.domain import OddsMessageIngestionRequest, ProviderCursorResyncRequest
from tennis_edge.domain import OrderStatus
from tennis_edge.domain import Provider
from tennis_edge.domain import ProviderCursor
from tennis_edge.domain import ProviderMatchPayload
from tennis_edge.domain import RawProviderPayload
from tennis_edge.domain import OddsQuote
from tennis_edge.domain import ModelPromotionDecision
from tennis_edge.domain import PaperSettlement
from tennis_edge.domain import PaperSettleRequest
from tennis_edge.domain import SignalStatus
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.api_tennis_source import ApiTennisMatchSource
from tennis_edge.services.ingestion import LiveIngestionPipeline
from tennis_edge.services.live_dashboard import LiveDashboardReadModel
from tennis_edge.services.operational_state import OperationalStateService
from tennis_edge.services.provider_cursor import CURSORS, ingest_odds_api_sequence, mark_resynced
from tennis_edge.services.repository import AnalysisRepository
from tennis_edge.services.execution_engine import (
    CANCELABLE_ORDER_STATUSES,
    OPEN_ORDER_STATUSES,
)
from tennis_edge.services.storage import (
    PERSISTED_CANCELABLE_ORDER_STATUSES,
    PERSISTED_OPEN_ORDER_STATUSES,
    PersistentStore,
)


def test_persistence_is_disabled_for_sample_mode_even_with_database_url() -> None:
    store = PersistentStore(
        Settings(
            data_mode="sample",
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        )
    )

    assert store.enabled is False
    assert store.latest_analyses(date.today()) == []


def test_persisted_order_status_contract_matches_execution_engine() -> None:
    assert PERSISTED_OPEN_ORDER_STATUSES == tuple(status.value for status in OPEN_ORDER_STATUSES)
    assert PERSISTED_CANCELABLE_ORDER_STATUSES == tuple(
        status.value for status in CANCELABLE_ORDER_STATUSES
    )


class _RaisingCursor:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, query, params=None):
        raise RuntimeError("relation provider_cursors does not exist")


class _RaisingConn:
    def cursor(self):
        return _RaisingCursor()


class _RaisingReadStore(PersistentStore):
    def __init__(self) -> None:
        super().__init__(
            Settings(
                data_mode="live",
                persistence_enabled=True,
                database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
            )
        )

    @property
    def enabled(self) -> bool:
        return True

    @contextmanager
    def _connect(self):
        self.last_error = None
        yield _RaisingConn()


def test_operational_read_methods_degrade_on_schema_drift() -> None:
    cases = [
        ("raw_payloads_for_match", lambda store: store.raw_payloads_for_match("match_1"), []),
        ("latest_analyses", lambda store: store.latest_analyses(date.today()), []),
        (
            "kill_switch_state",
            lambda store: store.kill_switch_state(),
            {
                "enabled": True,
                "reason": "kill switch state unavailable: relation provider_cursors does not exist",
            },
        ),
        ("provider_cursors", lambda store: store.provider_cursors(), []),
        ("data_quality", lambda store: store.data_quality(), []),
        ("ingestion_runs", lambda store: store.ingestion_runs(), []),
        ("agent_runs", lambda store: store.agent_runs(), []),
        ("orders", lambda store: store.orders(), []),
        ("paper_performance", lambda store: store.paper_performance(), None),
        ("paper_performance_segments", lambda store: store._paper_performance_segments(), []),
        ("training_examples", lambda store: store.training_examples(), []),
        ("training_example_count", lambda store: store.training_example_count(), 0),
        ("entity_conflicts", lambda store: store.entity_conflicts(), []),
        ("get_backtest", lambda store: store.get_backtest("latest"), None),
        ("calibration_report", lambda store: store.calibration_report("run_1"), None),
        ("model_registry", lambda store: store.model_registry(), None),
    ]

    for operation, call, expected in cases:
        store = _RaisingReadStore()

        assert call(store) == expected
        assert store.last_error is not None
        assert store.last_error.startswith(f"{operation} failed:")
        assert "relation provider_cursors does not exist" in store.last_error


def test_training_example_count_uses_persisted_settled_rows_and_filters() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "FROM training_examples te" in query
            assert "LEFT JOIN feature_snapshots fs" in query
            assert "LEFT JOIN paper_orders po" in query
            assert "FROM paper_settlements" in query
            assert "te.result_win IS NOT NULL" in query
            assert "te.pnl IS NOT NULL" in query
            assert "te.stake_amount > 0" in query
            assert "te.decision_ts < latest_settlement.settled_at" in query
            assert "fs.feature_set = %s" in query
            self.params = params
            return self

        def fetchone(self):
            assert self.params == (
                "prematch_ensemble_v1",
                "prematch_ensemble_v1",
                "live_budget_v1",
                "live_budget_v1",
                "2026-06-01",
                "2026-06-01",
                "2026-06-08",
                "2026-06-08",
            )
            return {"examples": 7}

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    count = StoreStub().training_example_count(
        BacktestRunRequest(
            model_version="prematch_ensemble_v1",
            feature_set="live_budget_v1",
            start_date="2026-06-01",
            end_date="2026-06-08",
        )
    )

    assert count == 7


def test_training_example_count_casts_optional_null_filters() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "%s::text IS NULL OR te.model_version = %s::text" in query
            assert "%s::text IS NULL OR fs.feature_set = %s::text" in query
            assert "%s::date IS NULL OR te.decision_ts::date >= %s::date" in query
            assert "%s::date IS NULL OR te.decision_ts::date <= %s::date" in query
            self.params = params
            return self

        def fetchone(self):
            assert self.params == (None, None, None, None, None, None, None, None)
            return {"examples": 0}

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    assert StoreStub().training_example_count() == 0


def test_provider_usage_counts_reads_raw_payloads_for_target_date() -> None:
    target_date = date(2026, 6, 8)

    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "FROM raw_provider_payloads" in query
            assert "ingested_at::date = %s" in query
            self.params = params
            return self

        def fetchall(self):
            assert self.params == (target_date,)
            return [
                {"provider": Provider.API_TENNIS.value, "count": 12},
                {"provider": Provider.ODDS_API_IO.value, "count": 8},
            ]

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    counts = StoreStub().provider_usage_counts(target_date)

    assert counts == {
        Provider.API_TENNIS: 12,
        Provider.ODDS_API_IO: 8,
    }


def test_save_order_prefers_exact_external_signal_id_lookup() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.query = ""
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            self.params = params
            return self

        def fetchone(self):
            return None

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    order = ExecutionOrder(
        id="ord_lookup",
        signal_id="sig_exact",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
    )
    store = StoreStub()

    store.save_order(order)

    assert "risk->>'external_signal_id' = %s" in store.conn.cursor_stub.query
    assert "CASE WHEN risk->>'external_signal_id' = %s THEN 0 ELSE 1 END" in store.conn.cursor_stub.query
    assert store.conn.cursor_stub.params == (
        "sig_exact",
        "match_atp_001",
        "atp_sinner",
        "sig_exact",
    )


def test_insert_signals_records_provider_lineage_in_risk_context() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.risks = []

        def execute(self, query, params=None):
            assert "INSERT INTO signals" in query
            self.risks.append(params[9].obj)

    repo = AnalysisRepository(Settings(data_mode="sample"))
    analysis = asyncio.run(repo.analyses_for_date(date.today()))[0]
    assert analysis.signals
    match = analysis.match.model_copy(
        update={
            "provider_ids": {
                "api_tennis": "fixture-1",
                "odds_api_io": "odds-1",
            }
        }
    )
    cursor = CursorStub()

    PersistentStore(
        Settings(
            data_mode="live",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        )
    )._insert_signals(cursor, analysis.signals, "prediction_1", match)

    assert cursor.risks
    assert all(risk["score_provider"] == Provider.API_TENNIS.value for risk in cursor.risks)
    assert all(risk["odds_provider"] == Provider.ODDS_API_IO.value for risk in cursor.risks)
    assert all(
        risk["provider_lineage"] == [Provider.API_TENNIS.value, Provider.ODDS_API_IO.value]
        for risk in cursor.risks
    )


def test_odds_stream_usage_reads_persisted_ingestion_runs() -> None:
    target_date = date(2026, 6, 8)
    started_at = datetime(2026, 6, 8, 12, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.params = None
            self.queries = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            if "FROM ingestion_runs" in query:
                assert "run_type = 'odds_stream'" in query
                assert "completed_at::date = %s" in query
                self.params = params
            return self

        def fetchall(self):
            assert self.params == (target_date,)
            return [
                {
                    "summary": {"connected": True},
                    "started_at": started_at,
                    "completed_at": started_at + timedelta(minutes=3),
                },
                {
                    "summary": {"connected": False, "reason": "missing key"},
                    "started_at": started_at + timedelta(minutes=4),
                    "completed_at": started_at + timedelta(minutes=4),
                },
            ]

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    usage = StoreStub().odds_stream_usage(target_date)

    assert usage["websocket_uptime_pct"] == 0.5
    assert usage["provider_websocket_minutes"] == {Provider.ODDS_API_IO: 3}


def test_training_examples_filter_by_feature_set_and_decision_window() -> None:
    decision_ts = datetime(2026, 6, 3, 14, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "FROM training_examples te" in query
            assert "LEFT JOIN feature_snapshots fs" in query
            assert "LEFT JOIN paper_orders po" in query
            assert "FROM paper_settlements" in query
            assert "fs.feature_set = %s" in query
            assert "te.decision_ts < latest_settlement.settled_at" in query
            self.params = params
            return self

        def fetchall(self):
            assert self.params == (
                "prematch_ensemble_v1",
                "live_budget_v1",
                "live_budget_v1",
                "2026-06-01",
                "2026-06-01",
                "2026-06-08",
                "2026-06-08",
            )
            return [
                {
                    "id": "train_1",
                    "match_id": "match_1",
                    "player_id": "player_1",
                    "model_version": "prematch_ensemble_v1",
                    "feature_snapshot_id": 123,
                    "feature_set": "live_budget_v1",
                    "decision_ts": decision_ts,
                    "model_probability": 0.62,
                    "market_probability": 0.58,
                    "closing_probability": 0.6,
                    "result_win": True,
                    "pnl": 8.5,
                    "clv": 0.02,
                    "stake_amount": 50,
                    "calibration_bucket": "0.6-0.7",
                    "settled_at": datetime(2026, 6, 4, 20, tzinfo=timezone.utc),
                }
            ]

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    examples = StoreStub().training_examples(
        BacktestRunRequest(
            model_version="prematch_ensemble_v1",
            feature_set="live_budget_v1",
            start_date="2026-06-01",
            end_date="2026-06-08",
        )
    )

    assert len(examples) == 1
    assert examples[0].feature_snapshot_id == 123
    assert examples[0].feature_set == "live_budget_v1"
    assert examples[0].decision_ts == decision_ts
    assert examples[0].settled_at == datetime(2026, 6, 4, 20, tzinfo=timezone.utc)


def test_training_examples_skip_legacy_zero_stake_rows() -> None:
    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "te.stake_amount > 0" in query
            assert "te.decision_ts < latest_settlement.settled_at" in query
            return self

        def fetchall(self):
            return []

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    assert StoreStub().training_examples() == []


def test_operational_write_methods_degrade_on_schema_drift() -> None:
    source_ts = datetime(2026, 6, 7, 12, tzinfo=timezone.utc)
    metrics = BacktestMetrics(
        run_id="bt_write_drift",
        model_version="candidate_write_drift",
        matches=10,
        signals=2,
        roi=0.01,
        clv=0.005,
        brier_score=0.22,
        log_loss=0.63,
        calibration_error=0.04,
        max_drawdown=0.02,
    )
    order = ExecutionOrder(
        id="ord_write_drift",
        signal_id="sig_write_drift",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.PAPER,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
    )
    settlement = PaperSettlement(
        order_id=order.id,
        status=OrderStatus.SETTLED,
        result_win=True,
        requested_odds=2.0,
        average_price=2.0,
        matched_stake=100,
        gross_pnl=100,
        commission=2,
        net_pnl=98,
        closing_odds=1.95,
        clv=0.012,
        settled_at=source_ts,
    )
    analysis = asyncio.run(
        AnalysisRepository(Settings(data_mode="sample")).analyses_for_date(date.today())
    )[0]
    payload = RawProviderPayload(
        id="raw_write_drift",
        provider=Provider.API_TENNIS,
        payload_type="score",
        source_event_id="match_atp_001",
        source_ts=source_ts,
        ingested_at=source_ts,
        checksum="write_drift_checksum",
        payload={"status": "live"},
    )
    cursor = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        last_seq=10,
        expected_next_seq=11,
        status=CursorStatus.HEALTHY,
        gap_count=0,
        resync_required=False,
        last_message_at=source_ts,
        note="write drift test",
    )
    ingestion_run = IngestionRunRecord(
        id="ingest_write_drift",
        run_type="live_budget_cycle",
        source="cli",
        status="failed",
        summary={"reason": "schema drift"},
        started_at=source_ts,
        completed_at=source_ts,
    )
    promotion = ModelPromotionDecision(
        run_id="promotion_write_drift",
        candidate_model_version="candidate_write_drift",
        promoted=False,
        reasons=["schema drift test"],
        metrics=metrics,
        created_at=source_ts,
    )
    agent_run = AgentRun(
        id="agent_write_drift",
        run_type=AgentRunType.AUTOPILOT_EVALUATE,
        source="openclaw",
        summary="write drift test",
        created_at=source_ts,
    )

    cases = [
        ("save_analyses", lambda store: store.save_analyses([analysis]), False),
        ("save_raw_payloads", lambda store: store.save_raw_payloads([payload]), 0),
        ("save_provider_cursor", lambda store: store.save_provider_cursor(cursor), False),
        (
            "save_kill_switch",
            lambda store: store.save_kill_switch(
                KillSwitchRequest(enabled=True, reason="schema drift")
            ),
            False,
        ),
        (
            "record_provider_latency",
            lambda store: store.record_provider_latency(
                Provider.API_TENNIS,
                "score/live",
                latest_source_ts=source_ts,
                latest_ingested_at=source_ts,
            ),
            False,
        ),
        (
            "save_odds_quotes_for_event",
            lambda store: store.save_odds_quotes_for_event(
                Provider.THE_ODDS_API,
                "event_write_drift",
                [
                    OddsQuote(
                        player_id="atp_sinner",
                        decimal_odds=2.0,
                        bookmaker="book",
                        source_ts=source_ts,
                    )
                ],
            ),
            0,
        ),
        ("save_model_promotion_decision", lambda store: store.save_model_promotion_decision(promotion), None),
        ("save_order", lambda store: store.save_order(order), None),
        ("save_agent_run", lambda store: store.save_agent_run(agent_run), None),
        ("save_ingestion_run", lambda store: store.save_ingestion_run(ingestion_run), False),
        ("cancel_order", lambda store: store.cancel_order(order.id), None),
        (
            "settle_paper_order",
            lambda store: store.settle_paper_order(
                PaperSettleRequest(order_id=order.id, result_win=True, closing_odds=1.95)
            ),
            None,
        ),
        ("save_settlement", lambda store: store.save_settlement(settlement), False),
        ("save_backtest", lambda store: store.save_backtest(metrics, BacktestRunRequest()), None),
    ]

    for operation, call, expected in cases:
        store = _RaisingReadStore()

        assert call(store) == expected
        assert store.last_error is not None
        assert store.last_error.startswith(f"{operation} failed:")
        assert "relation provider_cursors does not exist" in store.last_error


def test_settle_paper_order_returns_none_when_settlement_write_fails() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            if "INSERT INTO paper_settlements" in query:
                raise RuntimeError("relation paper_settlements does not exist")
            return self

        def fetchone(self):
            if "SELECT id" in self.query:
                return {"id": 101, "status": OrderStatus.PAPER.value}
            if "external_order_ref" in self.query:
                return {
                    "external_order_ref": "ord_write_drift",
                    "match_id": "match_atp_001",
                    "player_id": "atp_sinner",
                    "requested_odds": 2.0,
                    "average_price": 2.0,
                    "matched_stake": 100,
                    "stake_amount": 100,
                    "status": OrderStatus.PAPER.value,
                    "result_win": None,
                    "gross_pnl": None,
                    "commission": None,
                    "net_pnl": None,
                    "closing_odds": None,
                    "clv": None,
                    "settled_at": None,
                }
            return None

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            self.last_error = None
            yield ConnStub()

    store = StoreStub()

    settlement = store.settle_paper_order(
        PaperSettleRequest(order_id="ord_write_drift", result_win=True, closing_odds=1.95)
    )

    assert settlement is None
    assert store.last_error is not None
    assert store.last_error.startswith("save_settlement failed:")
    assert "relation paper_settlements does not exist" in store.last_error


def test_auto_settle_paper_orders_uses_finished_score_and_closing_odds() -> None:
    score_ts = datetime(2026, 6, 7, 20, 0, tzinfo=timezone.utc)
    order_ts = score_ts - timedelta(minutes=2)
    closing_ts = score_ts - timedelta(seconds=30)
    rows = [
        {
            "external_order_ref": "ord_auto_win",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": closing_ts,
        },
        {
            "external_order_ref": "ord_auto_loss",
            "match_id": "match_auto",
            "player_id": "p2",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 2.2,
            "closing_odds_source_ts": closing_ts,
        },
    ]

    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.params = params
            return self

        def fetchall(self):
            return rows

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.requests: list[PaperSettleRequest] = []

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def settle_paper_order(self, request: PaperSettleRequest):
            self.requests.append(request)
            return PaperSettlement(
                order_id=request.order_id,
                status=OrderStatus.SETTLED,
                result_win=request.result_win,
                requested_odds=2.0,
                average_price=2.0,
                matched_stake=100,
                gross_pnl=100 if request.result_win else -100,
                commission=2 if request.result_win else 0,
                net_pnl=98 if request.result_win else -100,
                closing_odds=request.closing_odds,
                clv=0.01,
            )

    store = StoreStub()

    result = store.auto_settle_paper_orders(AutoPaperSettleRequest(max_orders=25))

    assert result.evaluated_orders == 2
    assert result.settled_orders == 2
    assert result.skipped_orders == 0
    assert [request.order_id for request in store.requests] == ["ord_auto_win", "ord_auto_loss"]
    assert [request.result_win for request in store.requests] == [True, False]
    assert [request.closing_odds for request in store.requests] == [1.8, 2.2]


def test_auto_settle_paper_orders_skips_unsettleable_candidates() -> None:
    score_ts = datetime(2026, 6, 7, 20, 0, tzinfo=timezone.utc)
    order_ts = score_ts - timedelta(minutes=2)
    closing_ts = score_ts - timedelta(seconds=30)
    rows = [
        {
            "external_order_ref": "ord_live",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "live", "p1_sets": 1, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": closing_ts,
        },
        {
            "external_order_ref": "ord_tied",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 1, "p2_sets": 1},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": closing_ts,
        },
        {
            "external_order_ref": "ord_no_odds",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": None,
            "closing_odds_source_ts": closing_ts,
        },
        {
            "external_order_ref": "ord_no_exposure",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 0,
            "stake_amount": 0,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": closing_ts,
        },
        {
            "external_order_ref": "ord_post_result_odds",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": score_ts + timedelta(seconds=1),
        },
        {
            "external_order_ref": "ord_pre_order_odds",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": order_ts,
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": order_ts - timedelta(seconds=1),
        },
        {
            "external_order_ref": "ord_stale_closing",
            "match_id": "match_auto",
            "player_id": "p1",
            "order_created_at": score_ts - timedelta(minutes=31),
            "matched_stake": 100,
            "stake_amount": 100,
            "player1_id": "p1",
            "player2_id": "p2",
            "raw_state": {"status": "finished", "p1_sets": 2, "p2_sets": 0},
            "score_source_ts": score_ts,
            "closing_odds": 1.8,
            "closing_odds_source_ts": score_ts - timedelta(minutes=30),
        },
    ]

    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            return self

        def fetchall(self):
            return rows

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def settle_paper_order(self, request: PaperSettleRequest):
            raise AssertionError("unsettleable rows must not reach settle_paper_order")

    result = StoreStub().auto_settle_paper_orders()

    assert result.evaluated_orders == 7
    assert result.settled_orders == 0
    assert result.skipped_orders == 7
    assert any("not finished" in reason for reason in result.reasons)
    assert any("no inferable winner" in reason for reason in result.reasons)
    assert any("missing closing moneyline odds" in reason for reason in result.reasons)
    assert any("no matched stake" in reason for reason in result.reasons)
    assert any("before the paper order" in reason for reason in result.reasons)
    assert any("after the final score" in reason for reason in result.reasons)
    assert any("too stale" in reason for reason in result.reasons)


def test_settle_paper_order_blocks_non_open_persisted_order() -> None:
    class CursorStub:
        query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            return self

        def fetchone(self):
            if "SELECT" not in self.query:
                return None
            return {
                "external_order_ref": "ord_cancelled",
                "match_id": "match_atp_001",
                "player_id": "atp_sinner",
                "requested_odds": 2.0,
                "average_price": 2.0,
                "matched_stake": 100,
                "stake_amount": 100,
                "status": OrderStatus.CANCELLED.value,
                "result_win": None,
                "gross_pnl": None,
                "commission": None,
                "net_pnl": None,
                "closing_odds": None,
                "clv": None,
                "settled_at": None,
            }

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.save_called = False

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def save_settlement(self, settlement: PaperSettlement) -> bool:
            self.save_called = True
            return True

    store = StoreStub()

    settlement = store.settle_paper_order(
        PaperSettleRequest(order_id="ord_cancelled", result_win=True, closing_odds=1.9)
    )

    assert settlement is None
    assert store.save_called is False


def test_settle_paper_order_returns_existing_settlement_without_rewriting() -> None:
    settled_at = datetime(2026, 5, 3, 20, tzinfo=timezone.utc)

    class CursorStub:
        query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            return self

        def fetchone(self):
            if "SELECT" not in self.query:
                return None
            return {
                "external_order_ref": "ord_settled",
                "match_id": "match_atp_001",
                "player_id": "atp_sinner",
                "requested_odds": 2.0,
                "average_price": 2.02,
                "matched_stake": 75,
                "stake_amount": 100,
                "status": OrderStatus.SETTLED.value,
                "result_win": True,
                "gross_pnl": 76.5,
                "commission": 1.53,
                "net_pnl": 74.97,
                "closing_odds": 1.95,
                "clv": 0.017,
                "settled_at": settled_at,
            }

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.save_called = False

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def save_settlement(self, settlement: PaperSettlement) -> bool:
            self.save_called = True
            return True

    store = StoreStub()

    settlement = store.settle_paper_order(
        PaperSettleRequest(order_id="ord_settled", result_win=False, closing_odds=3.0)
    )

    assert settlement is not None
    assert settlement.result_win is True
    assert settlement.net_pnl == 74.97
    assert settlement.closing_odds == 1.95
    assert settlement.settled_at == settled_at
    assert store.save_called is False


def test_save_settlement_failure_reaches_transaction_for_rollback() -> None:
    class TransactionStub:
        def __init__(self) -> None:
            self.saw_exception = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.saw_exception = exc_type is RuntimeError
            return False

    class CursorStub:
        def __init__(self) -> None:
            self.query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            if "INSERT INTO paper_settlements" in query:
                raise RuntimeError("relation paper_settlements does not exist")
            return self

        def fetchone(self):
            if "SELECT id" in self.query:
                return {"id": 101, "status": OrderStatus.PAPER.value}
            return None

    class ConnStub:
        def __init__(self) -> None:
            self.transaction_stub = TransactionStub()

        def cursor(self):
            return CursorStub()

        def transaction(self):
            return self.transaction_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()

    saved = store.save_settlement(
        PaperSettlement(
            order_id="ord_write_drift",
            status=OrderStatus.SETTLED,
            result_win=True,
            requested_odds=2.0,
            average_price=2.0,
            matched_stake=100,
            gross_pnl=100,
            commission=2,
            net_pnl=98,
            closing_odds=1.95,
            clv=0.012,
        )
    )

    assert saved is False
    assert store.conn.transaction_stub.saw_exception is True
    assert store.last_error is not None
    assert store.last_error.startswith("save_settlement failed:")


def test_raw_payload_batch_failure_reaches_transaction_for_rollback() -> None:
    class TransactionStub:
        def __init__(self) -> None:
            self.saw_exception = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.saw_exception = exc_type is RuntimeError
            return False

    class CursorStub:
        def __init__(self) -> None:
            self.rowcount = 0
            self.execute_count = 0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.execute_count += 1
            if self.execute_count == 2:
                raise RuntimeError("raw payload insert failed")
            self.rowcount = 1
            return self

    class ConnStub:
        def __init__(self) -> None:
            self.transaction_stub = TransactionStub()

        def cursor(self):
            return CursorStub()

        def transaction(self):
            return self.transaction_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    source_ts = datetime(2026, 6, 7, 12, tzinfo=timezone.utc)
    payloads = [
        RawProviderPayload(
            id=f"raw_write_drift_{idx}",
            provider=Provider.API_TENNIS,
            payload_type="score",
            source_event_id="match_atp_001",
            source_ts=source_ts,
            ingested_at=source_ts,
            checksum=f"write_drift_checksum_{idx}",
            payload={"status": "live"},
        )
        for idx in range(2)
    ]
    store = StoreStub()

    inserted = store.save_raw_payloads(payloads)

    assert inserted == 0
    assert store.conn.transaction_stub.saw_exception is True
    assert store.last_error is not None
    assert store.last_error.startswith("save_raw_payloads failed:")


def test_successful_connection_does_not_clear_previous_store_error(monkeypatch) -> None:
    class ConnStub:
        def close(self) -> None:
            pass

    psycopg = ModuleType("psycopg")
    psycopg.connect = lambda *args, **kwargs: ConnStub()
    rows = ModuleType("psycopg.rows")
    rows.dict_row = object()
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)
    monkeypatch.setitem(sys.modules, "psycopg.rows", rows)
    store = PersistentStore(
        Settings(
            data_mode="live",
            persistence_enabled=True,
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        )
    )
    store.last_error = "save_raw_payloads failed: previous schema drift"

    with store._connect() as conn:
        assert conn is not None

    assert store.last_error == "save_raw_payloads failed: previous schema drift"


def test_provider_health_degrades_budget_providers_on_schema_drift() -> None:
    store = _RaisingReadStore()

    health = store.provider_health()

    assert store.last_error is not None
    assert store.last_error.startswith("provider_health failed:")
    configured_budget = [
        item
        for item in health
        if item.provider in {Provider.API_TENNIS, Provider.ODDS_API_IO, Provider.THE_ODDS_API}
    ]
    assert configured_budget
    assert all(not item.healthy for item in configured_budget)
    assert all("persistence unavailable" in item.status for item in configured_budget)


def test_paper_performance_survives_segment_schema_drift() -> None:
    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            if "count(*)::int AS orders" in query:
                return self
            raise RuntimeError("relation prediction_snapshots does not exist")

        def fetchone(self):
            return {
                "orders": 2,
                "settled_orders": 1,
                "positive_clv_signals": 1,
                "wins": 1,
                "losses": 0,
                "open_orders": 1,
                "pnl": 12.0,
                "staked": 100.0,
                "clv": 0.015,
            }

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            self.last_error = None
            yield ConnStub()

    store = StoreStub()
    performance = store.paper_performance()

    assert performance is not None
    assert performance.orders == 2
    assert performance.settled_orders == 1
    assert performance.roi == 0.12
    assert performance.segments == []
    assert store.last_error is not None
    assert store.last_error.startswith("paper_performance_segments failed:")


def test_paper_performance_uses_positive_matched_stake_only() -> None:
    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            if "count(*)::int AS orders" in query:
                assert "status = 'settled' AND matched_stake > 0" in query
                assert "THEN matched_stake ELSE 0 END" in query
                return self
            raise RuntimeError("segments not needed")

        def fetchone(self):
            return {
                "orders": 2,
                "settled_orders": 1,
                "positive_clv_signals": 1,
                "wins": 1,
                "losses": 0,
                "open_orders": 0,
                "pnl": 12.0,
                "staked": 100.0,
                "clv": 0.015,
            }

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def _paper_performance_segments(self):
            return []

    performance = StoreStub().paper_performance()

    assert performance is not None
    assert performance.settled_orders == 1
    assert performance.roi == 0.12


def test_paper_performance_segments_group_provider_by_signal_odds_provider() -> None:
    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            assert "s.risk->>'odds_provider'" in query
            assert "po.risk_snapshot->>'odds_provider'" in query
            assert "po.venue" in query
            assert "po.status = 'settled' AND po.matched_stake > 0" in query
            return self

        def fetchall(self):
            return [
                {
                    "segment_type": "provider",
                    "segment": Provider.ODDS_API_IO.value,
                    "settled_orders": 2,
                    "realized_pnl": 14.0,
                    "staked": 100.0,
                    "clv": 0.018,
                }
            ]

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    persistence_enabled=True,
                    database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    segments = StoreStub()._paper_performance_segments()

    assert len(segments) == 1
    assert segments[0].segment_type == "provider"
    assert segments[0].segment == Provider.ODDS_API_IO.value
    assert segments[0].roi == 0.14


def test_persisted_fallback_schema_drift_returns_empty_snapshot_with_store_error() -> None:
    class StoreStub:
        def __init__(self) -> None:
            self.last_error = None

        def latest_analyses(self, target_date: date):
            raise RuntimeError("relation matches does not exist")

        def _record_read_error(self, operation: str, exc: Exception) -> None:
            self.last_error = f"{operation} failed: {exc}"

    store = StoreStub()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource([]),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "empty"
    assert snapshot.analyses == []
    assert store.last_error == "latest_analyses failed: relation matches does not exist"


def test_repository_dashboard_snapshot_survives_persisted_fallback_schema_drift() -> None:
    class StoreStub:
        def __init__(self) -> None:
            self.last_error = None

        def latest_analyses(self, target_date: date):
            raise RuntimeError("relation matches does not exist")

        def _record_read_error(self, operation: str, exc: Exception) -> None:
            self.last_error = f"{operation} failed: {exc}"

        def paper_performance(self):
            return None

        def orders(self):
            return []

        def provider_health(self):
            return []

        def provider_cursors(self):
            return []

        def data_quality(self):
            return []

        def ingestion_runs(self):
            return []

    settings = Settings(data_mode="live", persistence_enabled=True, database_url="postgresql://local/test")
    repo = AnalysisRepository(settings)
    store = StoreStub()
    repo.store = store
    repo.operational_state = OperationalStateService(settings, store)
    repo.dashboard_read_model = LiveDashboardReadModel(repo.operational_state)
    repo.ingestion = LiveIngestionPipeline(
        _FakeMatchSource([]),
        _FakeArchiveSource(),
        store,
        signal_gate=repo._gate_signals_for_match,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(repo.live_dashboard_snapshot(date.today()))

    assert snapshot.matches == []
    assert snapshot.metrics.matches == 0
    assert snapshot.readiness.status == "blocked"
    assert snapshot.readiness.can_generate_entries is False
    assert store.last_error == "latest_analyses failed: relation matches does not exist"


def test_raw_payloads_for_match_maps_persisted_rows_to_domain_payloads() -> None:
    source_ts = datetime(2026, 6, 7, 12, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params):
            self.params = params
            return self

        def fetchall(self):
            return [
                {
                    "id": "raw_1",
                    "provider": "sportradar",
                    "payload_type": "score",
                    "source_event_id": "match_1",
                    "source_ts": source_ts,
                    "ingested_at": source_ts,
                    "checksum": "checksum_1",
                    "payload": {"match_id": "match_1", "status": "live"},
                }
            ]

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()

    payloads = store.raw_payloads_for_match("match_1")

    assert store.conn.cursor_stub.params == ("match_1",)
    assert len(payloads) == 1
    assert payloads[0].provider == Provider.SPORTRADAR
    assert payloads[0].payload["status"] == "live"


def test_latest_analyses_score_tick_lateral_selects_timestamps() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.queries = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            return self

        def fetchall(self):
            return []

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()

    assert store.latest_analyses(date.today()) == []
    query = store.conn.cursor_stub.queries[0]
    assert "SELECT raw_state, source_ts, ingested_at" in query


def test_persisted_fallback_match_state_uses_latest_score_source_latency() -> None:
    base_match = sample_matches()[1]
    score_source_ts = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=20)
    raw_state = base_match.state.model_dump()
    raw_state["source_latency_ms"] = None
    row = {
        "id": base_match.id,
        "provider_ids": base_match.provider_ids,
        "latest_score_source_ts": score_source_ts,
        "player1_id": base_match.player1.id,
        "p1_provider_ids": base_match.player1.provider_ids,
        "p1_name": base_match.player1.name,
        "p1_country": base_match.player1.country,
        "p1_ranking": base_match.player1.ranking,
        "p1_handedness": base_match.player1.handedness,
        "p1_elo_overall": base_match.player1.elo_overall,
        "p1_elo_clay": base_match.player1.elo_clay,
        "p1_elo_hard": base_match.player1.elo_hard,
        "p1_hold_rate": base_match.player1.hold_rate,
        "p1_break_rate": base_match.player1.break_rate,
        "player2_id": base_match.player2.id,
        "p2_provider_ids": base_match.player2.provider_ids,
        "p2_name": base_match.player2.name,
        "p2_country": base_match.player2.country,
        "p2_ranking": base_match.player2.ranking,
        "p2_handedness": base_match.player2.handedness,
        "p2_elo_overall": base_match.player2.elo_overall,
        "p2_elo_clay": base_match.player2.elo_clay,
        "p2_elo_hard": base_match.player2.elo_hard,
        "p2_hold_rate": base_match.player2.hold_rate,
        "p2_break_rate": base_match.player2.break_rate,
        "tour": base_match.tour,
        "status": base_match.state.status,
        "latest_state": raw_state,
        "tournament": base_match.tournament,
        "round": base_match.round,
        "competition_level": base_match.competition_level,
        "surface": base_match.surface,
        "indoor": base_match.indoor,
        "best_of": base_match.best_of,
        "scheduled_at": base_match.scheduled_at,
    }

    match = PersistentStore(Settings(data_mode="live"))._match_from_row(row, [])

    assert match.state.source_latency_ms is not None
    assert match.state.source_latency_ms >= 20_000


def test_latest_analyses_does_not_generate_unpersisted_predictions() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.queries = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            return self

        def fetchall(self):
            query = self.queries[-1]
            if "FROM matches m" in query:
                return [{"id": "match_missing_prediction"}]
            return []

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            self.last_error = None
            yield self.conn

    store = StoreStub()

    assert store.latest_analyses(date.today()) == []
    assert store.last_error is not None
    assert store.last_error.startswith("latest_analyses failed:")
    assert "persisted matches missing prediction snapshots" in store.last_error
    assert any("FROM prediction_snapshots" in query for query in store.conn.cursor_stub.queries)


def test_ingestion_run_journal_creates_schema_and_maps_rows() -> None:
    started_at = datetime(2026, 6, 7, 20, tzinfo=timezone.utc)
    completed_at = datetime(2026, 6, 7, 20, 1, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.queries = []
            self.params = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            self.params.append(params)
            return self

        def fetchall(self):
            return [
                {
                    "id": "ingest_1",
                    "run_type": "live_budget_cycle",
                    "source": "cli",
                    "status": "skipped",
                    "summary": {"reason": "missing keys"},
                    "started_at": started_at,
                    "completed_at": completed_at,
                }
            ]

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()
    saved = store.save_ingestion_run(
        IngestionRunRecord(
            id="ingest_1",
            run_type="live_budget_cycle",
            source="cli",
            status="skipped",
            summary={"reason": "missing keys"},
            started_at=started_at,
            completed_at=completed_at,
        )
    )
    rows = store.ingestion_runs()

    assert saved is True
    assert rows[0].id == "ingest_1"
    assert rows[0].summary["reason"] == "missing keys"
    assert any("CREATE TABLE IF NOT EXISTS ingestion_runs" in query for query in store.conn.cursor_stub.queries)
    assert any("INSERT INTO ingestion_runs" in query for query in store.conn.cursor_stub.queries)


def test_kill_switch_state_creates_schema_and_maps_rows() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.queries = []
            self.params = []
            self.enabled = False
            self.reason = "not set"
            self.query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.query = query
            self.queries.append(query)
            self.params.append(params)
            if "INSERT INTO execution_controls" in query and params:
                self.enabled = bool(params[1])
                self.reason = params[2]
            return self

        def fetchone(self):
            if "FROM execution_controls" in self.query:
                return {"enabled": self.enabled, "reason": self.reason}
            return None

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()

    saved = store.save_kill_switch(
        KillSwitchRequest(enabled=True, reason="manual persisted stop")
    )
    state = store.kill_switch_state()

    assert saved is True
    assert state == {"enabled": True, "reason": "manual persisted stop"}
    assert any(
        "CREATE TABLE IF NOT EXISTS execution_controls" in query
        for query in store.conn.cursor_stub.queries
    )
    assert any("INSERT INTO execution_controls" in query for query in store.conn.cursor_stub.queries)


def test_provider_cursor_seed_does_not_overwrite_persisted_cursor() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.params = []

        def execute(self, query, params):
            self.params.append(params)

    cursor_stub = CursorStub()
    existing = ProviderCursor(
        provider=Provider.ODDS_API_IO,
        stream="tennis:moneyline",
        last_seq=40,
        expected_next_seq=41,
        status=CursorStatus.HEALTHY,
        gap_count=0,
        resync_required=False,
        note="Persisted healthy cursor.",
    )
    store = PersistentStore(Settings(data_mode="live", persistence_enabled=True))

    store._upsert_provider_cursors(cursor_stub, existing_cursors=[existing])

    odds_params = next(params for params in cursor_stub.params if params[0] == "odds_api_io")
    assert odds_params[2] == 40
    assert odds_params[4] == "healthy"
    assert odds_params[6] is False


def test_provider_cursor_seed_ignores_process_cache_without_existing_cursor() -> None:
    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)

        class CursorStub:
            def __init__(self) -> None:
                self.params = []

            def execute(self, query, params):
                self.params.append(params)

        cursor_stub = CursorStub()
        store = PersistentStore(Settings(data_mode="live", persistence_enabled=True))

        store._upsert_provider_cursors(cursor_stub)

        odds_params = next(params for params in cursor_stub.params if params[0] == "odds_api_io")
        assert odds_params[2] is None
        assert odds_params[4] == "resync_required"
        assert odds_params[6] is True
    finally:
        CURSORS.clear()


def test_save_odds_quotes_for_event_resolves_match_and_players() -> None:
    source_ts = datetime(2026, 6, 7, 20, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.queries = []
            self.params = []
            self.rowcount = 0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            self.params.append(params)
            self.rowcount = 1 if "INSERT INTO odds_ticks" in query else 0
            return self

        def fetchone(self):
            return {
                "match_id": "match_1",
                "player1_id": "p1",
                "player2_id": "p2",
                "p1_name": "Jannik Sinner",
                "p1_provider_ids": {"odds_api_io": "provider-p1"},
                "p2_name": "Carlos Alcaraz",
                "p2_provider_ids": {"odds_api_io": "provider-p2"},
            }

    class ConnStub:
        def __init__(self) -> None:
            self.cursor_stub = CursorStub()

        def cursor(self):
            return self.cursor_stub

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.conn = ConnStub()

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield self.conn

    store = StoreStub()

    inserted = store.save_odds_quotes_for_event(
        Provider.ODDS_API_IO,
        "event-1",
        [
            OddsQuote(bookmaker="SharpBook", player_id="provider-p1", decimal_odds=1.8, source_ts=source_ts),
            OddsQuote(bookmaker="SharpBook", player_id="Carlos Alcaraz", decimal_odds=2.1, source_ts=source_ts),
            OddsQuote(bookmaker="SharpBook", player_id="unknown", decimal_odds=9.9, source_ts=source_ts),
        ],
    )

    insert_params = [params for query, params in zip(store.conn.cursor_stub.queries, store.conn.cursor_stub.params) if "INSERT INTO odds_ticks" in query]
    assert inserted == 2
    assert store.conn.cursor_stub.params[0] == ("event-1", "event-1")
    assert len(insert_params) == 2
    assert insert_params[0][0] == "match_1"
    assert insert_params[0][4] == "p1"
    assert insert_params[1][4] == "p2"


def test_save_analyses_persists_theoddsapi_archive_odds_with_archive_provider() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.queries = []
            self.params = []
            self.rowcount = 1

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.queries.append(query)
            self.params.append(params)
            return self

    match = sample_matches()[0].model_copy(
        update={"provider_ids": {"api_tennis": "fixture-1", "theoddsapi": "archive-1"}}
    )
    store = PersistentStore(Settings(data_mode="live", persistence_enabled=True))
    cursor = CursorStub()

    store._insert_odds_ticks(cursor, match)

    insert_params = [
        params
        for query, params in zip(cursor.queries, cursor.params)
        if "INSERT INTO odds_ticks" in query
    ]
    assert insert_params
    assert {params[1] for params in insert_params} == {Provider.THE_ODDS_API.value}


def test_save_analyses_records_score_latency_for_primary_provider() -> None:
    class CursorStub:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))
            self.latencies = []

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

        def provider_cursors(self):
            return []

        def _upsert_player(self, cur, player):
            pass

        def _upsert_match(self, cur, match):
            pass

        def _insert_score_tick(self, cur, match, freshness=None):
            pass

        def _insert_odds_ticks(self, cur, match):
            pass

        def _insert_feature_snapshot(self, cur, features):
            return "feature_id"

        def _insert_prediction_snapshot(self, cur, prediction, feature_id):
            return "prediction_id"

        def _insert_signals(self, cur, signals, prediction_id, match):
            pass

        def _record_latency(self, cur, provider, feed, match):
            self.latencies.append((provider, feed))

        def _upsert_provider_cursors(self, cur, existing_cursors=None):
            pass

    repo = AnalysisRepository(Settings(data_mode="sample"))
    analysis = asyncio.run(repo.analyses_for_date(date.today()))[0]
    match = analysis.match.model_copy(
        update={"provider_ids": {"theoddsapi": "archive-only"}}
    )
    store = StoreStub()

    assert store.save_analyses([analysis.model_copy(update={"match": match})]) is True
    assert (Provider.THE_ODDS_API, "score/live") in store.latencies
    assert (Provider.API_TENNIS, "score/live") not in store.latencies


def test_insert_score_tick_uses_freshness_source_time_and_provider() -> None:
    source_ts = datetime(2026, 6, 8, 12, tzinfo=timezone.utc)

    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def execute(self, query, params=None):
            self.params = params

    base_match = sample_matches()[0]
    match = base_match.model_copy(
        update={
            "provider_ids": {"theoddsapi": "archive-only"},
            "state": base_match.state.model_copy(update={"status": "live"}),
        }
    )
    freshness = MatchFreshness(
        score_source_ts=source_ts,
        provider_lineage=[Provider.THE_ODDS_API],
    )
    cursor = CursorStub()
    store = PersistentStore(Settings(data_mode="live", persistence_enabled=True))

    store._insert_score_tick(cursor, match, freshness)

    assert cursor.params is not None
    assert cursor.params[1] == Provider.THE_ODDS_API.value
    assert cursor.params[3] == source_ts


def test_repository_ingests_odds_api_message_with_persisted_cursor() -> None:
    class StoreStub:
        def __init__(self) -> None:
            self.cursor = ProviderCursor(
                provider=Provider.ODDS_API_IO,
                stream="tennis:moneyline",
                last_seq=40,
                expected_next_seq=41,
                status=CursorStatus.HEALTHY,
                gap_count=0,
                resync_required=False,
                note="Persisted before restart.",
            )
            self.saved_payloads = []
            self.saved_cursor = None
            self.saved_latency = None

        @property
        def enabled(self) -> bool:
            return True

        def provider_cursors(self):
            return [self.cursor]

        def save_raw_payloads(self, payloads):
            self.saved_payloads = payloads
            return len(payloads)

        def save_odds_quotes_for_event(self, provider, source_event_id, quotes):
            self.saved_odds = (provider, source_event_id, quotes)
            return len(quotes)

        def save_provider_cursor(self, cursor):
            self.saved_cursor = cursor
            return True

        def record_provider_latency(self, provider, feed, *, latest_source_ts, latest_ingested_at):
            self.saved_latency = (provider, feed, latest_source_ts, latest_ingested_at)
            return True

    CURSORS.clear()
    repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))
    store = StoreStub()
    repo.store = store

    result = asyncio.run(
        repo.ingest_odds_api_message(
            OddsMessageIngestionRequest(
                payload={
                    "event_id": "event-1",
                    "seq": 41,
                    "timestamp": "2026-06-07T20:00:00Z",
                    "data": {
                        "bookmaker": "SharpBook",
                        "market": "ML",
                        "selections": [
                            {"player_id": "p1", "odds": 1.9},
                            {"player_id": "p2", "odds": 1.95},
                        ],
                    },
                }
            )
        )
    )

    assert result.persisted is True
    assert result.raw_payloads_saved == 1
    assert result.normalized_odds_saved == 2
    assert result.quotes == 2
    assert result.cursor.status == CursorStatus.HEALTHY
    assert result.cursor.last_seq == 41
    assert result.resync_required is False
    assert store.saved_payloads[0].provider == Provider.ODDS_API_IO
    assert store.saved_payloads[0].source_event_id == "event-1"
    assert store.saved_odds[0] == Provider.ODDS_API_IO
    assert store.saved_odds[1] == "event-1"
    assert len(store.saved_odds[2]) == 2
    assert store.saved_cursor == result.cursor
    assert store.saved_latency[0] == Provider.ODDS_API_IO
    assert store.saved_latency[1] == "odds/tennis:moneyline"
    assert CURSORS == {}


def test_repository_provider_cursor_resync_does_not_write_process_cache() -> None:
    class StoreStub:
        def __init__(self) -> None:
            self.saved_cursor = None

        def save_provider_cursor(self, cursor):
            self.saved_cursor = cursor
            return True

    CURSORS.clear()
    repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))
    store = StoreStub()
    repo.store = store

    result = asyncio.run(
        repo.mark_provider_cursor_resynced(
            ProviderCursorResyncRequest(last_seq=123),
        )
    )

    assert result.persisted is True
    assert result.cursor.last_seq == 123
    assert result.cursor.expected_next_seq == 124
    assert store.saved_cursor == result.cursor
    assert CURSORS == {}


def test_repository_odds_ingestion_does_not_read_process_cursor_cache() -> None:
    class StoreStub:
        def __init__(self) -> None:
            self.saved_cursor = None

        @property
        def enabled(self) -> bool:
            return True

        def provider_cursors(self):
            return []

        def save_raw_payloads(self, payloads):
            return len(payloads)

        def save_odds_quotes_for_event(self, provider, source_event_id, quotes):
            return len(quotes)

        def save_provider_cursor(self, cursor):
            self.saved_cursor = cursor
            return True

        def record_provider_latency(self, provider, feed, *, latest_source_ts, latest_ingested_at):
            return True

    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)
        repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))
        store = StoreStub()
        repo.store = store

        result = asyncio.run(
            repo.ingest_odds_api_message(
                OddsMessageIngestionRequest(
                    payload={
                        "event_id": "event-1",
                        "seq": 1,
                        "timestamp": "2026-06-07T20:00:00Z",
                        "data": {
                            "bookmaker": "SharpBook",
                            "market": "ML",
                            "selections": [
                                {"player_id": "p1", "odds": 1.9},
                                {"player_id": "p2", "odds": 1.95},
                            ],
                        },
                    },
                )
            )
        )

        assert result.cursor.status == CursorStatus.HEALTHY
        assert result.cursor.last_seq == 1
        assert result.cursor.expected_next_seq == 2
        assert store.saved_cursor == result.cursor
        assert CURSORS[(Provider.ODDS_API_IO, "tennis:moneyline")].last_seq == 88
    finally:
        CURSORS.clear()


def _provider_health_with_latency(
    settings: Settings,
    *,
    latest_ingested_at: datetime | None = None,
    latency_ms: int = 500,
    latency_rows=None,
    provider_warnings=None,
):
    latency_rows = latency_rows or [
        {
            "provider": Provider.API_TENNIS.value,
            "feed": "score/live",
            "latest_ingested_at": latest_ingested_at
            or datetime.now(timezone.utc).replace(microsecond=0),
            "latency_ms": latency_ms,
            "healthy": True,
        }
    ]

    class CursorStub:
        def __init__(self) -> None:
            self.last_query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.last_query = query
            return self

        def fetchall(self):
            if "FROM provider_latency" in self.last_query:
                return latency_rows
            if "FROM raw_provider_payloads" in self.last_query:
                return [{"provider": Provider.API_TENNIS.value, "count": 1}]
            return []

        def fetchone(self):
            if "FROM ingestion_runs" in self.last_query:
                return {"summary": {"provider_warnings": provider_warnings or []}}
            return None

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(settings)

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    return StoreStub().provider_health()


def test_has_replay_activity_reads_provider_latency_replay_feeds() -> None:
    class CursorStub:
        def __init__(self) -> None:
            self.params = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.params = params
            return self

        def fetchone(self):
            if self.params == ("%/replay%",):
                return {"exists": 1}
            return None

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", persistence_enabled=True))

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    assert StoreStub().has_replay_activity() is True


def test_provider_health_surfaces_latest_score_ingestion_warning() -> None:
    warning = "API-Tennis livescore endpoint failed: TimeoutError"
    health = _provider_health_with_latency(
        Settings(data_mode="live", api_tennis_key="key"),
        latest_ingested_at=datetime.now(timezone.utc).replace(microsecond=0),
        latency_ms=1200,
        provider_warnings=[warning],
    )
    api_tennis = next(item for item in health if item.provider == Provider.API_TENNIS)

    assert api_tennis.healthy is False
    assert "degraded" in api_tennis.status
    assert warning in api_tennis.status


def test_provider_health_does_not_mask_missing_key_with_persisted_latency() -> None:
    health = _provider_health_with_latency(
        Settings(data_mode="live", api_tennis_key=None),
        latest_ingested_at=datetime.now(timezone.utc).replace(microsecond=0),
        latency_ms=900,
    )
    api_tennis = next(item for item in health if item.provider == Provider.API_TENNIS)

    assert api_tennis.configured is False
    assert api_tennis.healthy is False
    assert "key missing" in api_tennis.status
    assert "persisted score/live" in api_tennis.status


def test_provider_health_marks_configured_provider_stale_when_persisted_feed_is_old() -> None:
    health = _provider_health_with_latency(
        Settings(
            data_mode="live",
            api_tennis_key="key",
            max_odds_staleness_ms=2500,
        ),
        latest_ingested_at=datetime.now(timezone.utc).replace(microsecond=0)
        - timedelta(seconds=10),
    )
    api_tennis = next(item for item in health if item.provider == Provider.API_TENNIS)

    assert api_tennis.configured is True
    assert api_tennis.healthy is False
    assert "stale persisted feed" in api_tennis.status


def test_provider_health_keeps_configured_provider_healthy_with_recent_persisted_feed() -> None:
    health = _provider_health_with_latency(
        Settings(
            data_mode="live",
            api_tennis_key="key",
            max_odds_staleness_ms=2500,
        ),
        latest_ingested_at=datetime.now(timezone.utc).replace(microsecond=0),
    )
    api_tennis = next(item for item in health if item.provider == Provider.API_TENNIS)

    assert api_tennis.configured is True
    assert api_tennis.healthy is True
    assert "stale persisted feed" not in api_tennis.status


def test_provider_health_aggregates_multiple_feeds_per_provider_conservatively() -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    health = _provider_health_with_latency(
        Settings(
            data_mode="live",
            odds_api_io_key="key",
            max_odds_staleness_ms=2500,
        ),
        latency_rows=[
            {
                "provider": Provider.ODDS_API_IO.value,
                "feed": "odds/moneyline",
                "latest_ingested_at": now,
                "latency_ms": 300,
                "healthy": True,
            },
            {
                "provider": Provider.ODDS_API_IO.value,
                "feed": "odds/tennis:moneyline",
                "latest_ingested_at": now - timedelta(seconds=8),
                "latency_ms": 700,
                "healthy": True,
            },
        ],
    )
    odds = next(item for item in health if item.provider == Provider.ODDS_API_IO)

    assert odds.configured is True
    assert odds.healthy is False
    assert odds.latency_ms == 700
    assert odds.last_message_at == now
    assert "odds/moneyline, odds/tennis:moneyline" in odds.status
    assert "stale persisted feed: odds/tennis:moneyline" in odds.status


def test_data_quality_surfaces_latest_score_ingestion_warning() -> None:
    warning = "API-Tennis fixtures endpoint failed: TimeoutError"

    class CursorStub:
        def __init__(self) -> None:
            self.last_query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.last_query = query
            return self

        def fetchall(self):
            if "SELECT kind" in self.last_query:
                return [
                    {"kind": "matches", "count": 2},
                    {"kind": "scores", "count": 2},
                    {"kind": "odds", "count": 4},
                ]
            if "FROM provider_latency" in self.last_query:
                return []
            return []

        def fetchone(self):
            if "provider_cursors" in self.last_query:
                return {"gaps": 0}
            if "FROM ingestion_runs" in self.last_query:
                return {"summary": {"provider_warnings": [warning]}}
            return None

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(Settings(data_mode="live", api_tennis_key="key"))

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    quality = StoreStub().data_quality()[0]

    assert quality.sequence_health == 0.7
    assert quality.blocked_signals == 1
    assert any(warning in note for note in quality.notes)


def test_data_quality_surfaces_stale_provider_latency_rows() -> None:
    stale_at = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=12)

    class CursorStub:
        def __init__(self) -> None:
            self.last_query = ""

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def execute(self, query, params=None):
            self.last_query = query
            return self

        def fetchall(self):
            if "SELECT kind" in self.last_query:
                return [
                    {"kind": "matches", "count": 2},
                    {"kind": "scores", "count": 2},
                    {"kind": "odds", "count": 4},
                ]
            if "FROM provider_latency" in self.last_query:
                return [
                    {
                        "provider": Provider.API_TENNIS.value,
                        "feed": "score/live",
                        "latest_ingested_at": stale_at,
                        "latency_ms": 400,
                        "healthy": True,
                    }
                ]
            return []

        def fetchone(self):
            if "provider_cursors" in self.last_query:
                return {"gaps": 0}
            if "FROM ingestion_runs" in self.last_query:
                return {"summary": {"provider_warnings": []}}
            return None

    class ConnStub:
        def cursor(self):
            return CursorStub()

    class StoreStub(PersistentStore):
        def __init__(self) -> None:
            super().__init__(
                Settings(
                    data_mode="live",
                    api_tennis_key="key",
                    max_odds_staleness_ms=2500,
                )
            )

        @property
        def enabled(self) -> bool:
            return True

        @contextmanager
        def _connect(self):
            yield ConnStub()

    quality = StoreStub().data_quality()[0]

    assert quality.sequence_health == 0.5
    assert quality.latency_ms == 400
    assert quality.stale_ticks == 1
    assert quality.blocked_signals == 1
    assert any("api_tennis:score/live" in note for note in quality.notes)


def test_odds_api_io_resync_blocks_live_entry_signals() -> None:
    CURSORS.clear()
    ingest_odds_api_sequence({"type": "resync_required"}, stream="tennis:moneyline")
    repo = AnalysisRepository(
        Settings(
            data_mode="live",
            persistence_enabled=False,
            odds_ws_resync_required_blocks_signals=True,
        )
    )
    repo.ingestion = LiveIngestionPipeline(
        _FakeMatchSource(_live_provider_matches()),
        _FakeArchiveSource(),
        _FakeStore(),
        signal_gate=repo._gate_signals_for_match,
        archive_augmenter=_same_matches,
    )

    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    entry_or_blocked = [
        signal
        for analysis in analyses
        for signal in analysis.signals
        if signal.reason.startswith("Odds websocket cursor requires resync")
    ]

    assert entry_or_blocked
    assert all(signal.status != SignalStatus.ENTRY for signal in entry_or_blocked)
    assert repo._apply_provider_gates([]) == []


def test_live_provider_cursors_ignore_process_cache_when_persistence_is_missing() -> None:
    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)
        repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))

        cursors = asyncio.run(repo.provider_cursors())
        odds_cursor = next(cursor for cursor in cursors if cursor.provider == Provider.ODDS_API_IO)

        assert odds_cursor.status == CursorStatus.RESYNC_REQUIRED
        assert odds_cursor.resync_required is True
        assert odds_cursor.last_seq is None
    finally:
        CURSORS.clear()


def test_live_data_quality_returns_no_fabricated_snapshot_when_persistence_is_missing() -> None:
    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)
        repo = AnalysisRepository(
            Settings(
                data_mode="live",
                persistence_enabled=False,
                odds_ws_resync_required_blocks_signals=True,
            )
        )

        snapshots = asyncio.run(repo.data_quality())

        assert snapshots == []
    finally:
        CURSORS.clear()


def test_the_odds_api_parser_maps_h2h_moneyline_quotes() -> None:
    client = TheOddsApiClient(api_key="key", data_mode="live")
    events = client.parse_odds_payload(
        "tennis_atp_french_open",
        [
            {
                "id": "event-1",
                "home_team": "Jannik Sinner",
                "away_team": "Alexander Zverev",
                "commence_time": "2026-05-19T12:00:00Z",
                "bookmakers": [
                    {
                        "title": "Pinnacle",
                        "last_update": "2026-05-19T11:55:00Z",
                        "markets": [
                            {
                                "key": "h2h",
                                "outcomes": [
                                    {"name": "Jannik Sinner", "price": 1.72},
                                    {"name": "Alexander Zverev", "price": 2.16},
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    )

    assert len(events) == 1
    assert events[0].sport_key == "tennis_atp_french_open"
    assert {quote.player_id for quote in events[0].quotes} == {
        "jannik sinner",
        "alexander zverev",
    }
    assert {quote.market for quote in events[0].quotes} == {"ML"}
    assert events[0].raw_payload is not None
    assert events[0].raw_payload.provider == Provider.THE_ODDS_API
    assert events[0].raw_payload.payload_type == "odds"
    assert events[0].raw_payload.payload["sport_key"] == "tennis_atp_french_open"


class _FakeMatchSource:
    def __init__(self, matches=None, exc: Exception | None = None) -> None:
        self.matches = matches
        self.exc = exc

    async def get_today_matches(self, target_date: date):
        if self.exc:
            raise self.exc
        return self.matches or []


class _FakeArchiveSource:
    async def get_tennis_h2h_events(self):
        return []


class _FakeStore:
    def __init__(self, persisted=None, saves_enabled: bool = True) -> None:
        self.persisted = persisted or []
        self.saves_enabled = saves_enabled
        self.saved_analyses = []
        self.saved_payloads = []

    def latest_analyses(self, target_date: date):
        return self.persisted

    def save_analyses(self, analyses):
        if not self.saves_enabled:
            return False
        self.saved_analyses = analyses
        return bool(analyses)

    def save_raw_payloads(self, payloads):
        if not self.saves_enabled:
            return 0
        self.saved_payloads = payloads
        return len(payloads)


class _FakeApiTennisClient:
    def __init__(
        self,
        fixtures=None,
        livescore=None,
        fixture_exc=None,
        livescore_exc=None,
    ) -> None:
        self.fixtures = fixtures
        self.livescore = livescore
        self.fixture_exc = fixture_exc
        self.livescore_exc = livescore_exc
        self.fixture_date = None
        self.livescore_called = False

    async def get_today_match_payloads(self, target_date: date):
        self.fixture_date = target_date
        if self.fixture_exc:
            raise self.fixture_exc
        return self.fixtures or []

    async def get_livescore_payloads(self):
        self.livescore_called = True
        if self.livescore_exc:
            raise self.livescore_exc
        return self.livescore or []


async def _same_matches(matches, archive_source):
    return matches


def _live_provider_matches():
    return [
        match.model_copy(
            update={
                "provider_ids": {"api_tennis": match.provider_match_id},
            }
        )
        for match in sample_matches()[:1]
    ]


def _api_tennis_raw(match, payload_type, source_ts=None):
    return RawProviderPayload(
        id=f"raw_{payload_type}_{match.provider_match_id}",
        provider=Provider.API_TENNIS,
        payload_type=payload_type,
        source_event_id=match.provider_match_id,
        source_ts=source_ts or match.scheduled_at,
        payload={
            "event_key": match.provider_match_id,
            "payload_type": payload_type,
            "status": match.state.status,
        },
        checksum=f"checksum-{payload_type}-{match.provider_match_id}",
    )


def test_api_tennis_match_source_combines_fixtures_and_livescore_payloads() -> None:
    fixture = _live_provider_matches()[0]
    livescore = fixture.model_copy(
        update={
            "state": fixture.state.model_copy(
                update={
                    "status": "live",
                    "p1_games": 2,
                    "p2_games": 1,
                }
            )
        }
    )
    target_date = date(2026, 6, 8)
    fake_client = _FakeApiTennisClient(
        fixtures=[
            ProviderMatchPayload(
                match=fixture,
                raw_payload=_api_tennis_raw(fixture, "fixture"),
            )
        ],
        livescore=[
            ProviderMatchPayload(
                match=livescore,
                raw_payload=_api_tennis_raw(livescore, "score"),
            )
        ],
    )
    source = ApiTennisMatchSource(fake_client)

    records = asyncio.run(source.get_today_matches(target_date))

    assert fake_client.fixture_date == target_date
    assert fake_client.livescore_called is True
    assert [record.raw_payload.payload_type for record in records] == ["fixture", "score"]


def test_api_tennis_match_source_keeps_livescore_when_fixture_endpoint_fails() -> None:
    base_match = _live_provider_matches()[0]
    match = base_match.model_copy(
        update={"state": base_match.state.model_copy(update={"status": "live"})}
    )
    fake_client = _FakeApiTennisClient(
        fixture_exc=RuntimeError("fixtures unavailable"),
        livescore=[
            ProviderMatchPayload(
                match=match,
                raw_payload=_api_tennis_raw(match, "score"),
            )
        ],
    )
    source = ApiTennisMatchSource(fake_client)

    records = asyncio.run(source.get_today_matches(date(2026, 6, 8)))

    assert fake_client.fixture_date == date(2026, 6, 8)
    assert fake_client.livescore_called is True
    assert len(records) == 1
    assert records[0].raw_payload.payload_type == "score"
    assert source.last_warnings == [
        "API-Tennis fixtures endpoint failed: RuntimeError"
    ]


def test_live_ingestion_pipeline_persists_provider_snapshot() -> None:
    store = _FakeStore()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource(_live_provider_matches()),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "provider_live"
    assert snapshot.persisted is True
    assert len(snapshot.analyses) == 1
    assert store.saved_analyses == snapshot.analyses
    assert len(store.saved_payloads) == 1
    assert snapshot.raw_payloads_saved == 1
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.source == "provider_live"
    assert snapshot.analyses[0].freshness.persisted is True
    assert store.saved_payloads[0].source_event_id == snapshot.analyses[0].match.provider_match_id


def test_live_ingestion_pipeline_merges_fixture_and_livescore_without_losing_raw_payloads() -> None:
    fixture = _live_provider_matches()[0]
    score_source_ts = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=20)
    livescore = fixture.model_copy(
        update={
            "state": fixture.state.model_copy(
                update={
                    "status": "live",
                    "p1_games": 4,
                    "p2_games": 3,
                    "point_score": "30-15",
                    "server_player_id": fixture.player1.id,
                }
            )
        }
    )
    store = _FakeStore()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource(
            [
                ProviderMatchPayload(
                    match=fixture,
                    raw_payload=_api_tennis_raw(fixture, "fixture"),
                ),
                ProviderMatchPayload(
                    match=livescore,
                    raw_payload=_api_tennis_raw(
                        livescore,
                        "score",
                        source_ts=score_source_ts,
                    ),
                ),
            ]
        ),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert len(snapshot.analyses) == 1
    assert snapshot.analyses[0].match.state.status == "live"
    assert snapshot.analyses[0].match.state.p1_games == 4
    assert snapshot.raw_payloads_saved == 2
    assert [payload.payload_type for payload in store.saved_payloads] == ["fixture", "score"]
    assert snapshot.analyses[0].match.state.source_latency_ms is not None
    assert snapshot.analyses[0].match.state.source_latency_ms > 0
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.score_source_ts == score_source_ts
    assert snapshot.analyses[0].freshness.score_age_ms is not None
    assert snapshot.analyses[0].freshness.score_age_ms > 0


def test_live_ingestion_pipeline_exposes_source_warnings() -> None:
    class WarningSource:
        last_warnings = ["API-Tennis livescore endpoint failed: TimeoutError"]

        async def get_today_matches(self, target_date):
            return []

    pipeline = LiveIngestionPipeline(
        WarningSource(),
        _FakeArchiveSource(),
        _FakeStore(),
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "empty"
    assert snapshot.provider_warnings == [
        "API-Tennis livescore endpoint failed: TimeoutError"
    ]


def test_repository_ingestion_run_records_provider_warnings_as_degraded() -> None:
    class WarningSource:
        last_warnings = ["API-Tennis fixtures endpoint failed: TimeoutError"]

        async def get_today_matches(self, target_date):
            return []

    repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))
    repo.ingestion = LiveIngestionPipeline(
        WarningSource(),
        _FakeArchiveSource(),
        _FakeStore(),
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )
    recorded = []

    def record_run(run_type, summary, **kwargs):
        recorded.append((run_type, summary))

    repo.record_ingestion_run = record_run

    result = asyncio.run(repo.run_ingestion())

    assert result.provider_warnings == [
        "API-Tennis fixtures endpoint failed: TimeoutError"
    ]
    assert recorded[0][0] == "score_snapshot"
    assert recorded[0][1]["provider_warnings"] == result.provider_warnings
    assert repo._ingestion_status(recorded[0][1]) == "degraded"


def test_live_ingestion_pipeline_prefers_provider_raw_payload_over_canonical_proxy() -> None:
    match = _live_provider_matches()[0]
    raw_payload = RawProviderPayload(
        id="raw_api_tennis_original",
        provider=Provider.API_TENNIS,
        payload_type="fixture",
        source_event_id=match.provider_match_id or match.id,
        source_ts=match.scheduled_at,
        payload={
            "event_key": match.provider_match_id,
            "provider_shape": "api_tennis_original",
        },
        checksum="provider-raw-checksum",
    )
    store = _FakeStore()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource([ProviderMatchPayload(match=match, raw_payload=raw_payload)]),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "provider_live"
    assert snapshot.raw_payloads_saved == 1
    assert snapshot.persisted is True
    assert store.saved_payloads == [raw_payload]
    assert store.saved_payloads[0].payload == {
        "event_key": match.provider_match_id,
        "provider_shape": "api_tennis_original",
    }


def test_live_ingestion_pipeline_marks_theoddsapi_archive_lineage() -> None:
    match = _live_provider_matches()[0]
    events = TheOddsApiClient(api_key="key", data_mode="live").parse_odds_payload(
        "tennis_atp_french_open",
        [
            {
                "id": "archive-event-1",
                "home_team": match.player1.name,
                "away_team": match.player2.name,
                "commence_time": match.scheduled_at.isoformat(),
                "bookmakers": [
                    {
                        "title": "Pinnacle",
                        "last_update": match.scheduled_at.isoformat(),
                        "markets": [
                            {
                                "key": "h2h",
                                "outcomes": [
                                    {"name": match.player1.name, "price": 1.72},
                                    {"name": match.player2.name, "price": 2.16},
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    )

    class ArchiveSource:
        async def get_tennis_h2h_events(self):
            return events

    repo = AnalysisRepository(
        Settings(data_mode="live", the_odds_api_key="key", persistence_enabled=False)
    )
    store = _FakeStore()
    repo.store = store
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource([match]),
        ArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=repo._augment_with_archive_odds,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))
    lineage = snapshot.analyses[0].freshness.provider_lineage

    assert Provider.API_TENNIS in lineage
    assert Provider.THE_ODDS_API in lineage
    assert Provider.ODDS_API_IO not in lineage


def test_live_ingestion_pipeline_exposes_theoddsapi_archive_warnings() -> None:
    match = _live_provider_matches()[0]

    class ArchiveSource:
        def __init__(self) -> None:
            self.last_warnings = []

        async def get_tennis_h2h_events(self):
            raise RuntimeError("archive unavailable")

    repo = AnalysisRepository(
        Settings(data_mode="live", the_odds_api_key="key", persistence_enabled=False)
    )
    store = _FakeStore()
    archive_source = ArchiveSource()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource([match]),
        archive_source,
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=repo._augment_with_archive_odds,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "provider_live"
    assert len(snapshot.analyses) == 1
    assert snapshot.provider_warnings == [
        "TheOddsAPI archive endpoint failed: RuntimeError"
    ]


def test_live_ingestion_pipeline_does_not_claim_persistence_when_store_does_not_save() -> None:
    store = _FakeStore(saves_enabled=False)
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource(_live_provider_matches()),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "provider_live"
    assert snapshot.persisted is False
    assert snapshot.raw_payloads_saved == 0
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.persisted is False
    assert store.saved_analyses == []
    assert store.saved_payloads == []


def test_live_ingestion_pipeline_uses_persisted_fallback_after_provider_failure() -> None:
    persisted = asyncio.run(
        LiveIngestionPipeline(
            _FakeMatchSource(_live_provider_matches()),
            _FakeArchiveSource(),
            _FakeStore(),
            signal_gate=lambda match, signals: signals,
            archive_augmenter=_same_matches,
        ).snapshot_for_date(date.today())
    ).analyses
    store = _FakeStore(persisted=persisted)
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource(exc=RuntimeError("provider down")),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "persisted_fallback"
    assert snapshot.persisted is True
    assert snapshot.raw_payloads_saved == 0
    assert snapshot.analyses == persisted
    assert store.saved_analyses == []
    assert store.saved_payloads == []


def test_repository_regates_persisted_fallback_when_odds_cursor_requires_resync() -> None:
    persisted = asyncio.run(
        LiveIngestionPipeline(
            _FakeMatchSource(_live_provider_matches()),
            _FakeArchiveSource(),
            _FakeStore(),
            signal_gate=lambda match, signals: signals,
            archive_augmenter=_same_matches,
        ).snapshot_for_date(date.today())
    ).analyses
    persisted = [
        persisted[0].model_copy(
            update={
                "signals": [
                    persisted[0].signals[0].model_copy(
                        update={
                            "status": SignalStatus.ENTRY,
                            "stake_fraction": 0.01,
                            "reason": "Persisted entry before cursor degraded.",
                        }
                    ),
                    *persisted[0].signals[1:],
                ]
            }
        ),
        *persisted[1:],
    ]
    assert any(
        signal.status == SignalStatus.ENTRY
        for analysis in persisted
        for signal in analysis.signals
    )
    repo = AnalysisRepository(
        Settings(
            data_mode="live",
            persistence_enabled=False,
            odds_ws_resync_required_blocks_signals=True,
        )
    )
    repo.ingestion = LiveIngestionPipeline(
        _FakeMatchSource(exc=RuntimeError("provider down")),
        _FakeArchiveSource(),
        _FakeStore(persisted=persisted),
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    assert analyses
    assert all(
        signal.status != SignalStatus.ENTRY
        for analysis in analyses
        for signal in analysis.signals
    )
    assert any(
        signal.reason.startswith("Odds websocket cursor requires resync")
        for analysis in analyses
        for signal in analysis.signals
    )


def test_live_ingestion_pipeline_labels_sample_snapshots_explicitly() -> None:
    store = _FakeStore()
    pipeline = LiveIngestionPipeline(
        _FakeMatchSource(sample_matches()[:1]),
        _FakeArchiveSource(),
        store,
        signal_gate=lambda match, signals: signals,
        archive_augmenter=_same_matches,
    )

    snapshot = asyncio.run(pipeline.snapshot_for_date(date.today()))

    assert snapshot.source == "sample"
    assert snapshot.persisted is False
    assert snapshot.raw_payloads_saved == 0
    assert store.saved_analyses == []
    assert store.saved_payloads == []
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.source == "sample"

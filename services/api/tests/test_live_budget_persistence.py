import asyncio
from contextlib import contextmanager
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone

from tennis_edge.config import Settings
from tennis_edge.domain import CursorStatus
from tennis_edge.domain import IngestionRunRecord
from tennis_edge.domain import MatchFreshness
from tennis_edge.domain import OddsMessageIngestionRequest, ProviderCursorResyncRequest
from tennis_edge.domain import Provider
from tennis_edge.domain import ProviderCursor
from tennis_edge.domain import ProviderMatchPayload
from tennis_edge.domain import RawProviderPayload
from tennis_edge.domain import OddsQuote
from tennis_edge.domain import SignalStatus
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.api_tennis_source import ApiTennisMatchSource
from tennis_edge.services.ingestion import LiveIngestionPipeline
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

        def _insert_signals(self, cur, signals, prediction_id):
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


def test_live_data_quality_ignores_process_cursor_cache_when_persistence_is_missing() -> None:
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
        odds_snapshot = next(
            snapshot for snapshot in snapshots if snapshot.provider == Provider.ODDS_API_IO
        )

        assert odds_snapshot.sequence_health == 0.35
        assert odds_snapshot.blocked_signals == 1
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

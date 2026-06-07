import asyncio
from contextlib import contextmanager
from datetime import date
from datetime import datetime
from datetime import timezone

from tennis_edge.config import Settings
from tennis_edge.domain import CursorStatus
from tennis_edge.domain import Provider
from tennis_edge.domain import ProviderCursor
from tennis_edge.domain import ProviderMatchPayload
from tennis_edge.domain import RawProviderPayload
from tennis_edge.domain import SignalStatus
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches
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
    def __init__(self, persisted=None) -> None:
        self.persisted = persisted or []
        self.saved_analyses = []
        self.saved_payloads = []

    def latest_analyses(self, target_date: date):
        return self.persisted

    def save_analyses(self, analyses):
        self.saved_analyses = analyses

    def save_raw_payloads(self, payloads):
        self.saved_payloads = payloads


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
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.source == "provider_live"
    assert store.saved_payloads[0].source_event_id == snapshot.analyses[0].match.provider_match_id


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
    assert store.saved_payloads == [raw_payload]
    assert store.saved_payloads[0].payload == {
        "event_key": match.provider_match_id,
        "provider_shape": "api_tennis_original",
    }


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
    assert snapshot.analyses[0].freshness is not None
    assert snapshot.analyses[0].freshness.source == "sample"

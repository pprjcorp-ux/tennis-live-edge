import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import SignalStatus
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.ingestion import LiveIngestionPipeline
from tennis_edge.services.provider_cursor import CURSORS, ingest_odds_api_sequence
from tennis_edge.services.repository import AnalysisRepository
from tennis_edge.services.storage import PersistentStore


def test_persistence_is_disabled_for_sample_mode_even_with_database_url() -> None:
    store = PersistentStore(
        Settings(
            data_mode="sample",
            database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        )
    )

    assert store.enabled is False
    assert store.latest_analyses(date.today()) == []


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

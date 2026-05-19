import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import SignalStatus
from tennis_edge.providers.the_odds_api import TheOddsApiClient
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

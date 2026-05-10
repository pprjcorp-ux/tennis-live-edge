from datetime import date

from tennis_edge.domain import Provider
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.providers.betradar_uof import parse_betradar_market_state
from tennis_edge.providers.odds_api_io import OddsApiIoClient
from tennis_edge.providers.sportradar import parse_sportradar_point, parse_sportradar_score
from tennis_edge.providers.txodds import parse_txodds_moneyline
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.normalizer import dedupe_payloads, normalize_name, payload_checksum, similarity
from tennis_edge.services.replay_engine import ReplayEngine


def test_sportradar_score_and_point_parsing() -> None:
    payloads = sample_raw_payloads()
    score_payload = next(item for item in payloads if item.provider == Provider.SPORTRADAR and item.payload_type == "score")
    point_payload = next(item for item in payloads if item.provider == Provider.SPORTRADAR and item.payload_type == "point")

    score = parse_sportradar_score(score_payload)
    point = parse_sportradar_point(point_payload)

    assert score.match_id == "match_atp_002"
    assert score.state.server_player_id == "atp_zverev"
    assert point.sequence == 88
    assert point.point_score == "40-40"


def test_txodds_and_betradar_parsing() -> None:
    payloads = sample_raw_payloads()
    odds_payload = next(item for item in payloads if item.provider == Provider.TXODDS)
    market_payload = next(item for item in payloads if item.provider == Provider.BETRADAR_UOF)

    quotes = parse_txodds_moneyline(odds_payload)
    market_state = parse_betradar_market_state(market_payload)

    assert {quote.player_id for quote in quotes} == {"atp_zverev", "atp_navone"}
    assert market_state.status == "suspended"
    assert market_state.reason


def test_dedupe_and_replay_are_deterministic() -> None:
    payloads = sample_raw_payloads()
    duplicated = payloads + [payloads[0]]
    unique = dedupe_payloads(duplicated)
    replay = ReplayEngine().replay(duplicated)

    assert len(unique) == len(payloads)
    assert len(replay.score_ticks) == 2
    assert len(replay.odds_quotes) == 4
    assert len(replay.market_states) == 1


def test_name_normalization_for_provider_matching() -> None:
    assert normalize_name("  Jannik   Sinner!") == "jannik sinner"
    assert similarity("Jannik Sinner", "J. Sinner") > 0.7


def test_payload_checksum_includes_provider_event_and_source_timestamp() -> None:
    payload = {"match_id": "m1", "status": "live"}
    first = payload_checksum(Provider.SPORTRADAR, "score", payload, "event-1", "2026-05-10T12:00:00Z")
    second = payload_checksum(Provider.SPORTRADAR, "score", payload, "event-2", "2026-05-10T12:00:00Z")
    third = payload_checksum(Provider.SPORTRADAR, "score", payload, "event-1", "2026-05-10T12:00:01Z")

    assert first != second
    assert first != third


def test_api_tennis_parser_uses_provider_payload_not_sample_matches() -> None:
    client = ApiTennisClient(api_key="key", data_mode="live")
    matches = client._parse_matches(
        {
            "result": [
                {
                    "event_key": "42",
                    "event_date": date.today().isoformat(),
                    "event_time": "13:30",
                    "event_first_player": "Elena Rybakina",
                    "event_second_player": "Ons Jabeur",
                    "event_first_player_key": "101",
                    "event_second_player_key": "102",
                    "event_type_type": "WTA Singles",
                    "tournament_name": "Rome WTA",
                    "tournament_round": "QF",
                    "tournament_surface": "Clay",
                    "event_status": "Set 1",
                    "event_game_result": "4 - 3",
                    "event_point": "30 - 15",
                    "event_serve": "First Player",
                }
            ]
        },
        default_status="live",
    )

    assert len(matches) == 1
    assert matches[0].id == "api_tennis_42"
    assert matches[0].tour == "WTA"
    assert matches[0].state.status == "live"
    assert matches[0].state.p1_games == 4
    assert matches[0].player1.name == "Elena Rybakina"


def test_odds_api_io_message_parser_maps_moneyline_quotes() -> None:
    client = OddsApiIoClient(api_key="key", data_mode="live")
    quotes = client.parse_message(
        {
            "data": {
                "bookmaker": "SharpBook",
                "market": "h2h",
                "timestamp": "2026-05-10T12:00:00Z",
                "selections": [
                    {"player_id": "p1", "odds": 1.8},
                    {"player_id": "p2", "odds": 2.1},
                ],
            }
        }
    )

    assert [quote.player_id for quote in quotes] == ["p1", "p2"]
    assert {quote.market for quote in quotes} == {"ML"}

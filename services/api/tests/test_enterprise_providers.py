import asyncio
from datetime import date

from tennis_edge.domain import (
    CanonicalMatch,
    OddsTick,
    Provider,
    ProviderCursor,
    ProviderLatency,
    ProviderMatchPayload,
    RawProviderPayload,
    ScoreTick,
)
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.providers.betradar_uof import parse_betradar_market_state
from tennis_edge.providers.odds_api_io import OddsApiIoClient, parse_odds_api_io_moneyline
from tennis_edge.providers.sportradar import parse_sportradar_point, parse_sportradar_score
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.providers.txodds import parse_txodds_moneyline
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.budget_replay_fixtures import sample_budget_replay_payloads
from tennis_edge.services.normalizer import dedupe_payloads, normalize_name, payload_checksum, similarity
from tennis_edge.services.provider_adapters import (
    ArchiveOddsProviderAdapter,
    BUDGET_PROVIDER_CONTRACT_SPECS,
    OddsProviderAdapter,
    ScoreProviderAdapter,
    canonical_match_from_provider_payload,
    provider_latency_from_payload,
)
from tennis_edge.services.provider_cursor import CURSORS, mark_resynced
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
    payload = {
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
    }
    records = client._parse_match_payloads(payload, default_status="live")
    matches = client._parse_matches(payload, default_status="live")

    assert len(matches) == 1
    assert matches[0].id == "api_tennis_42"
    assert matches[0].tour == "WTA"
    assert matches[0].state.status == "live"
    assert matches[0].state.p1_games == 4
    assert matches[0].player1.name == "Elena Rybakina"
    assert len(records) == 1
    assert records[0].match == matches[0]
    assert records[0].raw_payload.provider == Provider.API_TENNIS
    assert records[0].raw_payload.payload_type == "score"
    assert records[0].raw_payload.source_event_id == "42"
    assert records[0].raw_payload.payload["event_key"] == "42"


def test_budget_provider_clients_satisfy_adapter_contracts() -> None:
    assert isinstance(ApiTennisClient(api_key=None, data_mode="sample"), ScoreProviderAdapter)
    assert isinstance(OddsApiIoClient(api_key=None, data_mode="sample"), OddsProviderAdapter)
    assert isinstance(TheOddsApiClient(api_key=None, data_mode="sample"), ArchiveOddsProviderAdapter)
    assert isinstance(ApiTennisClient(api_key=None, data_mode="replay"), ScoreProviderAdapter)
    assert isinstance(OddsApiIoClient(api_key=None, data_mode="replay"), OddsProviderAdapter)
    assert isinstance(TheOddsApiClient(api_key=None, data_mode="replay"), ArchiveOddsProviderAdapter)


def test_budget_provider_contract_specs_freeze_internal_artifacts() -> None:
    matrix = {spec.provider: spec for spec in BUDGET_PROVIDER_CONTRACT_SPECS}
    all_contracts = {
        contract
        for spec in BUDGET_PROVIDER_CONTRACT_SPECS
        for contract in [*spec.input_contracts, *spec.output_contracts]
    }

    assert set(matrix) == {
        Provider.API_TENNIS,
        Provider.ODDS_API_IO,
        Provider.THE_ODDS_API,
    }
    assert all_contracts.issuperset(
        {
            "RawProviderPayload",
            "CanonicalMatch",
            "ScoreTick",
            "OddsTick",
            "ProviderCursor",
            "ProviderLatency",
        }
    )
    assert matrix[Provider.API_TENNIS].adapter_contract == "ScoreProviderAdapter"
    assert matrix[Provider.API_TENNIS].output_contracts == (
        "ScoreTick",
        "ProviderLatency",
    )
    assert matrix[Provider.ODDS_API_IO].adapter_contract == "OddsProviderAdapter"
    assert matrix[Provider.ODDS_API_IO].output_contracts == (
        "OddsTick",
        "ProviderCursor",
        "ProviderLatency",
    )
    assert matrix[Provider.THE_ODDS_API].adapter_contract == "ArchiveOddsProviderAdapter"
    assert matrix[Provider.THE_ODDS_API].output_contracts == (
        "OddsTick",
        "ProviderLatency",
    )
    assert all(spec.status == "covered" for spec in BUDGET_PROVIDER_CONTRACT_SPECS)


def test_replay_mode_provider_clients_use_fake_api_without_live_calls() -> None:
    async def collect_odds_messages() -> list[dict]:
        return [
            message
            async for message in OddsApiIoClient(
                api_key="configured-but-offline",
                data_mode="replay",
            ).stream_live_messages()
        ]

    score_records = asyncio.run(
        ApiTennisClient(
            api_key="configured-but-offline",
            data_mode="replay",
        ).get_livescore_payloads()
    )
    archive_events = asyncio.run(
        TheOddsApiClient(
            api_key="configured-but-offline",
            data_mode="replay",
        ).get_tennis_h2h_events()
    )

    assert score_records
    assert all(record.raw_payload.provider == Provider.API_TENNIS for record in score_records)
    assert archive_events
    assert all(event.raw_payload is not None for event in archive_events)
    assert asyncio.run(collect_odds_messages()) == []


def test_budget_adapter_contract_matrix_outputs_internal_formats_without_live_keys() -> None:
    score_adapter = ApiTennisClient(api_key=None, data_mode="sample")
    odds_adapter = OddsApiIoClient(api_key=None, data_mode="sample")
    archive_adapter = TheOddsApiClient(api_key=None, data_mode="sample")

    score_records = asyncio.run(score_adapter.get_livescore_payloads())
    assert score_records
    score_replay = ReplayEngine().replay([record.raw_payload for record in score_records])
    score_latency = provider_latency_from_payload(score_records[0].raw_payload, feed="score/live")

    odds_message = {
        "event_id": "contract-match-1",
        "seq": 1,
        "lastSeq": 0,
        "timestamp": "2026-05-10T12:00:00Z",
        "data": {
            "bookmaker": "ContractBook",
            "market": "moneyline",
            "selections": [
                {"player_id": "contract_p1", "odds": 1.9},
                {"player_id": "contract_p2", "odds": 1.95},
            ],
        },
    }
    odds_raw_payload = odds_adapter.raw_payload_from_message(odds_message)
    odds_ticks, odds_cursor = odds_adapter.ingest_message(
        odds_message,
        remember_in_process=False,
    )
    odds_latency = provider_latency_from_payload(
        odds_raw_payload,
        feed="odds/tennis:moneyline",
    )

    archive_events = asyncio.run(archive_adapter.get_tennis_h2h_events())
    archive_payloads = [
        event.raw_payload for event in archive_events if event.raw_payload is not None
    ]
    assert archive_payloads
    archive_replay = ReplayEngine().replay(archive_payloads)
    archive_latency = provider_latency_from_payload(archive_payloads[0], feed="odds/archive")

    assert isinstance(score_records[0], ProviderMatchPayload)
    assert isinstance(score_records[0].raw_payload, RawProviderPayload)
    assert isinstance(canonical_match_from_provider_payload(score_records[0]), CanonicalMatch)
    assert score_replay.notes == []
    assert all(isinstance(tick, ScoreTick) for tick in score_replay.score_ticks)
    assert isinstance(score_latency, ProviderLatency)
    assert score_latency.provider == Provider.API_TENNIS
    assert score_latency.feed == "score/live"

    assert isinstance(odds_raw_payload, RawProviderPayload)
    assert all(isinstance(tick, OddsTick) for tick in odds_ticks)
    assert isinstance(odds_cursor, ProviderCursor)
    assert odds_cursor.resync_required is False
    assert isinstance(odds_latency, ProviderLatency)
    assert odds_latency.provider == Provider.ODDS_API_IO
    assert odds_latency.feed == "odds/tennis:moneyline"

    assert all(isinstance(payload, RawProviderPayload) for payload in archive_payloads)
    assert archive_replay.notes == []
    assert all(isinstance(tick, OddsTick) for tick in archive_replay.odds_quotes)
    assert isinstance(archive_latency, ProviderLatency)
    assert archive_latency.provider == Provider.THE_ODDS_API
    assert archive_latency.feed == "odds/archive"


def test_score_adapter_returns_replayable_provider_match_payloads() -> None:
    client = ApiTennisClient(api_key=None, data_mode="sample")

    records = asyncio.run(client.get_livescore_payloads())
    replay = ReplayEngine().replay([record.raw_payload for record in records])
    canonical = canonical_match_from_provider_payload(records[0])
    latency = provider_latency_from_payload(records[0].raw_payload, feed="score/live")

    assert records
    assert all(record.raw_payload.provider == Provider.API_TENNIS for record in records)
    assert all(record.raw_payload.payload_type == "score" for record in records)
    assert all(record.raw_payload.source_event_id for record in records)
    assert all(record.match.id for record in records)
    assert replay.score_ticks
    assert all(isinstance(tick, ScoreTick) for tick in replay.score_ticks)
    assert {tick.match_id for tick in replay.score_ticks}.issubset(
        {record.match.id for record in records}
    )
    assert isinstance(canonical, CanonicalMatch)
    assert canonical.id == records[0].match.id
    assert canonical.provider_ids["primary"] == records[0].match.provider_match_id
    assert canonical.player1_id == records[0].match.player1.id
    assert canonical.player2_id == records[0].match.player2.id
    assert latency.provider == Provider.API_TENNIS
    assert latency.feed == "score/live"
    assert latency.latency_ms >= 0


def test_odds_adapter_returns_raw_payload_odds_ticks_cursor_and_latency() -> None:
    client = OddsApiIoClient(api_key="key", data_mode="live")
    payload = {
        "event_id": "42",
        "seq": 20,
        "timestamp": "2026-05-10T12:00:00Z",
        "data": {
            "bookmaker": "SharpBook",
            "market": "moneyline",
            "selections": [
                {"player_id": "p1", "odds": 1.8},
                {"player_id": "p2", "odds": 2.1},
            ],
        },
    }

    raw_payload = client.raw_payload_from_message(payload)
    odds_ticks, cursor = client.ingest_message(payload, remember_in_process=False)
    latency = provider_latency_from_payload(raw_payload, feed="odds/tennis:moneyline")

    assert isinstance(raw_payload, RawProviderPayload)
    assert raw_payload.provider == Provider.ODDS_API_IO
    assert all(isinstance(tick, OddsTick) for tick in odds_ticks)
    assert {tick.player_id for tick in odds_ticks} == {"p1", "p2"}
    assert cursor.last_seq == 20
    assert latency.provider == Provider.ODDS_API_IO
    assert latency.feed == "odds/tennis:moneyline"
    assert latency.latency_ms >= 0


def test_archive_odds_adapter_returns_replayable_snapshot_events() -> None:
    events = TheOddsApiClient(api_key="key", data_mode="live").parse_odds_payload(
        "tennis_atp_french_open",
        [
            {
                "id": "event-archive-1",
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

    assert events
    assert events[0].raw_payload is not None
    assert events[0].raw_payload.provider == Provider.THE_ODDS_API
    assert all(isinstance(tick, OddsTick) for tick in events[0].quotes)
    assert {tick.player_id for tick in events[0].quotes} == {
        "jannik sinner",
        "alexander zverev",
    }


def test_archive_odds_adapter_sample_snapshots_are_replayable() -> None:
    client = TheOddsApiClient(api_key=None, data_mode="sample")

    events = asyncio.run(client.get_tennis_h2h_events())
    assert events
    assert all(event.raw_payload is not None for event in events)

    replay = ReplayEngine().replay(
        [event.raw_payload for event in events if event.raw_payload is not None]
    )
    raw_payload = events[0].raw_payload
    assert raw_payload is not None
    latency = provider_latency_from_payload(raw_payload, feed="odds/archive")

    assert all(
        event.raw_payload.provider == Provider.THE_ODDS_API
        for event in events
        if event.raw_payload
    )
    assert all(
        event.raw_payload.payload_type == "odds"
        for event in events
        if event.raw_payload
    )
    assert replay.odds_quotes
    assert len(replay.odds_quotes) == sum(len(event.quotes) for event in events)
    assert {"jannik sinner", "alexander zverev"}.issubset(
        {quote.player_id for quote in replay.odds_quotes}
    )
    assert latency.provider == Provider.THE_ODDS_API
    assert latency.feed == "odds/archive"
    assert latency.latency_ms >= 0


def test_budget_replay_fixtures_exercise_provider_contracts_without_keys() -> None:
    payloads = sample_budget_replay_payloads("match_atp_002", odds_scenario="gap")
    replay = ReplayEngine().replay(payloads)
    latencies = [
        provider_latency_from_payload(
            payload,
            feed="score/live" if payload.payload_type == "score" else "odds/replay",
        )
        for payload in payloads
    ]

    assert {payload.provider for payload in payloads} == {
        Provider.API_TENNIS,
        Provider.ODDS_API_IO,
        Provider.THE_ODDS_API,
    }
    assert all(isinstance(payload, RawProviderPayload) for payload in payloads)
    assert all(payload.source_event_id for payload in payloads)
    assert replay.score_ticks
    assert all(isinstance(tick, ScoreTick) for tick in replay.score_ticks)
    assert replay.odds_quotes
    assert all(isinstance(tick, OddsTick) for tick in replay.odds_quotes)
    assert replay.provider_cursors
    assert replay.provider_cursors[0].resync_required is True
    assert all(latency.latency_ms >= 0 for latency in latencies)
    assert {latency.provider for latency in latencies} == {
        Provider.API_TENNIS,
        Provider.ODDS_API_IO,
        Provider.THE_ODDS_API,
    }


def test_budget_provider_payloads_replay_to_score_and_odds_ticks() -> None:
    api_client = ApiTennisClient(api_key="key", data_mode="live")
    score_records = api_client._parse_match_payloads(
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
                    "tournament_name": "Wimbledon",
                    "tournament_round": "R4",
                    "tournament_surface": "Grass",
                    "event_status": "Set 1",
                    "event_game_result": "4 - 3",
                    "event_point": "30 - 15",
                    "event_serve": "First Player",
                }
            ]
        },
        default_status="live",
    )
    odds_raw = OddsApiIoClient(api_key="key", data_mode="live").raw_payload_from_message(
        {
            "event_id": "42",
            "seq": 9,
            "timestamp": "2026-05-10T12:00:00Z",
            "data": {
                "bookmaker": "SharpBook",
                "market": "moneyline",
                "selections": [
                    {"player_id": "wta_api_tennis_101", "odds": 1.72},
                    {"player_id": "wta_api_tennis_102", "odds": 2.18},
                ],
            },
        }
    )

    replay = ReplayEngine().replay([score_records[0].raw_payload, odds_raw])

    assert len(replay.score_ticks) == 1
    assert replay.score_ticks[0].provider == Provider.API_TENNIS
    assert replay.score_ticks[0].match_id == "api_tennis_42"
    assert replay.score_ticks[0].state.p1_games == 4
    assert replay.score_ticks[0].state.point_score == "30-15"
    assert len(replay.odds_quotes) == 2
    assert {quote.player_id for quote in replay.odds_quotes} == {
        "wta_api_tennis_101",
        "wta_api_tennis_102",
    }
    assert all(quote.ingested_at == odds_raw.ingested_at for quote in replay.odds_quotes)


def test_replay_tracks_odds_api_sequence_gap_without_process_cursor() -> None:
    CURSORS.clear()
    try:
        client = OddsApiIoClient(api_key="key", data_mode="live")
        payloads = [
            client.raw_payload_from_message(
                {
                    "event_id": "42",
                    "seq": 10,
                    "timestamp": "2026-05-10T12:00:00Z",
                    "data": {
                        "bookmaker": "SharpBook",
                        "market": "moneyline",
                        "selections": [{"player_id": "p1", "odds": 1.8}],
                    },
                }
            ),
            client.raw_payload_from_message(
                {
                    "event_id": "42",
                    "seq": 12,
                    "timestamp": "2026-05-10T12:00:01Z",
                    "data": {
                        "bookmaker": "SharpBook",
                        "market": "moneyline",
                        "selections": [{"player_id": "p1", "odds": 1.9}],
                    },
                }
            ),
        ]

        replay = ReplayEngine().replay(payloads)

        assert len(replay.odds_quotes) == 2
        assert len(replay.provider_cursors) == 1
        assert replay.provider_cursors[0].resync_required is True
        assert replay.provider_cursors[0].last_seq == 10
        assert replay.provider_cursors[0].expected_next_seq == 11
        assert CURSORS == {}
    finally:
        CURSORS.clear()


def test_replay_parses_theoddsapi_archive_snapshot() -> None:
    raw_payload = TheOddsApiClient(api_key="key", data_mode="live").parse_odds_payload(
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
    )[0].raw_payload
    assert raw_payload is not None

    replay = ReplayEngine().replay([raw_payload])

    assert len(replay.odds_quotes) == 2
    assert {quote.player_id for quote in replay.odds_quotes} == {
        "jannik sinner",
        "alexander zverev",
    }


def test_api_tennis_live_without_key_returns_no_synthetic_matches() -> None:
    client = ApiTennisClient(api_key=None, data_mode="live")

    fixtures = asyncio.run(client.get_today_matches(date.today()))
    livescore = asyncio.run(client.get_livescore())

    assert fixtures == []
    assert livescore == []


def test_odds_api_io_message_parser_maps_moneyline_quotes() -> None:
    client = OddsApiIoClient(api_key="key", data_mode="live")
    payload = {
        "event_id": "event-1",
        "seq": 1,
        "data": {
            "bookmaker": "SharpBook",
            "market": "h2h",
            "timestamp": "2026-05-10T12:00:00Z",
            "selections": [
                {"player_id": "p1", "odds": 1.8},
                {"player_id": "p2", "odds": 2.1},
            ],
        },
    }

    quotes = client.parse_message(payload)
    raw_payload = client.raw_payload_from_message(payload)

    assert [quote.player_id for quote in quotes] == ["p1", "p2"]
    assert {quote.market for quote in quotes} == {"ML"}
    assert raw_payload.provider == Provider.ODDS_API_IO
    assert raw_payload.payload_type == "odds"
    assert raw_payload.source_event_id == "event-1"
    assert raw_payload.source_ts.isoformat() == "2026-05-10T12:00:00+00:00"
    assert raw_payload.payload["stream"] == "tennis:moneyline"


def test_odds_api_io_raw_payload_parser_writes_process_cursor_by_default() -> None:
    CURSORS.clear()
    try:
        client = OddsApiIoClient(api_key="key", data_mode="live")
        raw_payload = client.raw_payload_from_message(
            {
                "event_id": "event-1",
                "seq": 1,
                "data": {
                    "bookmaker": "SharpBook",
                    "market": "h2h",
                    "timestamp": "2026-05-10T12:00:00Z",
                    "selections": [
                        {"player_id": "p1", "odds": 1.8},
                        {"player_id": "p2", "odds": 2.1},
                    ],
                },
            }
        )

        quotes = parse_odds_api_io_moneyline(raw_payload)

        assert len(quotes) == 2
        assert CURSORS[(Provider.ODDS_API_IO, "tennis:moneyline")].last_seq == 1
    finally:
        CURSORS.clear()


def test_replay_engine_does_not_write_odds_api_process_cursor() -> None:
    CURSORS.clear()
    try:
        mark_resynced(Provider.ODDS_API_IO, "tennis:moneyline", 88)
        client = OddsApiIoClient(api_key="key", data_mode="live")
        raw_payload = client.raw_payload_from_message(
            {
                "event_id": "event-1",
                "seq": 1,
                "data": {
                    "bookmaker": "SharpBook",
                    "market": "h2h",
                    "timestamp": "2026-05-10T12:00:00Z",
                    "selections": [
                        {"player_id": "p1", "odds": 1.8},
                        {"player_id": "p2", "odds": 2.1},
                    ],
                },
            }
        )

        replay = ReplayEngine().replay([raw_payload])

        assert len(replay.odds_quotes) == 2
        assert [quote.player_id for quote in replay.odds_quotes] == ["p1", "p2"]
        assert CURSORS[(Provider.ODDS_API_IO, "tennis:moneyline")].last_seq == 88
    finally:
        CURSORS.clear()


def test_odds_api_io_ingest_message_returns_quotes_and_cursor_for_custom_stream() -> None:
    client = OddsApiIoClient(api_key="key", data_mode="live")
    quotes, cursor = client.ingest_message(
        {
            "seq": 7,
            "odds": [
                {
                    "bookmaker": "SharpBook",
                    "market": "moneyline",
                    "selections": {"p1": 1.8, "p2": 2.1},
                }
            ],
        },
        stream="tennis:live:ml",
    )

    assert len(quotes) == 2
    assert cursor.stream == "tennis:live:ml"
    assert cursor.last_seq == 7


def test_odds_api_io_subscription_message_includes_last_seq_when_available() -> None:
    client = OddsApiIoClient(api_key="key", data_mode="live")

    message = client.subscription_message("tennis:moneyline", last_seq=42)
    without_cursor = client.subscription_message("tennis:moneyline")

    assert message["type"] == "subscribe"
    assert message["sport"] == "tennis"
    assert message["lastSeq"] == 42
    assert "lastSeq" not in without_cursor

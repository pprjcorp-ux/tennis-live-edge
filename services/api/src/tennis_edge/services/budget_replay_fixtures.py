from __future__ import annotations

from tennis_edge.domain import Match, RawProviderPayload
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.providers.odds_api_io import OddsApiIoClient
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches
from tennis_edge.services.normalizer import normalize_name


def sample_budget_replay_payloads(match_id: str) -> list[RawProviderPayload]:
    match = _sample_match_for_replay(match_id)
    if match is None:
        return []

    payloads = [_api_tennis_score_payload(match)]
    if match.odds:
        payloads.append(_odds_api_io_payload(match))
        archive_payload = _the_odds_api_payload(match)
        if archive_payload is not None:
            payloads.append(archive_payload)
    return payloads


def _sample_match_for_replay(match_id: str) -> Match | None:
    for match in sample_matches():
        candidates = {
            match.id,
            match.provider_match_id,
            *match.provider_ids.values(),
        }
        if match_id in candidates:
            return match
    return None


def _api_tennis_score_payload(match: Match) -> RawProviderPayload:
    client = ApiTennisClient(api_key=None, data_mode="sample")
    return client._raw_payload_for_match(
        client._sample_event_payload(match),
        match,
        payload_type="score",
    )


def _odds_api_io_payload(match: Match) -> RawProviderPayload:
    latest_source_ts = max(quote.source_ts for quote in match.odds)
    rows = [
        {
            "bookmaker": quote.bookmaker,
            "market": "moneyline",
            "timestamp": quote.source_ts.isoformat(),
            "selections": [
                {
                    "player_id": quote.player_id,
                    "odds": quote.decimal_odds,
                }
            ],
        }
        for quote in match.odds
    ]
    return OddsApiIoClient(api_key=None, data_mode="sample").raw_payload_from_message(
        {
            "event_id": match.provider_match_id or match.id,
            "seq": 1,
            "timestamp": latest_source_ts.isoformat(),
            "data": rows,
        }
    )


def _the_odds_api_payload(match: Match) -> RawProviderPayload | None:
    name_key = frozenset({normalize_name(match.player1.name), normalize_name(match.player2.name)})
    events = TheOddsApiClient(api_key=None, data_mode="sample")._sample_h2h_events()
    event = next((event for event in events if event.name_key == name_key), None)
    return event.raw_payload if event is not None else None

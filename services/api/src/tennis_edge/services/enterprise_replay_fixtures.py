from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from tennis_edge.domain import Provider, RawProviderPayload
from tennis_edge.services.normalizer import payload_checksum


ENTERPRISE_SHADOW_FIXTURE_MATCH_ID = "match_enterprise_shadow_001"
_BASE_TS = datetime(2026, 5, 24, 14, 0, tzinfo=timezone.utc)


def sample_enterprise_shadow_payloads(
    match_id: str = ENTERPRISE_SHADOW_FIXTURE_MATCH_ID,
) -> list[RawProviderPayload]:
    """Offline enterprise fixtures for shadow/deferred provider contracts.

    These payloads are deliberately not wired into the budget replay contract
    runner. They document and test enterprise feed semantics without keys,
    sockets, quotas, or account access.
    """

    return [
        _payload(
            provider=Provider.SPORTRADAR,
            payload_type="score",
            source_event_id=f"{match_id}:sportradar:timeline:1",
            source_offset_seconds=0,
            payload={
                "match_id": match_id,
                "sport_event_id": "sr:match:enterprise-shadow-001",
                "status": "live",
                "period": "SECOND_SET",
                "home_score": {"sets": 1, "games": 4, "point": "40"},
                "away_score": {"sets": 0, "games": 3, "point": "30"},
                "server": "atp_shadow_p1",
                "provider_api_call_allowed": False,
                "fixture_mode": "offline_shadow",
                "timeline": [
                    {
                        "id": 451,
                        "type": "point",
                        "set": 2,
                        "game": 8,
                        "server": "atp_shadow_p1",
                        "winner": "atp_shadow_p1",
                        "score": "40-30",
                    },
                    {
                        "id": 452,
                        "type": "delay",
                        "reason": "medical_timeout_review",
                    },
                    {
                        "id": 453,
                        "type": "retirement_check",
                        "status": "not_retired",
                    },
                ],
            },
        ),
        _payload(
            provider=Provider.BETRADAR_UOF,
            payload_type="market_state",
            source_event_id=f"{match_id}:betradar:market-state:1",
            source_offset_seconds=2,
            payload={
                "match_id": match_id,
                "bookmaker": "BetradarShadow",
                "market": "ML",
                "status": "suspended",
                "reason": "betstop while point is under review",
                "market_id": "uof:market:shadow:ml",
                "producer": "liveodds_shadow",
                "provider_api_call_allowed": False,
                "fixture_mode": "offline_shadow",
            },
        ),
        _payload(
            provider=Provider.TXODDS,
            payload_type="odds",
            source_event_id=f"{match_id}:txodds:odds:1",
            source_offset_seconds=4,
            payload={
                "match_id": match_id,
                "bookmaker": "TXODDSShadow",
                "market": "ML",
                "sequence": 9842201,
                "provider_api_call_allowed": False,
                "fixture_mode": "offline_shadow",
                "odds": {
                    "atp_shadow_p1": 1.74,
                    "atp_shadow_p2": 2.18,
                },
            },
        ),
        _payload(
            provider=Provider.BETFAIR,
            payload_type="odds",
            source_event_id=f"{match_id}:betfair:market-stream:1",
            source_offset_seconds=6,
            payload={
                "match_id": match_id,
                "stream_type": "market_book",
                "marketId": "1.234567890",
                "publishTime": "2026-05-24T14:00:06Z",
                "provider_api_call_allowed": False,
                "fixture_mode": "offline_shadow",
                "marketDefinition": {
                    "status": "OPEN",
                    "bettingType": "ODDS",
                    "marketTime": "2026-05-24T14:15:00Z",
                    "runners": [
                        {"selectionId": 10101, "name": "ATP Shadow P1"},
                        {"selectionId": 20202, "name": "ATP Shadow P2"},
                    ],
                },
                "runners": [
                    {
                        "selectionId": 10101,
                        "lastPriceTraded": 1.75,
                        "ex": {
                            "availableToBack": [{"price": 1.74, "size": 2450.0}],
                            "availableToLay": [{"price": 1.76, "size": 1980.0}],
                            "tradedVolume": [{"price": 1.75, "size": 10320.0}],
                        },
                    },
                    {
                        "selectionId": 20202,
                        "lastPriceTraded": 2.16,
                        "ex": {
                            "availableToBack": [{"price": 2.14, "size": 1720.0}],
                            "availableToLay": [{"price": 2.18, "size": 2250.0}],
                            "tradedVolume": [{"price": 2.16, "size": 8410.0}],
                        },
                    },
                ],
            },
        ),
    ]


def _payload(
    *,
    provider: Provider,
    payload_type: str,
    source_event_id: str,
    source_offset_seconds: int,
    payload: dict[str, Any],
) -> RawProviderPayload:
    source_ts = _BASE_TS + timedelta(seconds=source_offset_seconds)
    checksum = payload_checksum(provider, payload_type, payload, source_event_id, source_ts)
    return RawProviderPayload(
        id=f"{provider.value}:{payload_type}:{source_event_id}:{checksum[:12]}",
        provider=provider,
        payload_type=payload_type,  # type: ignore[arg-type]
        source_event_id=source_event_id,
        source_ts=source_ts,
        ingested_at=source_ts + timedelta(milliseconds=175),
        payload=payload,
        checksum=checksum,
    )

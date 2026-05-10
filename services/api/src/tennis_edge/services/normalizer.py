from __future__ import annotations

from difflib import SequenceMatcher
from hashlib import sha256
import json
import re
from datetime import datetime
from typing import Any

from tennis_edge.domain import (
    CanonicalMatch,
    CompetitionLevel,
    Confidence,
    Match,
    Provider,
    RawProviderPayload,
)


def normalize_name(value: str) -> str:
    lowered = value.strip().lower()
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, normalize_name(left), normalize_name(right)).ratio()


def canonical_player_id(name: str, tour: str) -> str:
    slug = normalize_name(name).replace(" ", "_")
    return f"{tour.lower()}_{slug}"


def payload_checksum(
    provider: Provider,
    payload_type: str,
    payload: dict[str, Any],
    source_event_id: str | None = None,
    source_ts: datetime | str | None = None,
) -> str:
    raw = json.dumps(
        {
            "provider": provider,
            "payload_type": payload_type,
            "source_event_id": source_event_id,
            "source_ts": source_ts,
            "payload": payload,
        },
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    return sha256(raw).hexdigest()


def dedupe_payloads(payloads: list[RawProviderPayload]) -> list[RawProviderPayload]:
    seen: set[str] = set()
    unique: list[RawProviderPayload] = []
    for payload in sorted(payloads, key=lambda item: (item.source_ts, item.id)):
        if payload.checksum in seen:
            continue
        seen.add(payload.checksum)
        unique.append(payload)
    return unique


def competition_data_quality(level: CompetitionLevel, provider_count: int) -> float:
    base = {
        CompetitionLevel.ATP: 0.96,
        CompetitionLevel.WTA: 0.94,
        CompetitionLevel.CHALLENGER: 0.78,
        CompetitionLevel.WTA125: 0.74,
        CompetitionLevel.ITF: 0.58,
    }[level]
    provider_bonus = min(0.12, max(0, provider_count - 1) * 0.06)
    return min(1.0, base + provider_bonus)


def canonical_match_from_match(match: Match) -> CanonicalMatch:
    provider_ids = dict(match.provider_ids)
    if match.provider_match_id:
        provider_ids.setdefault("primary", match.provider_match_id)

    provider_count = len([value for value in provider_ids.values() if value])
    confidence = Confidence.HIGH
    if match.competition_level in {CompetitionLevel.CHALLENGER, CompetitionLevel.WTA125}:
        confidence = Confidence.MEDIUM
    if match.competition_level == CompetitionLevel.ITF or provider_count < 2:
        confidence = Confidence.LOW

    return CanonicalMatch(
        id=match.id,
        provider_ids=provider_ids,
        tournament=match.tournament,
        round=match.round,
        tour=match.tour,
        competition_level=match.competition_level,
        surface=match.surface,
        scheduled_at=match.scheduled_at,
        player1_id=match.player1.id,
        player2_id=match.player2.id,
        status=match.state.status,
        confidence=confidence,
    )

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from tennis_edge.config import Settings
from tennis_edge.domain import CursorStatus, Provider, ProviderCursor


CURSORS: dict[tuple[Provider, str], ProviderCursor] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def cursor_key(provider: Provider, stream: str) -> tuple[Provider, str]:
    return (provider, stream)


def default_provider_cursors(
    settings: Settings,
    *,
    use_process_cache: bool = False,
) -> list[ProviderCursor]:
    if use_process_cache and CURSORS:
        return sorted(CURSORS.values(), key=lambda item: (item.provider, item.stream))
    odds_cursor_healthy = settings.data_mode == "sample"
    cursors = [
        _provider_cursor(
            Provider.ODDS_API_IO,
            "tennis:moneyline",
            last_seq=1024 if odds_cursor_healthy else None,
            status=CursorStatus.HEALTHY
            if odds_cursor_healthy
            else CursorStatus.RESYNC_REQUIRED,
            note=(
                "Sample cursor. Live mode persists Odds-API.io seq/lastSeq for replay and resync."
                if odds_cursor_healthy
                else "Live odds cursor has no trusted seq/lastSeq yet; REST resync or websocket sequence is required."
            ),
        ),
        _provider_cursor(
            Provider.SPORTRADAR,
            "tennis:score",
            last_seq=None,
            status=CursorStatus.HEALTHY if settings.data_mode == "sample" else CursorStatus.RESYNC_REQUIRED,
            note="Enterprise score cursor waits for Sportradar contract payload validation.",
        ),
    ]
    if use_process_cache:
        for cursor in cursors:
            CURSORS[cursor_key(cursor.provider, cursor.stream)] = cursor
    return sorted(cursors, key=lambda item: (item.provider, item.stream))


def _provider_cursor(
    provider: Provider,
    stream: str,
    *,
    last_seq: int | None,
    status: CursorStatus,
    note: str,
) -> ProviderCursor:
    return ProviderCursor(
        provider=provider,
        stream=stream,
        last_seq=last_seq,
        expected_next_seq=last_seq + 1 if last_seq is not None else None,
        status=status,
        gap_count=0,
        resync_required=status == CursorStatus.RESYNC_REQUIRED,
        last_message_at=_now() if status != CursorStatus.RESYNC_REQUIRED else None,
        note=note,
    )


def seed_provider_cursor(
    provider: Provider,
    stream: str,
    *,
    last_seq: int | None,
    status: CursorStatus,
    note: str,
) -> ProviderCursor:
    cursor = _provider_cursor(
        provider,
        stream,
        last_seq=last_seq,
        status=status,
        note=note,
    )
    CURSORS[cursor_key(provider, stream)] = cursor
    return cursor


def ingest_odds_api_sequence(
    payload: dict[str, Any],
    *,
    stream: str = "tennis:moneyline",
    current_cursor: ProviderCursor | None = None,
) -> ProviderCursor:
    """Track Odds-API.io seq/lastSeq semantics without losing gap state."""
    key = cursor_key(Provider.ODDS_API_IO, stream)
    current = current_cursor or CURSORS.get(key)
    seq = payload.get("seq")
    message_type = str(payload.get("type", "updated"))
    now = _now()

    if message_type == "resync_required":
        cursor = ProviderCursor(
            provider=Provider.ODDS_API_IO,
            stream=stream,
            last_seq=current.last_seq if current else None,
            expected_next_seq=current.expected_next_seq if current else None,
            status=CursorStatus.RESYNC_REQUIRED,
            gap_count=(current.gap_count if current else 0) + 1,
            resync_required=True,
            last_message_at=now,
            last_resync_at=current.last_resync_at if current else None,
            note="Provider requested REST resync before signals can trust odds state.",
        )
        CURSORS[key] = cursor
        return cursor

    if not isinstance(seq, int):
        cursor = current or seed_provider_cursor(
            Provider.ODDS_API_IO,
            stream,
            last_seq=None,
            status=CursorStatus.RESYNC_REQUIRED,
            note="Missing seq in websocket payload.",
        )
        cursor = cursor.model_copy(
            update={
                "status": CursorStatus.RESYNC_REQUIRED,
                "resync_required": True,
                "gap_count": cursor.gap_count + 1,
                "last_message_at": now,
                "note": "Missing seq in websocket payload.",
            }
        )
        CURSORS[key] = cursor
        return cursor

    expected = current.expected_next_seq if current else None
    if expected is not None and seq != expected:
        cursor = ProviderCursor(
            provider=Provider.ODDS_API_IO,
            stream=stream,
            last_seq=current.last_seq,
            expected_next_seq=expected,
            status=CursorStatus.GAP_DETECTED,
            gap_count=current.gap_count + 1,
            resync_required=True,
            last_message_at=now,
            last_resync_at=current.last_resync_at,
            note=f"Sequence gap detected: expected {expected}, received {seq}.",
        )
    else:
        cursor = ProviderCursor(
            provider=Provider.ODDS_API_IO,
            stream=stream,
            last_seq=seq,
            expected_next_seq=seq + 1,
            status=CursorStatus.HEALTHY,
            gap_count=current.gap_count if current else 0,
            resync_required=False,
            last_message_at=now,
            last_resync_at=current.last_resync_at if current else None,
            note="Sequence accepted.",
        )
    CURSORS[key] = cursor
    return cursor


def mark_resynced(provider: Provider, stream: str, seq: int) -> ProviderCursor:
    cursor = ProviderCursor(
        provider=provider,
        stream=stream,
        last_seq=seq,
        expected_next_seq=seq + 1,
        status=CursorStatus.RESYNCED,
        gap_count=0,
        resync_required=False,
        last_message_at=_now(),
        last_resync_at=_now(),
        note="REST snapshot applied; websocket can reconnect with lastSeq.",
    )
    CURSORS[cursor_key(provider, stream)] = cursor
    return cursor

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json

from tennis_edge.config import get_settings
from tennis_edge.domain import OddsMessageIngestionRequest, Provider
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Consume Odds-API.io websocket messages through the persistent ingestion path."
    )
    parser.add_argument(
        "--stream",
        default="tennis:moneyline",
        help="Provider stream key. Defaults to tennis:moneyline.",
    )
    parser.add_argument(
        "--max-messages",
        type=int,
        default=25,
        help="Maximum websocket messages to ingest before exiting.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=30,
        help="Wall-clock timeout for this run.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Connect even if the persisted cursor says resync_required.",
    )
    return parser.parse_args()


async def run_odds_stream_ingestion(
    repo: AnalysisRepository,
    *,
    stream: str = "tennis:moneyline",
    max_messages: int = 25,
    timeout_seconds: float = 30,
    force: bool = False,
) -> dict[str, object]:
    settings = repo.settings
    summary = {
        "provider": Provider.ODDS_API_IO.value,
        "stream": stream,
        "connected": False,
        "resync_required": False,
        "start_last_seq": None,
        "messages": 0,
        "quotes": 0,
        "raw_payloads_saved": 0,
        "normalized_odds_saved": 0,
        "timed_out": False,
        "reason": None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    if settings.data_mode == "sample" or not settings.odds_api_io_key:
        summary["reason"] = "ODDS_API_IO_KEY is missing or data mode is sample; websocket not opened."
        return summary

    cursor = next(
        (
            item
            for item in await repo.provider_cursors()
            if item.provider == Provider.ODDS_API_IO and item.stream == stream
        ),
        None,
    )
    if cursor is not None:
        summary["resync_required"] = cursor.resync_required
        summary["start_last_seq"] = cursor.last_seq
        if cursor.resync_required and not force:
            summary["reason"] = "Persisted cursor requires REST resync before websocket consumption."
            return summary

    try:
        async with asyncio.timeout(timeout_seconds):
            async for payload in repo.odds_api_io.stream_live_messages(
                stream=stream,
                last_seq=summary["start_last_seq"],
            ):
                result = await repo.ingest_odds_api_message(
                    OddsMessageIngestionRequest(payload=payload, stream=stream)
                )
                summary["connected"] = True
                summary["messages"] += 1
                summary["quotes"] += result.quotes
                summary["raw_payloads_saved"] += result.raw_payloads_saved
                summary["normalized_odds_saved"] += result.normalized_odds_saved
                summary["resync_required"] = result.resync_required
                if summary["messages"] >= max(1, max_messages):
                    break
    except TimeoutError:
        summary["timed_out"] = True
        summary["reason"] = "Timed out while waiting for websocket messages."
    return summary


async def _run() -> None:
    args = _parse_args()
    repo = AnalysisRepository(get_settings())
    summary = await run_odds_stream_ingestion(
        repo,
        stream=args.stream,
        max_messages=args.max_messages,
        timeout_seconds=args.timeout_seconds,
        force=args.force,
    )

    print(json.dumps(summary))


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

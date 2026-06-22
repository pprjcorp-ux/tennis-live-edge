from __future__ import annotations

import argparse
import asyncio
import json
import sys

from tennis_edge.config import get_settings
from tennis_edge.domain import OddsMessageIngestionRequest
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Persist one Odds-API.io websocket-style odds message from stdin."
    )
    parser.add_argument(
        "--stream",
        default="tennis:moneyline",
        help="Provider stream key. Defaults to tennis:moneyline.",
    )
    return parser.parse_args()


async def _run() -> None:
    args = _parse_args()
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("stdin must contain a JSON object payload")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise SystemExit("stdin JSON must be an object")

    repo = AnalysisRepository(get_settings())
    result = await repo.ingest_odds_api_message(
        OddsMessageIngestionRequest(payload=payload, stream=args.stream)
    )
    print(result.model_dump_json())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import asyncio
from datetime import date

from tennis_edge.config import get_settings
from tennis_edge.domain import IngestionRunRequest
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one Tennis Live Edge ingestion cycle.")
    parser.add_argument(
        "--date",
        dest="target_date",
        help="Target match date in YYYY-MM-DD format. Defaults to today.",
    )
    return parser.parse_args()


async def _run() -> None:
    args = _parse_args()
    target_date = date.fromisoformat(args.target_date) if args.target_date else None
    repo = AnalysisRepository(get_settings())
    result = await repo.run_ingestion(IngestionRunRequest(target_date=target_date))
    print(result.model_dump_json())


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

import argparse
import asyncio
import json
from datetime import date

from tennis_edge.config import get_settings
from tennis_edge.domain import IngestionRunRequest
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one API-Tennis fixtures/livescore sync smoke without archive odds."
    )
    parser.add_argument(
        "--date",
        dest="target_date",
        help="Target match date in YYYY-MM-DD format. Defaults to today.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the sync result JSON.",
    )
    return parser.parse_args()


async def _run() -> None:
    args = _parse_args()
    target_date = date.fromisoformat(args.target_date) if args.target_date else None
    repo = AnalysisRepository(get_settings())
    result = await repo.sync_api_tennis_scores(
        IngestionRunRequest(target_date=target_date),
        source="cli",
    )
    print(json.dumps(result.model_dump(mode="json"), indent=2 if args.pretty else None))


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

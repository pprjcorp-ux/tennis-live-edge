import argparse
import asyncio
import json

from tennis_edge.config import get_settings
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one TheOddsAPI REST/archive sync smoke without touching live signals."
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the sync result JSON.",
    )
    return parser.parse_args()


async def _run() -> None:
    args = _parse_args()
    repo = AnalysisRepository(get_settings())
    result = await repo.sync_archive_odds(source="cli")
    print(json.dumps(result.model_dump(mode="json"), indent=2 if args.pretty else None))


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

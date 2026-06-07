from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime, timezone
import json

from tennis_edge.config import get_settings
from tennis_edge.domain import IngestionRunRequest
from tennis_edge.ingest_odds_stream import run_odds_stream_ingestion
from tennis_edge.services.repository import AnalysisRepository


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one budget live ingestion cycle: API-Tennis score snapshot plus Odds-API.io stream."
    )
    parser.add_argument(
        "--date",
        dest="target_date",
        help="Target match date in YYYY-MM-DD format. Defaults to today.",
    )
    parser.add_argument(
        "--odds-stream",
        default="tennis:moneyline",
        help="Odds-API.io stream key. Defaults to tennis:moneyline.",
    )
    parser.add_argument(
        "--odds-max-messages",
        type=int,
        default=25,
        help="Maximum websocket messages to ingest before exiting.",
    )
    parser.add_argument(
        "--odds-timeout-seconds",
        type=float,
        default=30,
        help="Wall-clock timeout for the Odds-API.io websocket portion.",
    )
    parser.add_argument(
        "--force-odds-stream",
        action="store_true",
        help="Open the odds websocket even if the persisted cursor requires resync.",
    )
    return parser.parse_args()


async def run_live_budget_cycle(
    repo: AnalysisRepository,
    *,
    target_date: date | None = None,
    odds_stream: str = "tennis:moneyline",
    odds_max_messages: int = 25,
    odds_timeout_seconds: float = 30,
    force_odds_stream: bool = False,
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc).replace(microsecond=0)
    score_result = await repo.run_ingestion(
        IngestionRunRequest(target_date=target_date),
        source="cli",
    )
    odds_result = await run_odds_stream_ingestion(
        repo,
        stream=odds_stream,
        max_messages=odds_max_messages,
        timeout_seconds=odds_timeout_seconds,
        force=force_odds_stream,
    )
    execution = await repo.execution_status()
    summary = {
        "profile": repo.settings.runtime_profile,
        "coverage": sorted(repo.settings.coverage_set),
        "target_date": score_result.target_date.isoformat(),
        "score_ingestion": score_result.model_dump(mode="json"),
        "odds_ingestion": odds_result,
        "can_submit_real_orders": execution.can_submit_real_orders,
        "real_execution_hard_block": execution.real_execution_hard_block,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    repo.record_ingestion_run(
        "live_budget_cycle",
        summary,
        source="cli",
        started_at=started_at,
    )
    return summary


async def _run() -> None:
    args = _parse_args()
    target_date = date.fromisoformat(args.target_date) if args.target_date else None
    repo = AnalysisRepository(get_settings())
    result = await run_live_budget_cycle(
        repo,
        target_date=target_date,
        odds_stream=args.odds_stream,
        odds_max_messages=args.odds_max_messages,
        odds_timeout_seconds=args.odds_timeout_seconds,
        force_odds_stream=args.force_odds_stream,
    )
    print(json.dumps(result))


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()

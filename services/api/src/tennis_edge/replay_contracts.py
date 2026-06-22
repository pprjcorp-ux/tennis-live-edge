from __future__ import annotations

import argparse
import asyncio
from typing import Literal

from tennis_edge.config import get_settings
from tennis_edge.domain import (
    ReplayContractRunRequest,
    ReplayContractRunResult,
    ReplayContractScenario,
)
from tennis_edge.services.repository import AnalysisRepository


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run Tennis Live Edge fake-provider replay contracts for score, odds, "
            "cursor gaps and resync behavior without live API keys."
        )
    )
    parser.add_argument(
        "--match-id",
        default="match_atp_002",
        help="Fixture/canonical match id to replay. Defaults to match_atp_002.",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        choices=["healthy", "gap", "resync_required"],
        help=(
            "Replay odds scenario to run. Repeat for multiple scenarios. "
            "Defaults to all contract scenarios."
        ),
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output for humans.",
    )
    return parser.parse_args(argv)


async def run_replay_contracts(
    repo: AnalysisRepository,
    *,
    match_id: str,
    scenarios: list[ReplayContractScenario] | None = None,
    source: Literal["api", "cli", "hermes", "openclaw", "cron", "system"] = "cli",
) -> ReplayContractRunResult:
    request = ReplayContractRunRequest(match_id=match_id)
    if scenarios:
        request.scenarios = scenarios
    return await repo.run_replay_contracts(request, source=source)


async def _run(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    repo = AnalysisRepository(get_settings())
    result = await run_replay_contracts(
        repo,
        match_id=args.match_id,
        scenarios=args.scenario,
    )
    print(result.model_dump_json(indent=2 if args.pretty else None))
    return 0 if result.passed else 2


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()

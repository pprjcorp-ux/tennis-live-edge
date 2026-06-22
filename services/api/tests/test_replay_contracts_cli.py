import asyncio

from tennis_edge import replay_contracts
from tennis_edge.domain import (
    ReplayContractRunRequest,
    ReplayContractRunResult,
    ReplayContractScenarioResult,
)


def _contract_result(*, match_id: str, passed: bool) -> ReplayContractRunResult:
    return ReplayContractRunResult(
        match_id=match_id,
        passed=passed,
        scenarios=[
            ReplayContractScenarioResult(
                scenario="healthy",
                run_id="replay_test",
                final_status="completed" if passed else "degraded",
                events_replayed=3 if passed else 0,
                score_ticks=1 if passed else 0,
                odds_ticks=2 if passed else 0,
                providers_seen=[],
                output_contracts=[],
                passed=passed,
            )
        ],
        notes=["test contract"],
    )


def test_run_replay_contracts_uses_cli_source_and_selected_scenarios() -> None:
    class RepoStub:
        def __init__(self) -> None:
            self.request: ReplayContractRunRequest | None = None
            self.source: str | None = None

        async def run_replay_contracts(self, request, *, source):
            self.request = request
            self.source = source
            return _contract_result(match_id=request.match_id, passed=True)

    repo = RepoStub()

    result = asyncio.run(
        replay_contracts.run_replay_contracts(
            repo,
            match_id="match_atp_002",
            scenarios=["gap"],
        )
    )

    assert result.passed is True
    assert repo.source == "cli"
    assert repo.request is not None
    assert repo.request.match_id == "match_atp_002"
    assert repo.request.scenarios == ["gap"]


def test_replay_contract_cli_exit_code_reflects_contract_status(monkeypatch, capsys) -> None:
    class RepoStub:
        async def run_replay_contracts(self, request, *, source):
            assert source == "cli"
            assert request.match_id == "match_atp_999"
            assert request.scenarios == ["healthy"]
            return _contract_result(match_id=request.match_id, passed=False)

    monkeypatch.setattr(replay_contracts, "get_settings", lambda: object())
    monkeypatch.setattr(replay_contracts, "AnalysisRepository", lambda settings: RepoStub())

    exit_code = asyncio.run(
        replay_contracts._run(
            ["--match-id", "match_atp_999", "--scenario", "healthy"]
        )
    )

    captured = capsys.readouterr()

    assert exit_code == 2
    assert '"match_id":"match_atp_999"' in captured.out
    assert '"passed":false' in captured.out

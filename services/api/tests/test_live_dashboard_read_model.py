import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import MatchFreshness, Provider
from tennis_edge.services.repository import AnalysisRepository


def test_live_dashboard_read_model_builds_dashboard_snapshot_from_inputs() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample", persistence_enabled=False))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    paper = asyncio.run(repo.paper_performance())

    snapshot = repo.dashboard_read_model.snapshot(date.today(), analyses, paper)

    assert snapshot.matches == analyses
    assert snapshot.metrics.matches == len(analyses)
    assert snapshot.signals == sorted(
        [signal for analysis in analyses for signal in analysis.signals],
        key=lambda signal: signal.edge,
        reverse=True,
    )
    assert snapshot.operational_state.cost_profile.active_plan == "lean_atp"
    assert snapshot.operational_state.source_summary.total_matches == len(analyses)
    assert snapshot.operational_state.source_summary.source_counts == {"sample": len(analyses)}
    assert len(snapshot.operational_state.source_summary.match_freshness) == len(analyses)
    assert snapshot.operational_state.source_summary.match_freshness[0].match_id == analyses[0].match.id
    assert snapshot.operational_state.source_summary.match_freshness[0].source == "sample"
    assert snapshot.readiness.can_submit_real_orders is False


def test_operational_source_summary_counts_persisted_and_runtime_sources() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample", persistence_enabled=False))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))
    mixed = [
        analyses[0].model_copy(
            update={
                "freshness": MatchFreshness(
                    source="provider_live",
                    persisted=True,
                    provider_lineage=[Provider.API_TENNIS, Provider.THE_ODDS_API],
                )
            }
        ),
        analyses[1].model_copy(
            update={
                "freshness": MatchFreshness(
                    source="persisted_fallback",
                    persisted=True,
                    provider_lineage=[Provider.API_TENNIS],
                )
            }
        ),
        analyses[2].model_copy(
            update={
                "freshness": MatchFreshness(
                    source="sample",
                    persisted=False,
                    provider_lineage=[Provider.SAMPLE],
                )
            }
        ),
    ]

    summary = repo.operational_state.source_summary(mixed)

    assert summary.total_matches == 3
    assert summary.persisted_matches == 2
    assert summary.volatile_matches == 1
    assert summary.source_counts == {
        "provider_live": 1,
        "persisted_fallback": 1,
        "sample": 1,
    }
    assert summary.provider_lineage == [
        Provider.API_TENNIS,
        Provider.SAMPLE,
        Provider.THE_ODDS_API,
    ]
    assert [row.match_id for row in summary.match_freshness] == [
        analyses[0].match.id,
        analyses[1].match.id,
        analyses[2].match.id,
    ]
    assert [row.source for row in summary.match_freshness] == [
        "provider_live",
        "persisted_fallback",
        "sample",
    ]
    assert [row.persisted for row in summary.match_freshness] == [True, True, False]
    assert "2/3 matches" in summary.note

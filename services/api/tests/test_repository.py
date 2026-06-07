import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import CanonicalEntityConflict, Confidence, PaperPerformance, Provider
from tennis_edge.domain import ReplayRunRequest
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.repository import AnalysisRepository


def test_repository_returns_match_analyses() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample"))
    analyses = asyncio.run(repo.analyses_for_date(date.today()))

    assert analyses
    assert all(analysis.prediction.match_id == analysis.match.id for analysis in analyses)
    assert all(analysis.signals for analysis in analyses)


def test_daily_metrics_are_available() -> None:
    repo = AnalysisRepository(Settings(data_mode="sample"))
    metrics = asyncio.run(repo.daily_metrics(date.today()))

    assert metrics.matches > 0
    assert metrics.average_model_confidence >= 0


def test_daily_metrics_include_persisted_paper_performance() -> None:
    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def paper_performance(self):
            return PaperPerformance(
                orders=4,
                settled_orders=3,
                wins=2,
                losses=1,
                open_orders=1,
                roi=0.0833,
                clv=0.0125,
                realized_pnl=25,
                max_drawdown=0.02,
                calibration_error=0.031,
                readiness_status="collecting",
                readiness_reasons=["collecting"],
                segments=[],
            )

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub(repo.store)

    metrics = asyncio.run(repo.daily_metrics(date.today()))

    assert metrics.paper_roi == 0.0833
    assert metrics.clv == 0.0125
    assert metrics.brier_score == 0.031
    assert "Paper metrics loaded" in metrics.note


def test_daily_cost_report_uses_persisted_positive_clv_signals() -> None:
    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def paper_performance(self):
            return PaperPerformance(
                orders=5,
                settled_orders=4,
                wins=3,
                losses=1,
                open_orders=1,
                roi=0.11,
                clv=0.018,
                realized_pnl=42,
                max_drawdown=0,
                calibration_error=0.02,
                readiness_status="collecting",
                readiness_reasons=["collecting"],
                segments=[],
                positive_clv_signals=2,
            )

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub(repo.store)

    report = asyncio.run(repo.daily_cost_report(date.today()))

    assert report.cost_per_positive_clv_signal_usd == 7.17
    assert "positive-CLV" in report.note


def test_entity_conflicts_prefers_persisted_store_over_sample_conflicts() -> None:
    persisted_conflicts = [
        CanonicalEntityConflict(
            id="conf_persisted_market_alias",
            entity_type="market",
            provider=Provider.ODDS_API_IO,
            canonical_id="match_atp_001",
            candidate_id="odds-live-market-123",
            confidence=Confidence.HIGH,
            similarity=0.94,
            reason="Persisted provider conflict from canonical review queue.",
            source_payload_ids=["raw_payload_1"],
        )
    ]

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def entity_conflicts(self):
            return persisted_conflicts

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub(repo.store)

    conflicts = asyncio.run(repo.entity_conflicts())

    assert conflicts == persisted_conflicts
    assert conflicts[0].id == "conf_persisted_market_alias"


def test_replay_prefers_persisted_raw_payloads_over_sample_payloads() -> None:
    persisted_payloads = sample_raw_payloads("match_atp_002")[:1]

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.requested_match_id = None

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def raw_payloads_for_match(self, match_id):
            self.requested_match_id = match_id
            return persisted_payloads

    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = StoreStub(repo.store)
    repo.store = store

    replay = asyncio.run(repo.run_replay(ReplayRunRequest(match_id="match_atp_002")))

    assert store.requested_match_id == "match_atp_002"
    assert replay.events_replayed == len(persisted_payloads)
    assert replay.odds_ticks == 0


def test_replay_falls_back_to_provider_match_id_for_persisted_raw_payloads() -> None:
    persisted_payloads = sample_raw_payloads("sample-api-tennis-002")[:1]

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.requested_match_ids = []

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def raw_payloads_for_match(self, match_id):
            self.requested_match_ids.append(match_id)
            if match_id == "sample-api-tennis-002":
                return persisted_payloads
            return []

    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = StoreStub(repo.store)
    repo.store = store

    replay = asyncio.run(repo.run_replay(ReplayRunRequest(match_id="match_atp_002")))

    assert store.requested_match_ids[:2] == ["match_atp_002", "sample-api-tennis-002"]
    assert replay.events_replayed == len(persisted_payloads)

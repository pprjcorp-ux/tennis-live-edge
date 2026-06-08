import asyncio
from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    BacktestMetrics,
    CanonicalEntityConflict,
    Confidence,
    ExecutionOrder,
    KillSwitchRequest,
    ModelRegistryEntry,
    PaperPerformance,
    Provider,
)
from tennis_edge.domain import ExecutionVenue, OrderStatus
from tennis_edge.domain import LearningPromotionRequest
from tennis_edge.domain import ReplayRunRequest
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_matches, sample_raw_payloads
from tennis_edge.services.execution_engine import KILL_SWITCH, ORDERS
from tennis_edge.services.operational_state import OperationalStateService
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


def test_paper_performance_uses_persisted_order_snapshot_when_aggregate_missing() -> None:
    ORDERS.clear()
    persisted_order = ExecutionOrder(
        id="ord_settled_persisted",
        signal_id="sig_persisted",
        match_id="match_atp_001",
        player_id="atp_sinner",
        player_name="Jannik Sinner",
        venue=ExecutionVenue.BETFAIR,
        status=OrderStatus.SETTLED,
        requested_odds=2.0,
        accepted_odds=2.0,
        stake_fraction=0.01,
        stake_amount=100,
        matched_stake=100,
        average_price=2.0,
        pnl=96,
        clv=0.02,
    )

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def paper_performance(self):
            return None

        def orders(self):
            return [persisted_order]

    repo = AnalysisRepository(Settings(data_mode="sample"))
    repo.store = StoreStub(repo.store)

    performance = asyncio.run(repo.paper_performance())

    assert performance.orders == 1
    assert performance.settled_orders == 1
    assert performance.positive_clv_signals == 1
    assert performance.roi == 0.96
    assert performance.realized_pnl == 96


def test_repository_kill_switch_survives_restart_from_persisted_store() -> None:
    persisted: dict[str, object] = {}
    settings = Settings(
        data_mode="live",
        persistence_enabled=True,
        database_url="postgresql://tennis:tennis@localhost:5432/tennis_edge",
        execution_enabled=True,
        execution_stage="tiny_real",
        betfair_app_key="app",
        betfair_username="user",
        betfair_cert_path="/tmp/cert",
        betfair_key_path="/tmp/key",
        betfair_password_secret_ref="secret://betfair",
        betfair_live_key_approved=True,
        real_execution_hard_block=False,
    )

    class StoreStub:
        def save_kill_switch(self, request):
            persisted["enabled"] = request.enabled
            persisted["reason"] = request.reason
            return True

        def kill_switch_state(self):
            return dict(persisted) if persisted else None

    store = StoreStub()
    repo = AnalysisRepository(settings)
    repo.store = store
    repo.operational_state = OperationalStateService(settings, store)
    KILL_SWITCH["enabled"] = False

    status = asyncio.run(
        repo.set_kill_switch(KillSwitchRequest(enabled=True, reason="manual persisted stop"))
    )

    KILL_SWITCH["enabled"] = False
    restarted_repo = AnalysisRepository(settings)
    restarted_repo.store = store
    restarted_repo.operational_state = OperationalStateService(settings, store)
    restarted_status = asyncio.run(restarted_repo.execution_status())

    assert status.kill_switch_enabled is True
    assert restarted_status.kill_switch_enabled is True
    assert any("manual persisted stop" in reason for reason in restarted_status.reasons)


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


def test_archive_odds_augmentation_persists_theoddsapi_raw_payload() -> None:
    match = sample_matches()[0]
    events = TheOddsApiClient(api_key="key", data_mode="live").parse_odds_payload(
        "tennis_atp_french_open",
        [
            {
                "id": "event-raw-1",
                "home_team": match.player1.name,
                "away_team": match.player2.name,
                "commence_time": match.scheduled_at.isoformat(),
                "bookmakers": [
                    {
                        "title": "Pinnacle",
                        "last_update": match.scheduled_at.isoformat(),
                        "markets": [
                            {
                                "key": "h2h",
                                "outcomes": [
                                    {"name": match.player1.name, "price": 1.72},
                                    {"name": match.player2.name, "price": 2.16},
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    )

    class ArchiveSource:
        async def get_tennis_h2h_events(self):
            return events

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.saved_payloads = []

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def save_raw_payloads(self, payloads):
            self.saved_payloads.extend(payloads)

    repo = AnalysisRepository(
        Settings(data_mode="live", the_odds_api_key="key", persistence_enabled=False)
    )
    store = StoreStub(repo.store)
    repo.store = store

    updated = asyncio.run(repo._augment_with_archive_odds([match], ArchiveSource()))

    assert updated[0].provider_ids["theoddsapi"] == "event-raw-1"
    assert {quote.player_id for quote in updated[0].odds} == {
        match.player1.id,
        match.player2.id,
    }
    assert len(store.saved_payloads) == 1
    assert store.saved_payloads[0].provider == Provider.THE_ODDS_API
    assert store.saved_payloads[0].source_event_id == "event-raw-1"


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


def test_live_entity_conflicts_do_not_use_sample_conflicts() -> None:
    class StoreStub:
        def entity_conflicts(self):
            return []

    repo = AnalysisRepository(Settings(data_mode="live", database_url=None))
    repo.store = StoreStub()

    assert asyncio.run(repo.entity_conflicts()) == []


def test_learning_promotion_decision_is_persisted_for_audit() -> None:
    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.saved_decisions = []

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def save_model_promotion_decision(self, decision):
            self.saved_decisions.append(decision)

    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = StoreStub(repo.store)
    repo.store = store

    decision = asyncio.run(
        repo.promote_from_learning(
            LearningPromotionRequest(
                candidate_model_version="audit_candidate",
                roi=0.04,
                clv=0.012,
                brier_score=0.21,
                log_loss=0.6,
                calibration_error=0.03,
                max_drawdown=0.1,
            )
        )
    )

    assert store.saved_decisions == [decision]
    assert decision.candidate_model_version == "audit_candidate"


def test_learning_promotion_rejects_candidate_that_regresses_champion() -> None:
    champion_metrics = BacktestMetrics(
        run_id="bt_champion",
        model_version="production_champion",
        matches=600,
        signals=100,
        roi=0.05,
        clv=0.02,
        brier_score=0.19,
        log_loss=0.55,
        calibration_error=0.02,
        max_drawdown=0.08,
        promoted=True,
    )
    champion = ModelRegistryEntry(
        model_version="production_champion",
        role="champion",
        model_type="walk_forward_ensemble",
        feature_set="enterprise_v1",
        training_window={"walk_forward": True},
        metrics=champion_metrics,
        promoted=True,
    )

    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.saved_decisions = []

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def champion_model(self):
            return champion

        def save_model_promotion_decision(self, decision):
            self.saved_decisions.append(decision)

    repo = AnalysisRepository(Settings(data_mode="sample"))
    store = StoreStub(repo.store)
    repo.store = store

    decision = asyncio.run(
        repo.promote_from_learning(
            LearningPromotionRequest(
                candidate_model_version="absolute_gate_candidate",
                roi=0.04,
                clv=0.012,
                brier_score=0.21,
                log_loss=0.6,
                calibration_error=0.03,
                max_drawdown=0.1,
            )
        )
    )

    assert decision.promoted is False
    assert decision.metrics.promoted is False
    assert "ROI below champion" in " ".join(decision.reasons)
    assert "CLV below champion" in " ".join(decision.reasons)
    assert "Brier score worse than champion" in " ".join(decision.reasons)
    assert store.saved_decisions == [decision]


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


def test_live_replay_without_persisted_payloads_does_not_use_sample_payloads() -> None:
    class StoreStub:
        def __init__(self, fallback) -> None:
            self.fallback = fallback
            self.requested_match_ids = []

        def __getattr__(self, name):
            return getattr(self.fallback, name)

        def raw_payloads_for_match(self, match_id):
            self.requested_match_ids.append(match_id)
            return []

    repo = AnalysisRepository(Settings(data_mode="live", persistence_enabled=False))
    store = StoreStub(repo.store)
    repo.store = store

    replay = asyncio.run(repo.run_replay(ReplayRunRequest(match_id="match_atp_002")))

    assert store.requested_match_ids == ["match_atp_002"]
    assert replay.events_replayed == 0
    assert replay.score_ticks == 0
    assert replay.odds_ticks == 0

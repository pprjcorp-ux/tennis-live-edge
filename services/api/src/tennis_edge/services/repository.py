from datetime import date

from tennis_edge.config import Settings
from tennis_edge.domain import (
    AgentAnomaly,
    AgentAutopilotRequest,
    AgentAutopilotResult,
    AgentBriefing,
    AgentRun,
    BacktestMetrics,
    BacktestRunRequest,
    BankrollSnapshot,
    CancelOrderResult,
    CalibrationReport,
    CanonicalEntityConflict,
    CostProfile,
    DailyCostReport,
    DailyMetrics,
    DataQualitySnapshot,
    ExecutionOrder,
    ExecutionStatus,
    KillSwitchRequest,
    LearningPromotionRequest,
    MatchAnalysis,
    ModelRegistryEntry,
    ModelPromotionDecision,
    OrderRequest,
    PaperPerformance,
    PaperSettlement,
    PaperSettleRequest,
    ProviderCursor,
    ProviderHealth,
    ReplayRunRequest,
    ReplayRunResult,
    Signal,
    SignalStatus,
    CursorStatus,
    Provider,
)
from tennis_edge.services.agent_ops import (
    agent_runs,
    build_agent_briefing,
    detect_anomalies,
    run_agent_autopilot,
)
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.providers.the_odds_api import TheOddsApiClient
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.backtest import run_walk_forward_backtest
from tennis_edge.services.cost_profile import (
    apply_coverage_gate,
    cost_profile,
    coverage_decision,
    daily_cost_report,
    provider_health_for,
)
from tennis_edge.services.enterprise_analytics import (
    calibration_report,
    champion_model,
    data_quality_snapshots,
    entity_conflicts,
    model_registry,
    paper_performance,
    settle_paper_order,
)
from tennis_edge.services.execution_engine import (
    ORDERS,
    bankroll_snapshot,
    cancel_order,
    create_order,
    execution_status,
    promote_from_learning,
    set_kill_switch_for,
)
from tennis_edge.services.normalizer import normalize_name
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.replay_engine import ReplayEngine
from tennis_edge.services.signal_engine import build_signals
from tennis_edge.services.storage import PersistentStore


BACKTESTS: dict[str, BacktestMetrics] = {}
REPLAYS: dict[str, ReplayRunResult] = {}


class AnalysisRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.api_tennis = ApiTennisClient(settings.api_tennis_key, settings.data_mode)
        self.the_odds_api = TheOddsApiClient(settings.the_odds_api_key, settings.data_mode)
        self.replay_engine = ReplayEngine()
        self.store = PersistentStore(settings)

    async def analyses_for_date(self, target_date: date) -> list[MatchAnalysis]:
        try:
            matches = await self.api_tennis.get_today_matches(target_date)
        except Exception:
            matches = []
        if not matches:
            stored = self.store.latest_analyses(target_date)
            if stored:
                return stored
        matches = await self._augment_with_archive_odds(matches)
        analyses: list[MatchAnalysis] = []
        for match in matches:
            features = build_features(match)
            prediction = predict_match(match, features)
            signals = build_signals(match, prediction, features)
            signals = apply_coverage_gate(signals, coverage_decision(match, self.settings))
            signals = self._apply_provider_gates(signals)
            analyses.append(
                MatchAnalysis(
                    match=match,
                    features=features,
                    prediction=prediction,
                    signals=signals,
                )
            )
        self.store.save_analyses(analyses)
        return analyses

    async def _augment_with_archive_odds(self, matches):
        if self.settings.data_mode == "sample" or not self.settings.the_odds_api_key:
            return matches
        try:
            events = await self.the_odds_api.get_tennis_h2h_events()
        except Exception:
            return matches

        by_names = {event.name_key: event for event in events}
        updated = []
        for match in matches:
            key = frozenset({normalize_name(match.player1.name), normalize_name(match.player2.name)})
            event = by_names.get(key)
            if not event or not event.quotes:
                updated.append(match)
                continue
            player_map = {
                normalize_name(match.player1.name): match.player1.id,
                normalize_name(match.player2.name): match.player2.id,
            }
            translated = [
                quote.model_copy(update={"player_id": player_map[quote.player_id]})
                for quote in event.quotes
                if quote.player_id in player_map
            ]
            provider_ids = dict(match.provider_ids)
            provider_ids.setdefault("theoddsapi", event.id)
            updated.append(
                match.model_copy(
                    update={
                        "provider_ids": provider_ids,
                        "odds": translated or match.odds,
                    }
                )
            )
        return updated

    def _apply_provider_gates(self, signals: list[Signal]) -> list[Signal]:
        if self.settings.data_mode == "sample" or not self.settings.odds_ws_resync_required_blocks_signals:
            return signals
        cursors = self.store.provider_cursors() or default_provider_cursors(self.settings)
        odds_cursor = next(
            (
                cursor
                for cursor in cursors
                if cursor.provider == Provider.ODDS_API_IO
                and cursor.status in {CursorStatus.GAP_DETECTED, CursorStatus.RESYNC_REQUIRED}
            ),
            None,
        )
        if not odds_cursor:
            return signals
        gated: list[Signal] = []
        for signal in signals:
            status = SignalStatus.BLOCKED if signal.status == SignalStatus.ENTRY else signal.status
            gated.append(
                signal.model_copy(
                    update={
                        "status": status,
                        "stake_fraction": 0,
                        "reason": f"Odds websocket cursor requires resync; blocking entries. {signal.reason}",
                    }
                )
            )
        return gated

    async def live_signals(self, target_date: date) -> list[Signal]:
        analyses = await self.analyses_for_date(target_date)
        signals = [signal for analysis in analyses for signal in analysis.signals]
        return sorted(signals, key=lambda signal: signal.edge, reverse=True)

    async def match_detail(self, match_id: str, target_date: date) -> MatchAnalysis | None:
        analyses = await self.analyses_for_date(target_date)
        for analysis in analyses:
            if analysis.match.id == match_id:
                return analysis
        return None

    async def provider_health(self) -> list[ProviderHealth]:
        return self.store.provider_health()

    async def cost_profile(self) -> CostProfile:
        return cost_profile(self.settings)

    async def daily_cost_report(self, target_date: date) -> DailyCostReport:
        return daily_cost_report(self.settings, await self.analyses_for_date(target_date))

    async def data_quality(self) -> list[DataQualitySnapshot]:
        persisted = self.store.data_quality()
        return persisted or data_quality_snapshots(self.settings)

    async def provider_cursors(self) -> list[ProviderCursor]:
        persisted = self.store.provider_cursors()
        return persisted or default_provider_cursors(self.settings)

    async def model_registry(self) -> list[ModelRegistryEntry]:
        return model_registry(self.settings)

    async def champion_model(self) -> ModelRegistryEntry:
        return champion_model(self.settings)

    async def calibration_report(self, run_id: str) -> CalibrationReport:
        return calibration_report(run_id)

    async def entity_conflicts(self) -> list[CanonicalEntityConflict]:
        return entity_conflicts()

    async def paper_performance(self) -> PaperPerformance:
        persisted = self.store.paper_performance()
        return persisted or paper_performance(self.settings)

    async def agent_briefing(self) -> AgentBriefing:
        analyses = await self.analyses_for_date(date.today())
        return build_agent_briefing(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=await self.bankroll(),
            cost_report=await self.daily_cost_report(date.today()),
        )

    async def agent_anomalies(self) -> list[AgentAnomaly]:
        analyses = await self.analyses_for_date(date.today())
        return detect_anomalies(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=await self.bankroll(),
            cost_report=await self.daily_cost_report(date.today()),
        )

    async def agent_autopilot(
        self, request: AgentAutopilotRequest
    ) -> AgentAutopilotResult:
        analyses = await self.analyses_for_date(date.today())
        anomalies = detect_anomalies(
            self.settings,
            analyses=analyses,
            provider_health=await self.provider_health(),
            provider_cursors=await self.provider_cursors(),
            data_quality=await self.data_quality(),
            execution_status=await self.execution_status(),
            paper_performance=await self.paper_performance(),
            bankroll=await self.bankroll(),
            cost_report=await self.daily_cost_report(date.today()),
        )
        return run_agent_autopilot(self.settings, analyses, request, anomalies)

    async def agent_runs(self) -> list[AgentRun]:
        return agent_runs()

    async def settle_paper(self, request: PaperSettleRequest) -> PaperSettlement:
        try:
            settlement = settle_paper_order(request)
        except KeyError:
            persisted = self.store.settle_paper_order(request)
            if persisted is None:
                raise
            return persisted
        self.store.save_settlement(settlement)
        return settlement

    async def execution_status(self) -> ExecutionStatus:
        return execution_status(self.settings)

    async def bankroll(self) -> BankrollSnapshot:
        return bankroll_snapshot(self.settings)

    async def orders(self) -> list[ExecutionOrder]:
        merged = {order.id: order for order in self.store.orders()}
        merged.update({order.id: order for order in ORDERS.values()})
        return sorted(merged.values(), key=lambda order: order.created_at, reverse=True)

    async def create_paper_order(self, request: OrderRequest) -> ExecutionOrder:
        order = create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=False,
        )
        self.store.save_order(order)
        return order

    async def submit_order(self, request: OrderRequest) -> ExecutionOrder:
        order = create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=True,
        )
        self.store.save_order(order)
        return order

    async def cancel_order(self, order_id: str) -> CancelOrderResult:
        try:
            return cancel_order(order_id)
        except KeyError:
            status = self.store.cancel_order(order_id)
            if status is None:
                raise
            return CancelOrderResult(
                order_id=order_id,
                status=status,
                reason="Persisted paper order cancelled.",
            )

    async def set_kill_switch(self, request: KillSwitchRequest) -> ExecutionStatus:
        return set_kill_switch_for(self.settings, request)

    async def promote_from_learning(
        self, request: LearningPromotionRequest
    ) -> ModelPromotionDecision:
        return promote_from_learning(request)

    async def run_replay(self, request: ReplayRunRequest) -> ReplayRunResult:
        analyses = await self.analyses_for_date(date.today())
        signal_count = sum(
            1
            for analysis in analyses
            if analysis.match.id == request.match_id
            for signal in analysis.signals
            if signal.status == SignalStatus.ENTRY
        )
        result = self.replay_engine.summarize(
            request.match_id,
            sample_raw_payloads(request.match_id),
            signals=signal_count,
        )
        REPLAYS[result.run_id] = result
        return result

    async def run_backtest(self, request: BacktestRunRequest | None = None) -> BacktestMetrics:
        metrics = self.store.backtest_metrics(request) or run_walk_forward_backtest(request)
        self.store.save_backtest(metrics, request)
        BACKTESTS[metrics.run_id] = metrics
        return metrics

    async def get_backtest(self, run_id: str) -> BacktestMetrics:
        if run_id == "latest" and BACKTESTS:
            return list(BACKTESTS.values())[-1]
        if run_id not in BACKTESTS:
            persisted = self.store.get_backtest(run_id)
            if persisted is None:
                raise KeyError(run_id)
            return persisted
        return BACKTESTS[run_id]

    async def daily_metrics(self, target_date: date) -> DailyMetrics:
        analyses = await self.analyses_for_date(target_date)
        all_signals = [signal for analysis in analyses for signal in analysis.signals]
        entries = [signal for signal in all_signals if signal.status == SignalStatus.ENTRY]
        positive_edges = [signal.edge for signal in all_signals if signal.edge > 0]
        confidence_values = [
            abs(analysis.prediction.p1_win_prob - 0.5) * 2 for analysis in analyses
        ]

        return DailyMetrics(
            matches=len(analyses),
            live_matches=sum(1 for analysis in analyses if analysis.match.state.status == "live"),
            entry_signals=len(entries),
            monitor_signals=sum(1 for signal in all_signals if signal.status == SignalStatus.MONITOR),
            no_value_signals=sum(
                1 for signal in all_signals if signal.status == SignalStatus.NO_VALUE
            ),
            average_edge=round(sum(positive_edges) / len(positive_edges), 4)
            if positive_edges
            else 0,
            average_model_confidence=round(
                sum(confidence_values) / len(confidence_values), 4
            )
            if confidence_values
            else 0,
            note="Paper metrics ficam nulos ate existirem sinais liquidados e closing lines.",
        )

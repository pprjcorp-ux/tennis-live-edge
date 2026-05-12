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
)
from tennis_edge.services.agent_ops import (
    agent_runs,
    build_agent_briefing,
    detect_anomalies,
    run_agent_autopilot,
)
from tennis_edge.providers.api_tennis import ApiTennisClient
from tennis_edge.sample_data import sample_raw_payloads
from tennis_edge.services.backtest import run_walk_forward_backtest
from tennis_edge.services.cost_profile import (
    apply_coverage_gate,
    cost_profile,
    coverage_decision,
    daily_cost_report,
    provider_health_for,
    routed_score_provider,
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
from tennis_edge.services.provider_cursor import default_provider_cursors
from tennis_edge.services.feature_engine import build_features
from tennis_edge.services.model_service import predict_match
from tennis_edge.services.replay_engine import ReplayEngine
from tennis_edge.services.signal_engine import build_signals


BACKTESTS: dict[str, BacktestMetrics] = {}
REPLAYS: dict[str, ReplayRunResult] = {}


class AnalysisRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.api_tennis = ApiTennisClient(settings.api_tennis_key, settings.data_mode)
        self.replay_engine = ReplayEngine()

    async def analyses_for_date(self, target_date: date) -> list[MatchAnalysis]:
        matches = await self.api_tennis.get_today_matches(target_date)
        analyses: list[MatchAnalysis] = []
        for match in matches:
            features = build_features(match)
            prediction = predict_match(match, features)
            signals = build_signals(match, prediction, features)
            signals = apply_coverage_gate(signals, coverage_decision(match, self.settings))
            analyses.append(
                MatchAnalysis(
                    match=match,
                    features=features,
                    prediction=prediction,
                    signals=signals,
                )
            )
        return analyses

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
        return provider_health_for(self.settings)

    async def cost_profile(self) -> CostProfile:
        return cost_profile(self.settings)

    async def daily_cost_report(self, target_date: date) -> DailyCostReport:
        return daily_cost_report(
            self.settings,
            await self.analyses_for_date(target_date),
            score_provider=routed_score_provider(self.settings),
        )

    async def data_quality(self) -> list[DataQualitySnapshot]:
        return data_quality_snapshots(self.settings)

    async def provider_cursors(self) -> list[ProviderCursor]:
        return default_provider_cursors(self.settings)

    async def model_registry(self) -> list[ModelRegistryEntry]:
        return model_registry(self.settings)

    async def champion_model(self) -> ModelRegistryEntry:
        return champion_model(self.settings)

    async def calibration_report(self, run_id: str) -> CalibrationReport:
        return calibration_report(run_id)

    async def entity_conflicts(self) -> list[CanonicalEntityConflict]:
        return entity_conflicts()

    async def paper_performance(self) -> PaperPerformance:
        return paper_performance(self.settings)

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
        return settle_paper_order(request)

    async def execution_status(self) -> ExecutionStatus:
        return execution_status(self.settings)

    async def bankroll(self) -> BankrollSnapshot:
        return bankroll_snapshot(self.settings)

    async def orders(self) -> list[ExecutionOrder]:
        return sorted(ORDERS.values(), key=lambda order: order.created_at, reverse=True)

    async def create_paper_order(self, request: OrderRequest) -> ExecutionOrder:
        return create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=False,
        )

    async def submit_order(self, request: OrderRequest) -> ExecutionOrder:
        return create_order(
            self.settings,
            await self.analyses_for_date(date.today()),
            request,
            real=True,
        )

    async def cancel_order(self, order_id: str) -> CancelOrderResult:
        return cancel_order(order_id)

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
        metrics = run_walk_forward_backtest(request)
        BACKTESTS[metrics.run_id] = metrics
        return metrics

    async def get_backtest(self, run_id: str) -> BacktestMetrics:
        if run_id == "latest" and BACKTESTS:
            return list(BACKTESTS.values())[-1]
        if run_id not in BACKTESTS:
            raise KeyError(run_id)
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

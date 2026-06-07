from datetime import date

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from tennis_edge.config import Settings, get_settings
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
)
from tennis_edge.security import require_admin_token
from tennis_edge.services.repository import AnalysisRepository

app = FastAPI(
    title="Tennis Live Edge API",
    version="0.1.0",
    description="ATP/WTA match prediction, fair odds and positive edge signals.",
)


def repository(settings: Settings = Depends(get_settings)) -> AnalysisRepository:
    return AnalysisRepository(settings)


settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(
        dict.fromkeys(
            settings.cors_origins
            + ["http://localhost:3000", "http://127.0.0.1:3000"]
        )
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "tennis-live-edge-api"}


@app.get("/api/matches/today", response_model=list[MatchAnalysis])
async def today_matches(
    repo: AnalysisRepository = Depends(repository),
) -> list[MatchAnalysis]:
    return await repo.analyses_for_date(date.today())


@app.get("/api/metrics/daily", response_model=DailyMetrics)
async def daily_metrics(
    repo: AnalysisRepository = Depends(repository),
) -> DailyMetrics:
    return await repo.daily_metrics(date.today())


@app.get("/api/v1/live/matches", response_model=list[MatchAnalysis])
async def v1_live_matches(
    repo: AnalysisRepository = Depends(repository),
) -> list[MatchAnalysis]:
    return await repo.analyses_for_date(date.today())


@app.get("/api/v1/matches/{match_id}", response_model=MatchAnalysis)
async def v1_match_detail(
    match_id: str,
    repo: AnalysisRepository = Depends(repository),
) -> MatchAnalysis:
    analysis = await repo.match_detail(match_id, date.today())
    if analysis is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return analysis


@app.get("/api/v1/signals/live", response_model=list[Signal])
async def v1_live_signals(
    repo: AnalysisRepository = Depends(repository),
) -> list[Signal]:
    return await repo.live_signals(date.today())


@app.get("/api/v1/provider-health", response_model=list[ProviderHealth])
async def v1_provider_health(
    repo: AnalysisRepository = Depends(repository),
) -> list[ProviderHealth]:
    return await repo.provider_health()


@app.get("/api/v1/cost-profile", response_model=CostProfile)
async def v1_cost_profile(
    repo: AnalysisRepository = Depends(repository),
) -> CostProfile:
    return await repo.cost_profile()


@app.get("/api/v1/cost-report/daily", response_model=DailyCostReport)
async def v1_daily_cost_report(
    repo: AnalysisRepository = Depends(repository),
) -> DailyCostReport:
    return await repo.daily_cost_report(date.today())


@app.get("/api/v1/data-quality", response_model=list[DataQualitySnapshot])
async def v1_data_quality(
    repo: AnalysisRepository = Depends(repository),
) -> list[DataQualitySnapshot]:
    return await repo.data_quality()


@app.get("/api/v1/provider-cursors", response_model=list[ProviderCursor])
async def v1_provider_cursors(
    repo: AnalysisRepository = Depends(repository),
) -> list[ProviderCursor]:
    return await repo.provider_cursors()


@app.get("/api/v1/models/registry", response_model=list[ModelRegistryEntry])
async def v1_models_registry(
    repo: AnalysisRepository = Depends(repository),
) -> list[ModelRegistryEntry]:
    return await repo.model_registry()


@app.get("/api/v1/models/champion", response_model=ModelRegistryEntry)
async def v1_model_champion(
    repo: AnalysisRepository = Depends(repository),
) -> ModelRegistryEntry:
    return await repo.champion_model()


@app.get("/api/v1/entity-resolution/conflicts", response_model=list[CanonicalEntityConflict])
async def v1_entity_resolution_conflicts(
    repo: AnalysisRepository = Depends(repository),
) -> list[CanonicalEntityConflict]:
    return await repo.entity_conflicts()


@app.get("/api/v1/paper/performance", response_model=PaperPerformance)
async def v1_paper_performance(
    repo: AnalysisRepository = Depends(repository),
) -> PaperPerformance:
    return await repo.paper_performance()


@app.get("/api/v1/agent/briefing", response_model=AgentBriefing)
async def v1_agent_briefing(
    repo: AnalysisRepository = Depends(repository),
) -> AgentBriefing:
    return await repo.agent_briefing()


@app.get("/api/v1/agent/anomalies", response_model=list[AgentAnomaly])
async def v1_agent_anomalies(
    repo: AnalysisRepository = Depends(repository),
) -> list[AgentAnomaly]:
    return await repo.agent_anomalies()


@app.post("/api/v1/agent/autopilot/evaluate", response_model=AgentAutopilotResult)
async def v1_agent_autopilot_evaluate(
    request: AgentAutopilotRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> AgentAutopilotResult:
    return await repo.agent_autopilot(request)


@app.get("/api/v1/agent/runs", response_model=list[AgentRun])
async def v1_agent_runs(
    repo: AnalysisRepository = Depends(repository),
) -> list[AgentRun]:
    return await repo.agent_runs()


@app.post("/api/v1/paper/settle", response_model=PaperSettlement)
async def v1_paper_settle(
    request: PaperSettleRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> PaperSettlement:
    try:
        return await repo.settle_paper(request)
    except KeyError:
        raise HTTPException(status_code=404, detail="Order not found") from None


@app.get("/api/v1/execution/status", response_model=ExecutionStatus)
async def v1_execution_status(
    repo: AnalysisRepository = Depends(repository),
) -> ExecutionStatus:
    return await repo.execution_status()


@app.get("/api/v1/bankroll", response_model=BankrollSnapshot)
async def v1_bankroll(
    repo: AnalysisRepository = Depends(repository),
) -> BankrollSnapshot:
    return await repo.bankroll()


@app.get("/api/v1/orders", response_model=list[ExecutionOrder])
async def v1_orders(
    repo: AnalysisRepository = Depends(repository),
) -> list[ExecutionOrder]:
    return await repo.orders()


@app.post("/api/v1/orders/paper", response_model=ExecutionOrder)
async def v1_create_paper_order(
    request: OrderRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ExecutionOrder:
    try:
        return await repo.create_paper_order(request)
    except KeyError:
        raise HTTPException(status_code=404, detail="Signal not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@app.post("/api/v1/orders/submit", response_model=ExecutionOrder)
async def v1_submit_order(
    request: OrderRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ExecutionOrder:
    try:
        return await repo.submit_order(request)
    except KeyError:
        raise HTTPException(status_code=404, detail="Signal not found") from None


@app.post("/api/v1/orders/{order_id}/cancel", response_model=CancelOrderResult)
async def v1_cancel_order(
    order_id: str,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> CancelOrderResult:
    try:
        return await repo.cancel_order(order_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Order not found") from None


@app.post("/api/v1/execution/kill-switch", response_model=ExecutionStatus)
async def v1_kill_switch(
    request: KillSwitchRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ExecutionStatus:
    return await repo.set_kill_switch(request)


@app.post("/api/v1/models/promote-from-learning", response_model=ModelPromotionDecision)
async def v1_promote_from_learning(
    request: LearningPromotionRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ModelPromotionDecision:
    return await repo.promote_from_learning(request)


@app.post("/api/v1/replay/run", response_model=ReplayRunResult)
async def v1_run_replay(
    request: ReplayRunRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ReplayRunResult:
    return await repo.run_replay(request)


@app.post("/api/v1/backtests/run", response_model=BacktestMetrics)
async def v1_run_backtest(
    request: BacktestRunRequest | None = Body(default=None),
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> BacktestMetrics:
    return await repo.run_backtest(request)


@app.get("/api/v1/backtests/{run_id}", response_model=BacktestMetrics)
async def v1_backtest(
    run_id: str,
    repo: AnalysisRepository = Depends(repository),
) -> BacktestMetrics:
    try:
        return await repo.get_backtest(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Backtest not found") from None


@app.get("/api/v1/backtests/{run_id}/calibration", response_model=CalibrationReport)
async def v1_backtest_calibration(
    run_id: str,
    repo: AnalysisRepository = Depends(repository),
) -> CalibrationReport:
    return await repo.calibration_report(run_id)


@app.post("/api/v1/admin/model/promote", response_model=BacktestMetrics)
async def v1_promote_model(
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> BacktestMetrics:
    try:
        metrics = await repo.get_backtest("latest")
    except KeyError:
        raise HTTPException(status_code=409, detail="No backtest has been run.") from None
    if not metrics.promoted:
        raise HTTPException(
            status_code=409,
            detail=metrics.rejection_reason or "Model did not pass promotion gates.",
        )
    return metrics

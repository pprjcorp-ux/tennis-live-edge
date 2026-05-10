from datetime import date

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from tennis_edge.config import Settings, get_settings
from tennis_edge.domain import (
    BacktestMetrics,
    CostProfile,
    DailyCostReport,
    DailyMetrics,
    MatchAnalysis,
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


@app.post("/api/v1/replay/run", response_model=ReplayRunResult)
async def v1_run_replay(
    request: ReplayRunRequest,
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> ReplayRunResult:
    return await repo.run_replay(request)


@app.post("/api/v1/backtests/run", response_model=BacktestMetrics)
async def v1_run_backtest(
    _: None = Depends(require_admin_token),
    repo: AnalysisRepository = Depends(repository),
) -> BacktestMetrics:
    return await repo.run_backtest()


@app.get("/api/v1/backtests/{run_id}", response_model=BacktestMetrics)
async def v1_backtest(
    run_id: str,
    repo: AnalysisRepository = Depends(repository),
) -> BacktestMetrics:
    try:
        return await repo.get_backtest(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Backtest not found") from None


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

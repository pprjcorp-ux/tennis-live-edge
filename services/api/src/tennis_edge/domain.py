from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Tour(StrEnum):
    ATP = "ATP"
    WTA = "WTA"


class CompetitionLevel(StrEnum):
    ATP = "ATP"
    WTA = "WTA"
    CHALLENGER = "Challenger"
    WTA125 = "WTA125"
    ITF = "ITF"


class Surface(StrEnum):
    CLAY = "clay"
    HARD = "hard"
    GRASS = "grass"
    INDOOR_HARD = "indoor_hard"


class SignalStatus(StrEnum):
    ENTRY = "Entrada"
    MONITOR = "Monitorar"
    NO_VALUE = "Sem valor"
    BLOCKED = "Bloqueado"


class Confidence(StrEnum):
    LOW = "Baixa"
    MEDIUM = "Media"
    HIGH = "Alta"


class Provider(StrEnum):
    SPORTRADAR = "sportradar"
    BETRADAR_UOF = "betradar_uof"
    TXODDS = "txodds"
    API_TENNIS = "api_tennis"
    ODDS_API_IO = "odds_api_io"
    THE_ODDS_API = "theoddsapi"
    SAMPLE = "sample"


class MarketStatus(StrEnum):
    OPEN = "open"
    SUSPENDED = "suspended"
    CLOSED = "closed"


class RiskDecisionStatus(StrEnum):
    ALLOW = "allow"
    MONITOR = "monitor"
    BLOCK = "block"


class Player(BaseModel):
    id: str
    provider_ids: dict[str, str] = Field(default_factory=dict)
    name: str
    tour: Tour
    country: str
    ranking: int | None = None
    handedness: Literal["R", "L"] = "R"
    elo_overall: float = 1500
    elo_clay: float = 1500
    elo_hard: float = 1500
    hold_rate: float = Field(default=0.78, ge=0, le=1)
    break_rate: float = Field(default=0.22, ge=0, le=1)
    recent_win_rate: float = Field(default=0.5, ge=0, le=1)
    fatigue_risk: float = Field(default=0.2, ge=0, le=1)


class MatchState(BaseModel):
    status: Literal["prematch", "live", "finished"] = "prematch"
    p1_sets: int = 0
    p2_sets: int = 0
    p1_games: int = 0
    p2_games: int = 0
    point_score: str = "0-0"
    server_player_id: str | None = None
    is_tiebreak: bool = False
    is_break_point: bool = False
    momentum_player_id: str | None = None
    source_latency_ms: int | None = None

    @property
    def is_volatile(self) -> bool:
        return self.is_tiebreak or self.is_break_point or "40-40" in self.point_score


class OddsQuote(BaseModel):
    bookmaker: str
    market: Literal["ML", "Spread", "Totals"] = "ML"
    player_id: str
    decimal_odds: float = Field(gt=1)
    source_ts: datetime
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Match(BaseModel):
    id: str
    provider_ids: dict[str, str] = Field(default_factory=dict)
    provider_match_id: str
    tournament: str
    round: str
    tour: Tour
    competition_level: CompetitionLevel = CompetitionLevel.ATP
    surface: Surface
    indoor: bool = False
    best_of: int = 3
    scheduled_at: datetime
    player1: Player
    player2: Player
    state: MatchState
    odds: list[OddsQuote] = Field(default_factory=list)


class FeatureVector(BaseModel):
    match_id: str
    elo_diff: float
    ranking_diff: float
    form_diff: float
    fatigue_diff: float
    live_score_pressure: float
    market_volatility: float
    competition_level: CompetitionLevel = CompetitionLevel.ATP
    data_quality: float = Field(default=1.0, ge=0, le=1)
    provider_count: int = 1
    odds_latency_ms: int | None = None
    surface: Surface


class Prediction(BaseModel):
    match_id: str
    p1_win_prob: float = Field(ge=0, le=1)
    p2_win_prob: float = Field(ge=0, le=1)
    confidence: Confidence
    mode: Literal["prematch", "live"]
    explanations: list[str]
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Signal(BaseModel):
    id: str
    match_id: str
    player_id: str
    player_name: str
    status: SignalStatus
    model_prob: float
    market_prob: float
    best_odds: float
    edge: float
    stake_fraction: float
    threshold: float
    confidence: Confidence
    reason: str


class RawProviderPayload(BaseModel):
    id: str
    provider: Provider
    payload_type: Literal["fixture", "score", "point", "odds", "market_state"]
    source_event_id: str
    source_ts: datetime
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: dict[str, Any]
    checksum: str


class CanonicalMatch(BaseModel):
    id: str
    provider_ids: dict[str, str]
    tournament: str
    round: str
    tour: Tour
    competition_level: CompetitionLevel
    surface: Surface
    scheduled_at: datetime
    player1_id: str
    player2_id: str
    status: str
    confidence: Confidence


class ScoreTick(BaseModel):
    match_id: str
    provider: Provider
    state: MatchState
    source_ts: datetime
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PointEvent(BaseModel):
    id: str
    match_id: str
    provider: Provider
    sequence: int
    set_number: int
    game_number: int
    server_player_id: str | None
    winner_player_id: str | None
    point_score: str
    description: str
    source_ts: datetime
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MarketState(BaseModel):
    match_id: str
    provider: Provider
    bookmaker: str
    market: str
    status: MarketStatus
    reason: str | None = None
    source_ts: datetime
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProviderLatency(BaseModel):
    provider: Provider
    feed: str
    latest_source_ts: datetime
    latest_ingested_at: datetime
    latency_ms: int
    healthy: bool


class PredictionSnapshot(BaseModel):
    id: str
    match_id: str
    model_version: str
    prediction: Prediction
    feature_vector: FeatureVector


class RiskDecision(BaseModel):
    match_id: str
    player_id: str
    status: RiskDecisionStatus
    threshold: float
    max_stake_fraction: float
    reasons: list[str]


class SignalDecision(BaseModel):
    signal: Signal
    risk: RiskDecision
    prediction_snapshot_id: str


class ReplayRunRequest(BaseModel):
    match_id: str = "match_atp_002"
    speed: float = Field(default=1.0, gt=0, le=100)
    include_market_suspensions: bool = True


class ReplayRunResult(BaseModel):
    run_id: str
    match_id: str
    events_replayed: int
    score_ticks: int
    odds_ticks: int
    signals_generated: int
    final_status: str


class BacktestMetrics(BaseModel):
    run_id: str
    model_version: str
    matches: int
    signals: int
    roi: float
    clv: float
    brier_score: float
    log_loss: float
    calibration_error: float
    max_drawdown: float
    promoted: bool = False
    rejection_reason: str | None = None


class ProviderHealth(BaseModel):
    provider: Provider
    configured: bool
    healthy: bool
    latency_ms: int | None = None
    last_message_at: datetime | None = None
    status: str
    cost_tier: str = "unknown"
    coverage_scope: str = "unknown"
    quota_used: int | None = None
    quota_limit: int | None = None
    last_billable_call_at: datetime | None = None


class CostProfile(BaseModel):
    active_plan: str
    monthly_budget_usd: float
    estimated_monthly_spend_usd: float
    enabled_providers: list[Provider]
    disabled_providers: list[Provider]
    coverage_scope: list[str]
    score_primary: str
    odds_primary: str
    odds_archive: str
    enterprise_feeds_enabled: bool
    notes: list[str]


class ProviderCostUsage(BaseModel):
    provider: Provider
    api_calls: int = 0
    websocket_minutes: int = 0
    quota_used: int | None = None
    quota_limit: int | None = None
    estimated_daily_cost_usd: float = 0


class DailyCostReport(BaseModel):
    active_plan: str
    estimated_monthly_spend_usd: float
    estimated_daily_spend_usd: float
    api_calls_by_provider: list[ProviderCostUsage]
    websocket_uptime_pct: float
    matches_analyzed: int
    matches_skipped_by_coverage: int
    signals_generated: int
    cost_per_signal_usd: float | None = None
    cost_per_positive_clv_signal_usd: float | None = None
    watchlist_escalations: int = 0
    note: str


class MatchAnalysis(BaseModel):
    match: Match
    features: FeatureVector
    prediction: Prediction
    signals: list[Signal]


class DailyMetrics(BaseModel):
    matches: int
    live_matches: int
    entry_signals: int
    monitor_signals: int
    no_value_signals: int
    average_edge: float
    average_model_confidence: float
    paper_roi: float | None = None
    clv: float | None = None
    brier_score: float | None = None
    note: str

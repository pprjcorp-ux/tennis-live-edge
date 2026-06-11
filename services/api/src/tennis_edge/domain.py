from datetime import date, datetime, timezone
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


class CursorStatus(StrEnum):
    HEALTHY = "healthy"
    GAP_DETECTED = "gap_detected"
    RESYNC_REQUIRED = "resync_required"
    RESYNCED = "resynced"


class ExecutionVenue(StrEnum):
    BETFAIR = "betfair"


class ExecutionStage(StrEnum):
    PAPER = "paper"
    TINY_REAL = "tiny_real"
    SCALED = "scaled"


class OrderStatus(StrEnum):
    PAPER = "paper"
    PENDING = "pending"
    EXECUTION_BLOCKED = "execution_blocked"
    SUBMITTED = "submitted"
    PARTIALLY_MATCHED = "partially_matched"
    MATCHED = "matched"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    SETTLED = "settled"


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
    raw_p1_win_prob: float | None = Field(default=None, ge=0, le=1)
    raw_p2_win_prob: float | None = Field(default=None, ge=0, le=1)
    confidence: Confidence
    mode: Literal["prematch", "live"]
    model_version: str = "baseline_v0"
    confidence_interval: tuple[float, float] | None = None
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


class ProviderMatchPayload(BaseModel):
    match: "Match"
    raw_payload: RawProviderPayload


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
    raw_payloads_saved: int = 0
    score_ticks_saved: int = 0
    odds_ticks_saved: int = 0
    cursors_saved: int = 0
    resync_required: bool = False
    notes: list[str] = Field(default_factory=list)


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


class BacktestRunRequest(BaseModel):
    start_date: str | None = None
    end_date: str | None = None
    model_version: str = "prematch_ensemble_v1"
    feature_set: str = "live_budget_v1"
    walk_forward: bool = True


class BetfairOrderMapping(BaseModel):
    market_id: str
    selection_id: int
    side: Literal["BACK", "LAY"] = "BACK"
    limit_price: float = Field(gt=1)
    stake_amount: float = Field(gt=0)
    customer_order_ref: str
    customer_strategy_ref: str = "tennis-edge"


class ExecutionStatus(BaseModel):
    execution_enabled: bool
    venue: ExecutionVenue
    stage: ExecutionStage
    betfair_configured: bool
    betfair_live_key_approved: bool
    real_execution_hard_block: bool = True
    kill_switch_enabled: bool
    can_submit_real_orders: bool
    reasons: list[str]


class BankrollSnapshot(BaseModel):
    base_currency: str
    bankroll_amount: float
    available_amount: float
    open_exposure: float
    realized_pnl: float = 0
    daily_pnl: float = 0
    weekly_drawdown: float = 0
    clv: float | None = None
    execution_stage: ExecutionStage
    max_order_stake_fraction: float
    daily_loss_limit_fraction: float
    weekly_drawdown_limit_fraction: float
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class OrderRequest(BaseModel):
    signal_id: str
    bankroll_amount: float | None = Field(default=None, gt=0)
    requested_odds: float | None = Field(default=None, gt=1)
    notes: str | None = None


class CancelOrderResult(BaseModel):
    order_id: str
    status: OrderStatus
    reason: str


class KillSwitchRequest(BaseModel):
    enabled: bool = True
    reason: str = "manual"


class ExecutionOrder(BaseModel):
    id: str
    signal_id: str
    match_id: str
    player_id: str
    player_name: str
    venue: ExecutionVenue
    status: OrderStatus
    side: Literal["BACK", "LAY"] = "BACK"
    requested_odds: float
    accepted_odds: float | None = None
    stake_fraction: float
    stake_amount: float
    matched_stake: float = 0
    average_price: float | None = None
    external_order_id: str | None = None
    customer_order_ref: str | None = None
    customer_strategy_ref: str = "tennis-edge"
    rejection_reason: str | None = None
    settlement_status: str | None = None
    pnl: float | None = None
    clv: float | None = None
    risk_snapshot: dict[str, Any] = Field(default_factory=dict)
    audit: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class LearningPromotionRequest(BaseModel):
    candidate_model_version: str = "ensemble_learning_candidate"
    roi: float = 0.032
    clv: float = 0.011
    brier_score: float = 0.213
    log_loss: float = 0.604
    calibration_error: float = 0.031
    max_drawdown: float = 0.11


class ModelPromotionDecision(BaseModel):
    run_id: str
    candidate_model_version: str
    promoted: bool
    reasons: list[str]
    metrics: BacktestMetrics
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProviderCursor(BaseModel):
    provider: Provider
    stream: str
    last_seq: int | None = None
    expected_next_seq: int | None = None
    status: CursorStatus
    gap_count: int = 0
    resync_required: bool = False
    last_message_at: datetime | None = None
    last_resync_at: datetime | None = None
    note: str


class DataQualitySnapshot(BaseModel):
    id: str
    provider: Provider
    feed: str
    score_completeness: float = Field(ge=0, le=1)
    odds_completeness: float = Field(ge=0, le=1)
    entity_resolution_rate: float = Field(ge=0, le=1)
    sequence_health: float = Field(ge=0, le=1)
    latency_ms: int | None = None
    stale_ticks: int = 0
    duplicate_ticks: int = 0
    blocked_signals: int = 0
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    notes: list[str] = Field(default_factory=list)


class CanonicalEntityConflict(BaseModel):
    id: str
    entity_type: Literal["player", "match", "tournament", "market"]
    provider: Provider
    canonical_id: str | None = None
    candidate_id: str
    confidence: Confidence
    similarity: float = Field(ge=0, le=1)
    reason: str
    source_payload_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class FeatureSnapshot(BaseModel):
    id: str
    match_id: str
    feature_set: str
    values: dict[str, Any]
    as_of: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ClosingLineSnapshot(BaseModel):
    match_id: str
    player_id: str
    bookmaker: str
    closing_decimal_odds: float = Field(gt=1)
    no_vig_probability: float = Field(ge=0, le=1)
    source_ts: datetime


class TrainingExample(BaseModel):
    id: str
    match_id: str
    player_id: str
    model_version: str
    feature_snapshot_id: str
    feature_set: str = "live_budget_v1"
    decision_ts: datetime
    model_probability: float = Field(ge=0, le=1)
    market_probability: float = Field(ge=0, le=1)
    closing_probability: float | None = Field(default=None, ge=0, le=1)
    result_win: bool | None = None
    pnl: float | None = None
    clv: float | None = None
    stake_amount: float = Field(default=1, gt=0)
    calibration_bucket: str


class ModelRegistryEntry(BaseModel):
    model_version: str
    role: Literal["champion", "challenger", "baseline", "archived"]
    model_type: str
    feature_set: str
    training_window: dict[str, Any]
    metrics: BacktestMetrics
    promoted: bool = False
    promoted_at: datetime | None = None
    notes: list[str] = Field(default_factory=list)


class CalibrationBucket(BaseModel):
    bucket: str
    lower_bound: float
    upper_bound: float
    predictions: int
    average_prediction: float
    observed_win_rate: float
    brier_score: float
    log_loss: float


class CalibrationReport(BaseModel):
    run_id: str
    model_version: str
    buckets: list[CalibrationBucket]
    brier_score: float
    log_loss: float
    calibration_error: float
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PaperFill(BaseModel):
    order_id: str
    status: OrderStatus
    requested_odds: float
    available_odds: float
    matched_stake: float
    average_price: float
    unmatched_stake: float
    slippage: float
    commission_rate: float = 0.02
    event_ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PaperSettlement(BaseModel):
    order_id: str
    status: OrderStatus
    result_win: bool
    requested_odds: float
    average_price: float
    matched_stake: float
    gross_pnl: float
    commission: float
    net_pnl: float
    closing_odds: float
    clv: float
    settled_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PaperSettleRequest(BaseModel):
    order_id: str
    result_win: bool
    closing_odds: float = Field(gt=1)


class PaperPerformance(BaseModel):
    orders: int
    settled_orders: int
    positive_clv_signals: int = 0
    wins: int
    losses: int
    open_orders: int
    roi: float | None
    clv: float | None
    realized_pnl: float
    max_drawdown: float
    calibration_error: float | None
    readiness_status: Literal["collecting", "review_ready"]
    readiness_reasons: list[str]
    segments: list["PaperPerformanceSegment"] = Field(default_factory=list)


class PaperPerformanceSegment(BaseModel):
    segment_type: Literal["model", "odds_bucket", "surface", "tour", "provider"]
    segment: str
    settled_orders: int
    roi: float | None
    clv: float | None
    realized_pnl: float


class AgentActionStatus(StrEnum):
    PLANNED = "planned"
    EXECUTED = "executed"
    BLOCKED = "blocked"
    SKIPPED = "skipped"
    FAILED = "failed"


class AgentRunType(StrEnum):
    BRIEFING = "briefing"
    ANOMALY_SCAN = "anomaly_scan"
    AUTOPILOT_EVALUATE = "autopilot_evaluate"
    DAILY_REPORT = "daily_report"
    WEEKLY_LEARNING_REPORT = "weekly_learning_report"


class AgentModelRoute(BaseModel):
    task: str
    model: str
    reason: str
    estimated_cost_usd: float = 0


class AgentAction(BaseModel):
    type: str
    status: AgentActionStatus
    target_id: str | None = None
    summary: str
    cost_usd: float = 0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentRun(BaseModel):
    id: str
    run_type: AgentRunType
    source: Literal["dashboard", "telegram", "cron", "openclaw", "system"] = "system"
    model_routes: list[AgentModelRoute] = Field(default_factory=list)
    actions: list[AgentAction] = Field(default_factory=list)
    summary: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentAnomaly(BaseModel):
    id: str
    severity: Literal["info", "warning", "critical"]
    category: str
    summary: str
    detail: str
    blocked_signals: int = 0
    detected_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentBriefing(BaseModel):
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    autopilot_enabled: bool
    channel: str
    allowed_actions: list[str]
    triage_model: str
    critical_model: str
    router_policy: str
    daily_model_budget_usd: float
    live_matches: int
    entry_signals: int
    paper_orders: int
    open_orders: int
    provider_alerts: int
    readiness_status: Literal["collecting", "review_ready"]
    summary: str
    next_actions: list[str]
    latest_run: AgentRun | None = None


class AgentPreflightCheck(BaseModel):
    name: str
    status: Literal["pass", "warn", "fail"]
    summary: str
    detail: str | None = None


class AgentPreflight(BaseModel):
    status: Literal["ready", "degraded", "blocked"]
    checks: list[AgentPreflightCheck]
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class IngestionRunRequest(BaseModel):
    target_date: date | None = None


class IngestionRunResult(BaseModel):
    target_date: date
    source: Literal["provider_live", "persisted_fallback", "sample", "empty"]
    persisted: bool
    matches: int
    raw_payloads_saved: int
    signals_generated: int
    entry_signals: int
    provider_warnings: list[str] = Field(default_factory=list)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class IngestionRunRecord(BaseModel):
    id: str
    run_type: Literal[
        "score_snapshot",
        "odds_message",
        "odds_stream",
        "live_budget_cycle",
    ]
    source: Literal["api", "cli", "openclaw", "cron", "system"] = "system"
    status: Literal["completed", "degraded", "skipped", "failed"]
    summary: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime
    completed_at: datetime


class OddsMessageIngestionRequest(BaseModel):
    payload: dict[str, Any]
    stream: str = "tennis:moneyline"


class OddsMessageIngestionResult(BaseModel):
    provider: Provider = Provider.ODDS_API_IO
    stream: str
    cursor: ProviderCursor
    quotes: int
    raw_payloads_saved: int
    normalized_odds_saved: int = 0
    persisted: bool
    resync_required: bool
    source_event_id: str
    source_ts: datetime
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProviderCursorResyncRequest(BaseModel):
    provider: Provider = Provider.ODDS_API_IO
    stream: str = "tennis:moneyline"
    last_seq: int = Field(ge=0)


class ProviderCursorResyncResult(BaseModel):
    cursor: ProviderCursor
    persisted: bool
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentAutopilotRequest(BaseModel):
    source: Literal["dashboard", "telegram", "cron", "openclaw", "system"] = "dashboard"
    create_paper_orders: bool = True
    request_real_execution: bool = False
    max_paper_orders: int = Field(default=3, ge=1, le=10)
    notes: str | None = None


class AgentAutopilotResult(BaseModel):
    run: AgentRun
    paper_orders_created: int
    paper_orders_skipped: int
    real_execution_blocked: bool
    anomalies: list[AgentAnomaly]
    created_orders: list[ExecutionOrder] = Field(default_factory=list)


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


class OperationalStateSnapshot(BaseModel):
    provider_health: list[ProviderHealth]
    cost_profile: CostProfile
    daily_cost_report: DailyCostReport
    data_quality: list[DataQualitySnapshot]
    provider_cursors: list[ProviderCursor]
    ingestion_runs: list[IngestionRunRecord]
    execution_status: ExecutionStatus
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MatchFreshness(BaseModel):
    source: Literal["provider_live", "persisted_fallback", "sample", "empty"] = "sample"
    persisted: bool = False
    score_source_ts: datetime | None = None
    odds_source_ts: datetime | None = None
    score_age_ms: int | None = None
    odds_age_ms: int | None = None
    provider_lineage: list[Provider] = Field(default_factory=list)
    note: str = ""


class MatchAnalysis(BaseModel):
    match: Match
    features: FeatureVector
    prediction: Prediction
    signals: list[Signal]
    freshness: MatchFreshness | None = None


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


class LiveReadinessCheck(BaseModel):
    name: str
    status: Literal["pass", "warn", "fail"]
    summary: str
    detail: str | None = None


class LiveReadinessSnapshot(BaseModel):
    status: Literal["ready", "degraded", "blocked"]
    can_analyze_live: bool
    can_generate_entries: bool
    can_submit_real_orders: bool
    blockers: list[str]
    warnings: list[str]
    checks: list[LiveReadinessCheck]
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class LiveDashboardSnapshot(BaseModel):
    matches: list[MatchAnalysis]
    metrics: DailyMetrics
    signals: list[Signal]
    operational_state: OperationalStateSnapshot
    readiness: LiveReadinessSnapshot
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

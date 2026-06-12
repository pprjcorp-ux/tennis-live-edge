export type Confidence = "Baixa" | "Media" | "Alta";
export type SignalStatus = "Entrada" | "Monitorar" | "Sem valor" | "Bloqueado";
export type Provider =
  | "sportradar"
  | "betradar_uof"
  | "txodds"
  | "api_tennis"
  | "odds_api_io"
  | "theoddsapi"
  | "sample";
export type CompetitionLevel = "ATP" | "WTA" | "Challenger" | "WTA125" | "ITF";
export type ExecutionStage = "paper" | "tiny_real" | "scaled";
export type CursorStatus = "healthy" | "gap_detected" | "resync_required" | "resynced";
export type ReplayOddsScenario = "healthy" | "gap" | "resync_required";
export type OrderStatus =
  | "paper"
  | "pending"
  | "execution_blocked"
  | "submitted"
  | "partially_matched"
  | "matched"
  | "cancelled"
  | "rejected"
  | "settled";
export type AgentActionStatus = "planned" | "executed" | "blocked" | "skipped" | "failed";
export type AgentRunType =
  | "briefing"
  | "anomaly_scan"
  | "autopilot_evaluate"
  | "daily_report"
  | "weekly_learning_report";

export type Player = {
  id: string;
  name: string;
  tour: "ATP" | "WTA";
  country: string;
  ranking: number | null;
  handedness: "R" | "L";
  elo_overall: number;
  elo_clay: number;
  elo_hard: number;
  hold_rate: number;
  break_rate: number;
  recent_win_rate: number;
  fatigue_risk: number;
};

export type MatchState = {
  status: "prematch" | "live" | "finished";
  p1_sets: number;
  p2_sets: number;
  p1_games: number;
  p2_games: number;
  point_score: string;
  server_player_id: string | null;
  is_tiebreak: boolean;
  is_break_point: boolean;
  momentum_player_id: string | null;
  source_latency_ms: number | null;
};

export type OddsQuote = {
  bookmaker: string;
  market: "ML" | "Spread" | "Totals";
  player_id: string;
  decimal_odds: number;
  source_ts: string;
  ingested_at: string;
};

export type Match = {
  id: string;
  provider_ids: Record<string, string>;
  provider_match_id: string;
  tournament: string;
  round: string;
  tour: "ATP" | "WTA";
  competition_level: CompetitionLevel;
  surface: "clay" | "hard" | "grass" | "indoor_hard";
  indoor: boolean;
  best_of: number;
  scheduled_at: string;
  player1: Player;
  player2: Player;
  state: MatchState;
  odds: OddsQuote[];
};

export type Prediction = {
  match_id: string;
  p1_win_prob: number;
  p2_win_prob: number;
  raw_p1_win_prob: number | null;
  raw_p2_win_prob: number | null;
  confidence: Confidence;
  mode: "prematch" | "live";
  model_version: string;
  confidence_interval: [number, number] | null;
  explanations: string[];
  generated_at: string;
};

export type FeatureVector = {
  match_id: string;
  elo_diff: number;
  ranking_diff: number;
  form_diff: number;
  fatigue_diff: number;
  live_score_pressure: number;
  market_volatility: number;
  competition_level: CompetitionLevel;
  data_quality: number;
  provider_count: number;
  odds_latency_ms: number | null;
  surface: Match["surface"];
};

export type Signal = {
  id: string;
  match_id: string;
  player_id: string;
  player_name: string;
  status: SignalStatus;
  model_prob: number;
  market_prob: number;
  best_odds: number;
  edge: number;
  stake_fraction: number;
  threshold: number;
  confidence: Confidence;
  reason: string;
};

export type MatchAnalysis = {
  match: Match;
  features: FeatureVector;
  prediction: Prediction;
  signals: Signal[];
  freshness?: {
    source: "provider_live" | "persisted_fallback" | "sample" | "empty";
    persisted: boolean;
    score_source_ts: string | null;
    odds_source_ts: string | null;
    score_age_ms: number | null;
    odds_age_ms: number | null;
    provider_lineage: Provider[];
    note: string;
  } | null;
};

export type DailyMetrics = {
  matches: number;
  live_matches: number;
  entry_signals: number;
  monitor_signals: number;
  no_value_signals: number;
  average_edge: number;
  average_model_confidence: number;
  paper_roi: number | null;
  clv: number | null;
  brier_score: number | null;
  note: string;
};

export type ProviderHealth = {
  provider: Provider;
  configured: boolean;
  healthy: boolean;
  latency_ms: number | null;
  last_message_at: string | null;
  status: string;
  cost_tier: string;
  coverage_scope: string;
  quota_used: number | null;
  quota_limit: number | null;
  last_billable_call_at: string | null;
};

export type CostProfile = {
  active_plan: string;
  monthly_budget_usd: number;
  estimated_monthly_spend_usd: number;
  enabled_providers: Provider[];
  disabled_providers: Provider[];
  coverage_scope: string[];
  score_primary: string;
  odds_primary: string;
  odds_archive: string;
  enterprise_feeds_enabled: boolean;
  notes: string[];
};

export type ProviderCostUsage = {
  provider: Provider;
  api_calls: number;
  websocket_minutes: number;
  quota_used: number | null;
  quota_limit: number | null;
  estimated_daily_cost_usd: number;
};

export type DailyCostReport = {
  active_plan: string;
  estimated_monthly_spend_usd: number;
  estimated_daily_spend_usd: number;
  api_calls_by_provider: ProviderCostUsage[];
  websocket_uptime_pct: number;
  matches_analyzed: number;
  matches_skipped_by_coverage: number;
  signals_generated: number;
  cost_per_signal_usd: number | null;
  cost_per_positive_clv_signal_usd: number | null;
  watchlist_escalations: number;
  note: string;
};

export type ApiOnboardingStatus = "configured" | "ready_next" | "blocked" | "deferred";
export type ProviderModeStatus = "active" | "ready" | "blocked" | "deferred";
export type ProviderModeEntryGate = "allow" | "monitor" | "block";
export type ApiOnboardingCapability =
  | "archive_odds"
  | "score_livescore"
  | "live_odds_websocket"
  | "enterprise_feeds";

export type ProviderModeStep = {
  mode: "sample" | "replay" | "live_without_keys" | "live_with_keys";
  active: boolean;
  status: ProviderModeStatus;
  entry_gate: ProviderModeEntryGate;
  summary: string;
  evidence: string[];
  blockers: string[];
  next_action: string;
};

export type OperationalSourceSummary = {
  total_matches: number;
  persisted_matches: number;
  volatile_matches: number;
  source_counts: Record<string, number>;
  provider_lineage: Provider[];
  match_freshness: {
    match_id: string;
    source: "provider_live" | "persisted_fallback" | "sample" | "empty";
    persisted: boolean;
    score_age_ms: number | null;
    odds_age_ms: number | null;
    provider_lineage: Provider[];
    note: string;
  }[];
  note: string;
};

export type ApiOnboardingStep = {
  order: number;
  provider: Provider;
  capability: ApiOnboardingCapability;
  status: ApiOnboardingStatus;
  configured: boolean;
  current: boolean;
  required_before_enable: string[];
  next_action: string;
  notes: string[];
};

export type ApiOnboardingSnapshot = {
  core_ready: boolean;
  current_step: string;
  steps: ApiOnboardingStep[];
  warnings: string[];
};

export type ModelLabReadinessSnapshot = {
  status: "ready" | "collecting" | "blocked";
  source: "training_examples";
  model_version: string;
  feature_set: string;
  training_examples: number;
  total_training_examples: number;
  production_training_examples: number;
  rehearsal_training_examples: number;
  can_run_live_backtest: boolean;
  reasons: string[];
};

export type ReplayContractProvider = {
  provider: Provider;
  adapter_contract: string;
  fake_api: string;
  input_contracts: string[];
  output_contracts: string[];
  scenarios: string[];
  status: "covered" | "pending";
  notes: string[];
};

export type ReplayContractScenarioEvidence = {
  scenario: ReplayOddsScenario;
  final_status: string;
  passed: boolean;
  raw_payloads_saved: number;
  score_ticks_saved: number;
  odds_ticks_saved: number;
  provider_cursors_replayed: number;
  cursors_saved: number;
  provider_latency_saved: number;
  resync_required: boolean;
};

export type ReplayLabSnapshot = {
  status: "ready" | "collecting" | "blocked";
  source: "budget_replay_fixtures";
  providers: ReplayContractProvider[];
  scenarios: string[];
  last_contract_run_id: string | null;
  last_contract_status: string | null;
  last_contract_passed: boolean;
  last_contract_scenarios: string[];
  last_contract_persistence: ReplayContractScenarioEvidence[];
  last_replay_run_id: string | null;
  last_replay_status: string | null;
  last_replay_events: number;
  last_replay_score_ticks: number;
  last_replay_odds_ticks: number;
  last_replay_resync_required: boolean;
  can_validate_without_live_keys: boolean;
  notes: string[];
};

export type IngestionRunRecord = {
  id: string;
  run_type:
    | "score_snapshot"
    | "odds_message"
    | "odds_stream"
    | "live_budget_cycle"
    | "replay_run"
    | "replay_contract_run"
    | "daily_operational_run";
  source: "api" | "cli" | "openclaw" | "cron" | "system";
  status: "completed" | "collecting" | "degraded" | "skipped" | "failed";
  summary: Record<string, unknown>;
  started_at: string;
  completed_at: string;
};

export type OperationalStateSnapshot = {
  provider_mode: "sample" | "replay" | "live_without_keys" | "live_with_keys";
  provider_mode_reason: string;
  provider_mode_matrix: ProviderModeStep[];
  source_summary: OperationalSourceSummary;
  provider_health: ProviderHealth[];
  cost_profile: CostProfile;
  daily_cost_report: DailyCostReport;
  data_quality: DataQualitySnapshot[];
  provider_cursors: ProviderCursor[];
  ingestion_runs: IngestionRunRecord[];
  execution_status: ExecutionStatus;
  api_onboarding: ApiOnboardingSnapshot;
  model_lab: ModelLabReadinessSnapshot;
  replay_lab: ReplayLabSnapshot;
  generated_at: string;
};

export type LiveDashboardSnapshot = {
  matches: MatchAnalysis[];
  metrics: DailyMetrics;
  signals: Signal[];
  operational_state: OperationalStateSnapshot;
  readiness: LiveReadinessSnapshot;
  generated_at: string;
};

export type LiveReadinessCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  detail: string | null;
};

export type LiveReadinessSnapshot = {
  status: "ready" | "degraded" | "blocked";
  can_analyze_live: boolean;
  can_generate_entries: boolean;
  can_submit_real_orders: boolean;
  blockers: string[];
  warnings: string[];
  checks: LiveReadinessCheck[];
  generated_at: string;
};

export type ExecutionStatus = {
  execution_enabled: boolean;
  venue: "betfair";
  stage: ExecutionStage;
  betfair_configured: boolean;
  betfair_live_key_approved: boolean;
  real_execution_hard_block: boolean;
  kill_switch_enabled: boolean;
  can_submit_real_orders: boolean;
  reasons: string[];
};

export type BankrollSnapshot = {
  base_currency: string;
  bankroll_amount: number;
  available_amount: number;
  open_exposure: number;
  realized_pnl: number;
  daily_pnl: number;
  weekly_drawdown: number;
  clv: number | null;
  execution_stage: ExecutionStage;
  max_order_stake_fraction: number;
  daily_loss_limit_fraction: number;
  weekly_drawdown_limit_fraction: number;
  updated_at: string;
};

export type ExecutionOrder = {
  id: string;
  signal_id: string;
  match_id: string;
  player_id: string;
  player_name: string;
  venue: "betfair";
  status: OrderStatus;
  side: "BACK" | "LAY";
  requested_odds: number;
  accepted_odds: number | null;
  stake_fraction: number;
  stake_amount: number;
  matched_stake: number;
  average_price: number | null;
  external_order_id: string | null;
  customer_order_ref: string | null;
  customer_strategy_ref: string;
  rejection_reason: string | null;
  settlement_status: string | null;
  pnl: number | null;
  clv: number | null;
  risk_snapshot: Record<string, unknown>;
  audit: string[];
  created_at: string;
  updated_at: string;
};

export type ModelPromotionDecision = {
  run_id: string;
  candidate_model_version: string;
  promoted: boolean;
  reasons: string[];
  metrics: BacktestMetrics;
  created_at: string;
};

export type ReplayRunResult = {
  run_id: string;
  match_id: string;
  events_replayed: number;
  score_ticks: number;
  odds_ticks: number;
  signals_generated: number;
  final_status: string;
  provider_cursors: ProviderCursor[];
  raw_payloads_saved: number;
  score_ticks_saved: number;
  odds_ticks_saved: number;
  cursors_saved: number;
  resync_required: boolean;
  notes: string[];
};

export type ReplayContractScenarioResult = {
  scenario: ReplayOddsScenario;
  run_id: string;
  final_status: string;
  events_replayed: number;
  score_ticks: number;
  odds_ticks: number;
  providers_seen: Provider[];
  adapter_contracts: string[];
  input_contracts: string[];
  output_contracts: string[];
  provider_cursors: ProviderCursor[];
  raw_payloads_saved: number;
  score_ticks_saved: number;
  odds_ticks_saved: number;
  cursors_saved: number;
  provider_latency_saved: number;
  resync_required: boolean;
  passed: boolean;
  notes: string[];
};

export type ReplayContractRunResult = {
  match_id: string;
  scenarios: ReplayContractScenarioResult[];
  passed: boolean;
  notes: string[];
};

export type BacktestMetrics = {
  run_id: string;
  model_version: string;
  matches: number;
  signals: number;
  roi: number;
  clv: number;
  brier_score: number;
  log_loss: number;
  calibration_error: number;
  max_drawdown: number;
  promoted: boolean;
  rejection_reason: string | null;
};

export type ProviderCursor = {
  provider: Provider;
  stream: string;
  last_seq: number | null;
  expected_next_seq: number | null;
  status: CursorStatus;
  gap_count: number;
  resync_required: boolean;
  last_message_at: string | null;
  last_resync_at: string | null;
  note: string;
};

export type DataQualitySnapshot = {
  id: string;
  provider: Provider;
  feed: string;
  score_completeness: number;
  odds_completeness: number;
  entity_resolution_rate: number;
  sequence_health: number;
  latency_ms: number | null;
  stale_ticks: number;
  duplicate_ticks: number;
  blocked_signals: number;
  generated_at: string;
  notes: string[];
};

export type CanonicalEntityConflict = {
  id: string;
  entity_type: "player" | "match" | "tournament" | "market";
  provider: Provider;
  canonical_id: string | null;
  candidate_id: string;
  confidence: Confidence;
  similarity: number;
  reason: string;
  source_payload_ids: string[];
  created_at: string;
};

export type ModelRegistryEntry = {
  model_version: string;
  role: "champion" | "challenger" | "baseline" | "archived";
  model_type: string;
  feature_set: string;
  training_window: Record<string, unknown>;
  metrics: BacktestMetrics;
  promoted: boolean;
  promoted_at: string | null;
  notes: string[];
};

export type CalibrationBucket = {
  bucket: string;
  lower_bound: number;
  upper_bound: number;
  predictions: number;
  average_prediction: number;
  observed_win_rate: number;
  brier_score: number;
  log_loss: number;
};

export type CalibrationReport = {
  run_id: string;
  model_version: string;
  buckets: CalibrationBucket[];
  brier_score: number;
  log_loss: number;
  calibration_error: number;
  generated_at: string;
};

export type PaperSettlement = {
  order_id: string;
  status: OrderStatus;
  result_win: boolean;
  requested_odds: number;
  average_price: number;
  matched_stake: number;
  gross_pnl: number;
  commission: number;
  net_pnl: number;
  closing_odds: number;
  clv: number;
  settled_at: string;
};

export type AutoPaperSettleDecision = {
  order_id: string;
  match_id: string | null;
  player_id: string | null;
  status: "settled" | "skipped" | "training_example_missing" | "settlement_failed";
  reason: string;
  result_win: boolean | null;
  closing_odds: number | null;
  training_example_ready: boolean;
};

export type AutoPaperSettleResult = {
  evaluated_orders: number;
  settled_orders: number;
  skipped_orders: number;
  training_examples_ready: number;
  decisions: AutoPaperSettleDecision[];
  settlements: PaperSettlement[];
  reasons: string[];
};

export type PaperRehearsalResult = {
  enabled: boolean;
  match_id: string | null;
  signal_id: string | null;
  order_id: string | null;
  settled_orders: number;
  training_examples_ready: number;
  settlement_decisions: AutoPaperSettleDecision[];
  live_api_calls: number;
  notes: string[];
};

export type DailyOperationalBacktestStatus = {
  status: "completed" | "skipped";
  model_version: string;
  feature_set: string;
  reason: string | null;
  run_id: string | null;
  signals: number | null;
  roi: number | null;
  clv: number | null;
  brier_score: number | null;
  log_loss: number | null;
  calibration_error: number | null;
  max_drawdown: number | null;
};

export type DailyOperationalRunResult = {
  status: "completed" | "collecting" | "degraded";
  generated_at: string;
  source: "api" | "cli" | "openclaw" | "cron" | "system";
  live_api_calls: number;
  match_id: string;
  replay_contracts: ReplayContractRunResult;
  paper_rehearsal: PaperRehearsalResult | null;
  paper_auto_settlement: AutoPaperSettleResult;
  model_lab_backtest: DailyOperationalBacktestStatus;
  execution: {
    can_submit_real_orders: boolean;
    real_execution_hard_block: boolean;
    stage: ExecutionStage;
  };
};

export type PaperPerformance = {
  orders: number;
  settled_orders: number;
  positive_clv_signals: number;
  wins: number;
  losses: number;
  open_orders: number;
  roi: number | null;
  clv: number | null;
  realized_pnl: number;
  max_drawdown: number;
  calibration_error: number | null;
  readiness_status: "collecting" | "review_ready";
  readiness_reasons: string[];
  segments: Array<{
    segment_type: "model" | "odds_bucket" | "surface" | "tour" | "provider";
    segment: string;
    settled_orders: number;
    roi: number | null;
    clv: number | null;
    realized_pnl: number;
  }>;
};

export type AgentModelRoute = {
  task: string;
  model: string;
  reason: string;
  estimated_cost_usd: number;
};

export type AgentAction = {
  type: string;
  status: AgentActionStatus;
  target_id: string | null;
  summary: string;
  cost_usd: number;
  created_at: string;
};

export type AgentRun = {
  id: string;
  run_type: AgentRunType;
  source: "dashboard" | "telegram" | "cron" | "openclaw" | "system";
  model_routes: AgentModelRoute[];
  actions: AgentAction[];
  summary: string;
  created_at: string;
};

export type AgentPreflightCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  detail: string | null;
};

export type AgentPreflight = {
  status: "ready" | "degraded" | "blocked";
  checks: AgentPreflightCheck[];
  generated_at: string;
};

export type AgentAnomaly = {
  id: string;
  severity: "info" | "warning" | "critical";
  category: string;
  summary: string;
  detail: string;
  blocked_signals: number;
  detected_at: string;
};

export type AgentBriefing = {
  generated_at: string;
  autopilot_enabled: boolean;
  channel: string;
  allowed_actions: string[];
  triage_model: string;
  critical_model: string;
  router_policy: string;
  daily_model_budget_usd: number;
  live_matches: number;
  entry_signals: number;
  paper_orders: number;
  open_orders: number;
  provider_alerts: number;
  readiness_status: "collecting" | "review_ready";
  summary: string;
  next_actions: string[];
  latest_run: AgentRun | null;
};

export type AgentAutopilotRequest = {
  source?: "dashboard" | "telegram" | "cron" | "openclaw" | "system";
  create_paper_orders?: boolean;
  request_real_execution?: boolean;
  max_paper_orders?: number;
  notes?: string | null;
};

export type AgentAutopilotResult = {
  run: AgentRun;
  paper_orders_created: number;
  paper_orders_skipped: number;
  real_execution_blocked: boolean;
  anomalies: AgentAnomaly[];
  created_orders: ExecutionOrder[];
};

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
  confidence: Confidence;
  mode: "prematch" | "live";
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

export type ReplayRunResult = {
  run_id: string;
  match_id: string;
  events_replayed: number;
  score_ticks: number;
  odds_ticks: number;
  signals_generated: number;
  final_status: string;
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

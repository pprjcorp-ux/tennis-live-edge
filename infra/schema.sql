CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  provider_ids JSONB NOT NULL DEFAULT '{}',
  name TEXT NOT NULL,
  tour TEXT NOT NULL,
  country TEXT,
  ranking INTEGER,
  handedness TEXT,
  elo_overall NUMERIC(10, 3) NOT NULL DEFAULT 1500,
  elo_clay NUMERIC(10, 3) NOT NULL DEFAULT 1500,
  elo_hard NUMERIC(10, 3) NOT NULL DEFAULT 1500,
  hold_rate NUMERIC(8, 6) NOT NULL DEFAULT 0.78,
  break_rate NUMERIC(8, 6) NOT NULL DEFAULT 0.22,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  provider_ids JSONB NOT NULL DEFAULT '{}',
  tournament TEXT NOT NULL,
  round TEXT,
  tour TEXT NOT NULL,
  competition_level TEXT NOT NULL,
  surface TEXT NOT NULL,
  indoor BOOLEAN NOT NULL DEFAULT false,
  best_of INTEGER NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  player1_id TEXT NOT NULL REFERENCES players(id),
  player2_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL,
  data_quality NUMERIC(8, 6) NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_provider_payloads (
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('raw_provider_payloads', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS raw_provider_payloads_provider_ts_idx
  ON raw_provider_payloads (provider, source_ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS raw_provider_payloads_checksum_uidx
  ON raw_provider_payloads (checksum, ingested_at);

CREATE TABLE IF NOT EXISTS score_ticks (
  id BIGSERIAL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider TEXT NOT NULL,
  raw_state JSONB NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('score_ticks', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS score_ticks_match_source_idx
  ON score_ticks (match_id, source_ts DESC);

CREATE TABLE IF NOT EXISTS point_events (
  id TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  set_number INTEGER NOT NULL,
  game_number INTEGER NOT NULL,
  server_player_id TEXT REFERENCES players(id),
  winner_player_id TEXT REFERENCES players(id),
  point_score TEXT NOT NULL,
  description TEXT NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('point_events', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS point_events_match_seq_idx
  ON point_events (match_id, sequence);

CREATE TABLE IF NOT EXISTS odds_ticks (
  id BIGSERIAL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider TEXT NOT NULL,
  bookmaker TEXT NOT NULL,
  market TEXT NOT NULL,
  outcome_player_id TEXT NOT NULL REFERENCES players(id),
  decimal_odds NUMERIC(8, 4) NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('odds_ticks', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS odds_ticks_match_market_book_idx
  ON odds_ticks (match_id, market, bookmaker, source_ts DESC);

CREATE TABLE IF NOT EXISTS market_suspensions (
  id BIGSERIAL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  provider TEXT NOT NULL,
  bookmaker TEXT NOT NULL,
  market TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  source_ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('market_suspensions', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS market_suspensions_match_status_idx
  ON market_suspensions (match_id, status, source_ts DESC);

CREATE TABLE IF NOT EXISTS provider_latency (
  id BIGSERIAL,
  provider TEXT NOT NULL,
  feed TEXT NOT NULL,
  latest_source_ts TIMESTAMPTZ NOT NULL,
  latest_ingested_at TIMESTAMPTZ NOT NULL,
  latency_ms INTEGER NOT NULL,
  healthy BOOLEAN NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, ingested_at)
);

SELECT create_hypertable('provider_latency', 'ingested_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS provider_latency_provider_idx
  ON provider_latency (provider, feed, ingested_at DESC);

CREATE TABLE IF NOT EXISTS provider_cursors (
  provider TEXT NOT NULL,
  stream TEXT NOT NULL,
  last_seq BIGINT,
  expected_next_seq BIGINT,
  status TEXT NOT NULL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  resync_required BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ,
  last_resync_at TIMESTAMPTZ,
  note TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, stream)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ingestion_runs_completed_idx
  ON ingestion_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS data_quality_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  feed TEXT NOT NULL,
  score_completeness NUMERIC(8, 6) NOT NULL,
  odds_completeness NUMERIC(8, 6) NOT NULL,
  entity_resolution_rate NUMERIC(8, 6) NOT NULL,
  sequence_health NUMERIC(8, 6) NOT NULL,
  latency_ms INTEGER,
  stale_ticks INTEGER NOT NULL DEFAULT 0,
  duplicate_ticks INTEGER NOT NULL DEFAULT 0,
  blocked_signals INTEGER NOT NULL DEFAULT 0,
  notes JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canonical_entity_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  canonical_id TEXT,
  candidate_id TEXT NOT NULL,
  confidence TEXT NOT NULL,
  similarity NUMERIC(8, 6) NOT NULL,
  reason TEXT NOT NULL,
  source_payload_ids JSONB NOT NULL DEFAULT '[]',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  feature_set TEXT NOT NULL,
  values JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  model_type TEXT NOT NULL,
  training_window JSONB NOT NULL,
  metrics JSONB NOT NULL,
  promoted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  model_version_id TEXT NOT NULL REFERENCES model_versions(id),
  mode TEXT NOT NULL,
  p1_win_prob NUMERIC(8, 6) NOT NULL,
  p2_win_prob NUMERIC(8, 6) NOT NULL,
  raw_p1_win_prob NUMERIC(8, 6),
  raw_p2_win_prob NUMERIC(8, 6),
  confidence_interval JSONB,
  confidence TEXT NOT NULL,
  feature_snapshot_id BIGINT REFERENCES feature_snapshots(id),
  explanations JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  prediction_snapshot_id TEXT REFERENCES prediction_snapshots(id),
  outcome_player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL,
  model_prob NUMERIC(8, 6) NOT NULL,
  market_prob NUMERIC(8, 6) NOT NULL,
  best_odds NUMERIC(8, 4) NOT NULL,
  edge NUMERIC(8, 6) NOT NULL,
  stake_fraction NUMERIC(8, 6) NOT NULL,
  risk JSONB NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT NOT NULL REFERENCES signals(id),
  external_order_ref TEXT UNIQUE,
  external_signal_id TEXT,
  match_id TEXT REFERENCES matches(id),
  player_id TEXT REFERENCES players(id),
  venue TEXT NOT NULL DEFAULT 'betfair',
  market_id TEXT,
  selection_id BIGINT,
  customer_order_ref TEXT,
  requested_odds NUMERIC(8, 4) NOT NULL,
  accepted_odds NUMERIC(8, 4),
  stake_fraction NUMERIC(8, 6) NOT NULL,
  stake_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  matched_stake NUMERIC(14, 2) NOT NULL DEFAULT 0,
  average_price NUMERIC(8, 4),
  risk_snapshot JSONB NOT NULL DEFAULT '{}',
  rejection_reason TEXT,
  settlement_status TEXT,
  pnl NUMERIC(14, 2),
  clv NUMERIC(8, 6),
  status TEXT NOT NULL,
  audit JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS paper_orders ADD COLUMN IF NOT EXISTS external_order_ref TEXT UNIQUE;
ALTER TABLE IF EXISTS paper_orders ADD COLUMN IF NOT EXISTS external_signal_id TEXT;
ALTER TABLE IF EXISTS paper_orders ADD COLUMN IF NOT EXISTS match_id TEXT REFERENCES matches(id);
ALTER TABLE IF EXISTS paper_orders ADD COLUMN IF NOT EXISTS player_id TEXT REFERENCES players(id);
ALTER TABLE IF EXISTS paper_orders ADD COLUMN IF NOT EXISTS audit JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS paper_fills (
  id BIGSERIAL PRIMARY KEY,
  paper_order_id BIGINT REFERENCES paper_orders(id),
  status TEXT NOT NULL,
  requested_odds NUMERIC(8, 4) NOT NULL,
  available_odds NUMERIC(8, 4) NOT NULL,
  matched_stake NUMERIC(14, 2) NOT NULL,
  average_price NUMERIC(8, 4) NOT NULL,
  unmatched_stake NUMERIC(14, 2) NOT NULL DEFAULT 0,
  slippage NUMERIC(8, 4) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(8, 6) NOT NULL DEFAULT 0.02,
  event_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_settlements (
  id BIGSERIAL PRIMARY KEY,
  paper_order_id BIGINT REFERENCES paper_orders(id),
  result_win BOOLEAN NOT NULL,
  requested_odds NUMERIC(8, 4) NOT NULL,
  average_price NUMERIC(8, 4) NOT NULL,
  matched_stake NUMERIC(14, 2) NOT NULL,
  gross_pnl NUMERIC(14, 2) NOT NULL,
  commission NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_pnl NUMERIC(14, 2) NOT NULL,
  closing_odds NUMERIC(8, 4) NOT NULL,
  clv NUMERIC(8, 6) NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_orders (
  id BIGSERIAL PRIMARY KEY,
  paper_order_id BIGINT REFERENCES paper_orders(id),
  exchange TEXT NOT NULL,
  market_id TEXT,
  selection_id BIGINT,
  customer_order_ref TEXT,
  customer_strategy_ref TEXT NOT NULL DEFAULT 'tennis-edge',
  external_order_id TEXT,
  status TEXT NOT NULL,
  requested_odds NUMERIC(8, 4),
  accepted_odds NUMERIC(8, 4),
  stake_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  matched_stake NUMERIC(14, 2) NOT NULL DEFAULT 0,
  average_price NUMERIC(8, 4),
  rejection_reason TEXT,
  settlement_status TEXT,
  pnl NUMERIC(14, 2),
  clv NUMERIC(8, 6),
  risk_snapshot JSONB NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_orders_disabled_guard CHECK (status <> 'enabled_without_compliance')
);

CREATE TABLE IF NOT EXISTS bankroll_snapshots (
  id BIGSERIAL PRIMARY KEY,
  base_currency TEXT NOT NULL,
  bankroll_amount NUMERIC(14, 2) NOT NULL,
  available_amount NUMERIC(14, 2) NOT NULL,
  open_exposure NUMERIC(14, 2) NOT NULL,
  realized_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0,
  daily_pnl NUMERIC(14, 2) NOT NULL DEFAULT 0,
  weekly_drawdown NUMERIC(8, 6) NOT NULL DEFAULT 0,
  execution_stage TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learning_runs (
  id TEXT PRIMARY KEY,
  model_version_id TEXT REFERENCES model_versions(id),
  run_type TEXT NOT NULL,
  training_window JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  promoted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_promotion_decisions (
  id BIGSERIAL PRIMARY KEY,
  learning_run_id TEXT REFERENCES learning_runs(id),
  candidate_model_version TEXT NOT NULL,
  promoted BOOLEAN NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]',
  metrics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS closing_line_snapshots (
  id BIGSERIAL PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  bookmaker TEXT NOT NULL,
  closing_decimal_odds NUMERIC(8, 4) NOT NULL,
  no_vig_probability NUMERIC(8, 6) NOT NULL,
  source_ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_examples (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  model_version TEXT NOT NULL,
  feature_snapshot_id BIGINT REFERENCES feature_snapshots(id),
  decision_ts TIMESTAMPTZ NOT NULL,
  model_probability NUMERIC(8, 6) NOT NULL,
  market_probability NUMERIC(8, 6) NOT NULL,
  closing_probability NUMERIC(8, 6),
  result_win BOOLEAN,
  pnl NUMERIC(14, 2),
  clv NUMERIC(8, 6),
  stake_amount NUMERIC(14, 2) NOT NULL DEFAULT 1,
  calibration_bucket TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS training_examples ADD COLUMN IF NOT EXISTS stake_amount NUMERIC(14, 2) NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS calibration_reports (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  buckets JSONB NOT NULL DEFAULT '[]',
  brier_score NUMERIC(8, 6) NOT NULL,
  log_loss NUMERIC(8, 6) NOT NULL,
  calibration_error NUMERIC(8, 6) NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_audit_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  source TEXT NOT NULL,
  model_routes JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id),
  run_config JSONB NOT NULL,
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

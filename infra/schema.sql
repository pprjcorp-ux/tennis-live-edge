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
  requested_odds NUMERIC(8, 4) NOT NULL,
  accepted_odds NUMERIC(8, 4),
  stake_fraction NUMERIC(8, 6) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_orders (
  id BIGSERIAL PRIMARY KEY,
  paper_order_id BIGINT REFERENCES paper_orders(id),
  exchange TEXT NOT NULL,
  external_order_id TEXT,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_orders_disabled_guard CHECK (status <> 'enabled_without_compliance')
);

CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id),
  run_config JSONB NOT NULL,
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

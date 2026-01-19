-- =============================================================================
-- Migration 005: Research Tables for 30D Contrarian Analysis
-- =============================================================================

-- Resolved markets with ground truth outcomes
CREATE TABLE IF NOT EXISTS resolved_markets (
  id SERIAL PRIMARY KEY,
  condition_id VARCHAR(66) NOT NULL UNIQUE,
  question TEXT NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  resolution_date TIMESTAMPTZ,
  winning_outcome VARCHAR(10), -- 'Yes' or 'No'
  winning_token_id VARCHAR(100),
  yes_token_id VARCHAR(100),
  no_token_id VARCHAR(100),
  final_yes_price NUMERIC(10,6),
  final_no_price NUMERIC(10,6),
  total_volume NUMERIC(18,2),
  total_liquidity NUMERIC(18,2),
  category VARCHAR(100),
  event_slug VARCHAR(200),
  slug VARCHAR(200),
  backfilled_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_outcome CHECK (winning_outcome IS NULL OR winning_outcome IN ('Yes', 'No'))
);

CREATE INDEX IF NOT EXISTS idx_resolved_markets_end_date ON resolved_markets(end_date);
CREATE INDEX IF NOT EXISTS idx_resolved_markets_category ON resolved_markets(category);

-- Historical trades for resolved markets (separate from live trades table)
CREATE TABLE IF NOT EXISTS historical_trades (
  id SERIAL PRIMARY KEY,
  condition_id VARCHAR(66) NOT NULL,
  token_id VARCHAR(100) NOT NULL,
  trade_id VARCHAR(100),
  trade_timestamp TIMESTAMPTZ NOT NULL,
  taker_address VARCHAR(42),
  maker_address VARCHAR(42),
  side VARCHAR(4) NOT NULL, -- 'BUY' or 'SELL'
  price NUMERIC(10,6) NOT NULL,
  size NUMERIC(18,6) NOT NULL,
  notional NUMERIC(18,2) NOT NULL,
  outcome VARCHAR(10), -- 'Yes' or 'No'
  transaction_hash VARCHAR(66),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(condition_id, trade_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_trades_condition ON historical_trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_historical_trades_timestamp ON historical_trades(trade_timestamp);
CREATE INDEX IF NOT EXISTS idx_historical_trades_token ON historical_trades(token_id);

-- Contrarian signal events (unit of analysis)
CREATE TABLE IF NOT EXISTS contrarian_events (
  id SERIAL PRIMARY KEY,
  condition_id VARCHAR(66) NOT NULL,
  token_id VARCHAR(100) NOT NULL,
  trade_timestamp TIMESTAMPTZ NOT NULL,
  minutes_before_close NUMERIC(10,2) NOT NULL,
  -- Trade details
  trade_side VARCHAR(4) NOT NULL, -- 'BUY'
  trade_price NUMERIC(10,6) NOT NULL,
  trade_size NUMERIC(18,6) NOT NULL,
  trade_notional NUMERIC(18,2) NOT NULL,
  taker_address VARCHAR(42),
  -- Size tail features
  size_percentile NUMERIC(5,2),
  size_z_score NUMERIC(10,4),
  is_tail_trade BOOLEAN DEFAULT FALSE,
  -- Contrarian features (price-based)
  is_price_contrarian BOOLEAN DEFAULT FALSE, -- price < 0.50
  -- Contrarian features (trend-based)
  price_trend_30m NUMERIC(10,6), -- mid change over prior 30m
  is_against_trend BOOLEAN DEFAULT FALSE,
  -- Contrarian features (OFI-based)
  ofi_30m NUMERIC(10,6), -- order flow imbalance
  is_against_ofi BOOLEAN DEFAULT FALSE,
  -- Combined contrarian flag
  is_contrarian BOOLEAN DEFAULT FALSE, -- against both trend and OFI
  -- Book asymmetry features
  book_imbalance NUMERIC(5,4),
  thin_opposite_ratio NUMERIC(5,4),
  spread_bps NUMERIC(10,2),
  is_asymmetric_book BOOLEAN DEFAULT FALSE,
  -- Wallet features
  wallet_age_days NUMERIC(10,2),
  wallet_trade_count INTEGER,
  is_new_wallet BOOLEAN DEFAULT FALSE,
  -- Outcome
  traded_outcome VARCHAR(10) NOT NULL, -- 'Yes' or 'No'
  outcome_won BOOLEAN, -- Did the traded outcome win?
  -- Price drift (post-signal)
  drift_30m NUMERIC(10,6),
  drift_60m NUMERIC(10,6),
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(condition_id, token_id, trade_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_contrarian_events_condition ON contrarian_events(condition_id);
CREATE INDEX IF NOT EXISTS idx_contrarian_events_timestamp ON contrarian_events(trade_timestamp);
CREATE INDEX IF NOT EXISTS idx_contrarian_events_contrarian ON contrarian_events(is_contrarian, outcome_won);
CREATE INDEX IF NOT EXISTS idx_contrarian_events_price_contrarian ON contrarian_events(is_price_contrarian, outcome_won);

-- Daily correlation rollups for fast querying
CREATE TABLE IF NOT EXISTS correlation_rollups (
  id SERIAL PRIMARY KEY,
  rollup_date DATE NOT NULL,
  window_days INTEGER NOT NULL, -- 7, 30, 60
  -- Counts
  total_markets INTEGER NOT NULL,
  markets_with_signals INTEGER NOT NULL,
  total_events INTEGER NOT NULL,
  -- Win rates
  signal_win_rate NUMERIC(5,4),
  baseline_win_rate NUMERIC(5,4),
  -- Correlation
  correlation_r NUMERIC(6,4),
  p_value NUMERIC(10,8),
  ci_lower NUMERIC(6,4),
  ci_upper NUMERIC(6,4),
  lift NUMERIC(6,4),
  -- Config used
  min_size_usd INTEGER,
  window_minutes INTEGER,
  contrarian_mode VARCHAR(20), -- 'price_only', 'vs_trend', 'vs_ofi', 'vs_both'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rollup_date, window_days, min_size_usd, window_minutes, contrarian_mode)
);

-- Backfill job tracking
CREATE TABLE IF NOT EXISTS backfill_jobs (
  id SERIAL PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL, -- 'markets', 'trades', 'events', 'full'
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  items_processed INTEGER DEFAULT 0,
  items_total INTEGER,
  error_message TEXT,
  config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backfill_jobs_status ON backfill_jobs(status);
CREATE INDEX IF NOT EXISTS idx_backfill_jobs_type ON backfill_jobs(job_type);

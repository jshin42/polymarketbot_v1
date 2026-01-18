-- =============================================================================
-- Initial Database Schema for Polymarket Anomaly Bot
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- Markets and Tokens
-- =============================================================================

CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    condition_id VARCHAR(66) NOT NULL UNIQUE,
    question TEXT NOT NULL,
    description TEXT,
    outcomes JSONB NOT NULL,
    end_date_iso TIMESTAMPTZ NOT NULL,
    active BOOLEAN DEFAULT true,
    closed BOOLEAN DEFAULT false,
    resolved BOOLEAN DEFAULT false,
    volume NUMERIC(20, 6) DEFAULT 0,
    liquidity NUMERIC(20, 6) DEFAULT 0,
    neg_risk BOOLEAN DEFAULT false,
    slug VARCHAR(255),
    category VARCHAR(100),
    tags TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_markets_condition_id ON markets(condition_id);
CREATE INDEX idx_markets_end_date ON markets(end_date_iso);
CREATE INDEX idx_markets_active ON markets(active) WHERE active = true;
CREATE INDEX idx_markets_closing_soon ON markets(end_date_iso) WHERE active = true AND closed = false;

CREATE TABLE tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id VARCHAR(78) NOT NULL UNIQUE,
    market_id UUID REFERENCES markets(id) ON DELETE CASCADE,
    outcome VARCHAR(255) NOT NULL,
    winner BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tokens_market_id ON tokens(market_id);
CREATE INDEX idx_tokens_token_id ON tokens(token_id);

-- =============================================================================
-- Time-Series Data (Hypertables)
-- =============================================================================

-- Order book snapshots
CREATE TABLE orderbook_snapshots (
    time TIMESTAMPTZ NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    bids JSONB NOT NULL,
    asks JSONB NOT NULL,
    best_bid NUMERIC(10, 4),
    best_ask NUMERIC(10, 4),
    mid_price NUMERIC(10, 4),
    spread NUMERIC(10, 6),
    spread_bps NUMERIC(10, 2),
    bid_depth_5pct NUMERIC(20, 6),
    bid_depth_10pct NUMERIC(20, 6),
    ask_depth_5pct NUMERIC(20, 6),
    ask_depth_10pct NUMERIC(20, 6),
    imbalance NUMERIC(10, 6),
    hash VARCHAR(66)
);

SELECT create_hypertable('orderbook_snapshots', 'time', chunk_time_interval => INTERVAL '1 hour');
CREATE INDEX idx_orderbook_token_time ON orderbook_snapshots(token_id, time DESC);
CREATE INDEX idx_orderbook_time ON orderbook_snapshots(time DESC);

-- Trades
CREATE TABLE trades (
    time TIMESTAMPTZ NOT NULL,
    trade_id VARCHAR(100) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    maker_address VARCHAR(42) NOT NULL,
    taker_address VARCHAR(42) NOT NULL,
    side VARCHAR(4) NOT NULL,
    price NUMERIC(10, 4) NOT NULL,
    size NUMERIC(20, 6) NOT NULL,
    fee_rate_bps INTEGER,
    UNIQUE(trade_id, time)
);

SELECT create_hypertable('trades', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX idx_trades_token_time ON trades(token_id, time DESC);
CREATE INDEX idx_trades_maker ON trades(maker_address, time DESC);
CREATE INDEX idx_trades_taker ON trades(taker_address, time DESC);
CREATE INDEX idx_trades_time ON trades(time DESC);

-- Features
CREATE TABLE features (
    time TIMESTAMPTZ NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    feature_vector JSONB NOT NULL,
    ttc_minutes NUMERIC(10, 2),
    ramp_multiplier NUMERIC(10, 6),
    data_complete BOOLEAN DEFAULT false,
    data_stale BOOLEAN DEFAULT false
);

SELECT create_hypertable('features', 'time', chunk_time_interval => INTERVAL '1 hour');
CREATE INDEX idx_features_token_time ON features(token_id, time DESC);
CREATE INDEX idx_features_time ON features(time DESC);

-- Scores
CREATE TABLE scores (
    time TIMESTAMPTZ NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    anomaly_score NUMERIC(10, 6) NOT NULL,
    execution_score NUMERIC(10, 6) NOT NULL,
    edge_score NUMERIC(10, 6) NOT NULL,
    composite_score NUMERIC(10, 6) NOT NULL,
    signal_strength VARCHAR(20) NOT NULL,
    components JSONB NOT NULL
);

SELECT create_hypertable('scores', 'time', chunk_time_interval => INTERVAL '1 hour');
CREATE INDEX idx_scores_token_time ON scores(token_id, time DESC);
CREATE INDEX idx_scores_composite ON scores(composite_score DESC, time DESC);
CREATE INDEX idx_scores_time ON scores(time DESC);

-- =============================================================================
-- Wallets
-- =============================================================================

CREATE TABLE wallets (
    address VARCHAR(42) PRIMARY KEY,
    first_seen_at TIMESTAMPTZ,
    first_seen_block_number INTEGER,
    transaction_count INTEGER DEFAULT 0,
    polymarket_trade_count INTEGER DEFAULT 0,
    unique_markets_traded INTEGER DEFAULT 0,
    total_volume NUMERIC(20, 6) DEFAULT 0,
    concentration_score NUMERIC(10, 6),
    last_enriched_at TIMESTAMPTZ,
    enrichment_source VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallets_first_seen ON wallets(first_seen_at);
CREATE INDEX idx_wallets_last_enriched ON wallets(last_enriched_at);

-- =============================================================================
-- Decisions and Positions
-- =============================================================================

CREATE TABLE decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    time TIMESTAMPTZ NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    condition_id VARCHAR(66) NOT NULL,
    market_id UUID REFERENCES markets(id),
    action VARCHAR(20) NOT NULL,
    side VARCHAR(3),
    direction VARCHAR(4),
    target_price NUMERIC(10, 4),
    limit_price NUMERIC(10, 4),
    current_mid NUMERIC(10, 4),
    target_size_usd NUMERIC(20, 6),
    target_size_shares NUMERIC(20, 6),
    scores JSONB NOT NULL,
    features JSONB NOT NULL,
    approved BOOLEAN DEFAULT false,
    rejection_reason VARCHAR(100),
    risk_checks_passed BOOLEAN DEFAULT false,
    paper_mode BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX idx_decisions_token_time ON decisions(token_id, time DESC);
CREATE INDEX idx_decisions_approved ON decisions(approved, time DESC);
CREATE INDEX idx_decisions_time ON decisions(time DESC);

CREATE TABLE paper_positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_id VARCHAR(78) NOT NULL,
    condition_id VARCHAR(66) NOT NULL,
    market_id UUID REFERENCES markets(id),
    decision_id UUID REFERENCES decisions(id),
    side VARCHAR(3) NOT NULL,
    direction VARCHAR(5) NOT NULL,
    entry_price NUMERIC(10, 4) NOT NULL,
    size NUMERIC(20, 6) NOT NULL,
    size_usd NUMERIC(20, 6) NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    current_price NUMERIC(10, 4),
    unrealized_pnl NUMERIC(20, 6),
    unrealized_pnl_pct NUMERIC(10, 6),
    exit_price NUMERIC(10, 4),
    exit_time TIMESTAMPTZ,
    realized_pnl NUMERIC(20, 6),
    realized_pnl_pct NUMERIC(10, 6),
    status VARCHAR(20) DEFAULT 'open',
    close_reason VARCHAR(50),
    paper_mode BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_paper_positions_status ON paper_positions(status) WHERE status = 'open';
CREATE INDEX idx_paper_positions_token ON paper_positions(token_id);
CREATE INDEX idx_paper_positions_entry_time ON paper_positions(entry_time DESC);

-- =============================================================================
-- Audit Log (Append-Only)
-- =============================================================================

CREATE TABLE audit_log (
    id BIGSERIAL,
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id VARCHAR(100),
    payload JSONB NOT NULL,
    checksum VARCHAR(64) NOT NULL
);

SELECT create_hypertable('audit_log', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX idx_audit_service_time ON audit_log(service, time DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, time DESC);
CREATE INDEX idx_audit_time ON audit_log(time DESC);

-- =============================================================================
-- Risk and Exposure
-- =============================================================================

CREATE TABLE risk_exposure (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_exposure NUMERIC(20, 6) NOT NULL,
    bankroll NUMERIC(20, 6) NOT NULL,
    exposure_pct NUMERIC(10, 6) NOT NULL,
    open_positions INTEGER NOT NULL,
    daily_pnl NUMERIC(20, 6) NOT NULL,
    drawdown_pct NUMERIC(10, 6) NOT NULL,
    circuit_breaker_active BOOLEAN DEFAULT false
);

SELECT create_hypertable('risk_exposure', 'time', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX idx_risk_exposure_time ON risk_exposure(time DESC);

-- =============================================================================
-- Configuration
-- =============================================================================

CREATE TABLE config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default configuration
INSERT INTO config (key, value, description) VALUES
    ('collection.orderbook_interval_ms', '"1000"', 'Orderbook snapshot interval in milliseconds'),
    ('collection.trade_poll_interval_ms', '"1000"', 'Trade poll interval in milliseconds'),
    ('staleness.threshold_ms', '"10000"', 'Data staleness threshold in milliseconds'),
    ('risk.max_exposure_pct', '"0.10"', 'Maximum exposure as % of bankroll'),
    ('risk.max_single_bet_pct', '"0.02"', 'Maximum single bet as % of bankroll'),
    ('risk.max_position_pct', '"0.05"', 'Maximum single position as % of bankroll'),
    ('risk.daily_loss_limit_pct', '"0.05"', 'Daily loss circuit breaker threshold'),
    ('risk.max_drawdown_pct', '"0.15"', 'Maximum drawdown circuit breaker threshold'),
    ('risk.no_trade_zone_seconds', '"120"', 'No-trade zone before market close in seconds'),
    ('strategy.kelly_fraction', '"0.25"', 'Fractional Kelly multiplier'),
    ('strategy.min_anomaly_score', '"0.65"', 'Minimum anomaly score threshold'),
    ('strategy.min_execution_score', '"0.55"', 'Minimum execution score threshold'),
    ('paper.initial_bankroll', '"10000"', 'Initial paper trading bankroll in USD'),
    ('paper.mode', 'true', 'Enable paper trading mode'),
    ('live.enabled', 'false', 'Enable live trading (requires paper.mode = false)');

-- =============================================================================
-- Functions and Triggers
-- =============================================================================

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_markets_updated_at BEFORE UPDATE ON markets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_paper_positions_updated_at BEFORE UPDATE ON paper_positions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_updated_at BEFORE UPDATE ON config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON TABLE markets IS 'Polymarket market metadata from Gamma API';
COMMENT ON TABLE tokens IS 'Individual outcome tokens for each market';
COMMENT ON TABLE orderbook_snapshots IS 'Time-series order book snapshots from CLOB API';
COMMENT ON TABLE trades IS 'Time-series trade records from CLOB API';
COMMENT ON TABLE features IS 'Computed feature vectors for anomaly detection';
COMMENT ON TABLE scores IS 'Computed anomaly, execution, and edge scores';
COMMENT ON TABLE wallets IS 'Wallet enrichment data from on-chain sources';
COMMENT ON TABLE decisions IS 'Trading decisions made by the strategy';
COMMENT ON TABLE paper_positions IS 'Paper trading positions for backtesting';
COMMENT ON TABLE audit_log IS 'Append-only audit trail for all system events';
COMMENT ON TABLE risk_exposure IS 'Real-time risk exposure tracking';
COMMENT ON TABLE config IS 'System configuration key-value store';

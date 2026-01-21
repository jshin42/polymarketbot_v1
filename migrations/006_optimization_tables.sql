-- =============================================================================
-- Migration 006: GTO Optimization Tables
-- =============================================================================
-- Supports grid search optimization, strategy monitoring, and quant analysis

-- -----------------------------------------------------------------------------
-- Optimization Jobs - Track optimization runs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS optimization_jobs (
  id SERIAL PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,  -- 'grid_search', 'incremental', 'sensitivity'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
  config JSONB,

  total_configs INTEGER,
  processed_configs INTEGER DEFAULT 0,
  valid_configs INTEGER DEFAULT 0,

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  execution_time_ms INTEGER,
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_optimization_jobs_status ON optimization_jobs(status);
CREATE INDEX IF NOT EXISTS idx_optimization_jobs_created ON optimization_jobs(created_at DESC);

-- -----------------------------------------------------------------------------
-- Optimization Results - Store grid search results with rankings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS optimization_results (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES optimization_jobs(id) ON DELETE CASCADE,
  config_hash VARCHAR(64) NOT NULL,
  config JSONB NOT NULL,

  -- Core metrics
  sample_size INTEGER NOT NULL,
  win_rate NUMERIC(5,4),
  total_pnl NUMERIC(18,2),
  roi NUMERIC(8,4),
  profit_factor NUMERIC(8,4),
  edge_points NUMERIC(8,4),
  sharpe_ratio NUMERIC(8,4),
  kelly_fraction NUMERIC(5,4),

  -- Statistical significance
  p_value NUMERIC(10,8),
  adjusted_p_value NUMERIC(10,8),
  ci_lower NUMERIC(6,4),
  ci_upper NUMERIC(6,4),
  is_significant BOOLEAN DEFAULT FALSE,

  -- Pareto optimization
  is_pareto_optimal BOOLEAN DEFAULT FALSE,
  pareto_rank INTEGER,

  -- Rankings by objective
  rank_pnl INTEGER,
  rank_roi INTEGER,
  rank_profit_factor INTEGER,
  rank_edge INTEGER,
  rank_sharpe INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(job_id, config_hash)
);

CREATE INDEX IF NOT EXISTS idx_optimization_results_job ON optimization_results(job_id);
CREATE INDEX IF NOT EXISTS idx_optimization_results_pareto ON optimization_results(is_pareto_optimal) WHERE is_pareto_optimal = TRUE;
CREATE INDEX IF NOT EXISTS idx_optimization_results_pnl ON optimization_results(total_pnl DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_results_roi ON optimization_results(roi DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_results_significant ON optimization_results(is_significant) WHERE is_significant = TRUE;

-- -----------------------------------------------------------------------------
-- Monitored Strategies - Active strategy monitoring configurations
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitored_strategies (
  id SERIAL PRIMARY KEY,
  strategy_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(200),
  description TEXT,
  config JSONB NOT NULL,

  -- Baseline metrics (from initial analysis)
  baseline_win_rate NUMERIC(5,4),
  baseline_roi NUMERIC(8,4),
  baseline_edge_points NUMERIC(8,4),
  baseline_kelly NUMERIC(5,4),
  baseline_sample_size INTEGER,
  baseline_date TIMESTAMPTZ,

  -- Current metrics (updated periodically)
  current_win_rate NUMERIC(5,4),
  current_roi NUMERIC(8,4),
  current_edge_points NUMERIC(8,4),
  current_sample_size INTEGER,
  recommended_kelly NUMERIC(5,4),

  is_active BOOLEAN DEFAULT TRUE,
  is_healthy BOOLEAN DEFAULT TRUE,
  last_check_at TIMESTAMPTZ,
  check_interval_minutes INTEGER DEFAULT 60,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitored_strategies_active ON monitored_strategies(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_monitored_strategies_unhealthy ON monitored_strategies(is_healthy) WHERE is_healthy = FALSE;

-- -----------------------------------------------------------------------------
-- Drift Alerts - Alert history with acknowledgment
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drift_alerts (
  id SERIAL PRIMARY KEY,
  strategy_id VARCHAR(64) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,  -- 'drift', 'performance', 'sample_size', 'kelly'
  metric VARCHAR(50) NOT NULL,

  expected_value NUMERIC(18,4),
  observed_value NUMERIC(18,4),
  deviation_sigma NUMERIC(8,4),

  severity VARCHAR(20) NOT NULL,  -- 'info', 'warning', 'critical'
  message TEXT,
  recommendation TEXT,

  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_severity CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_drift_alerts_strategy ON drift_alerts(strategy_id);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_severity ON drift_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_drift_alerts_unacked ON drift_alerts(acknowledged) WHERE acknowledged = FALSE;
CREATE INDEX IF NOT EXISTS idx_drift_alerts_created ON drift_alerts(created_at DESC);

-- -----------------------------------------------------------------------------
-- Quant Reports - Stored analysis reports
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quant_reports (
  id SERIAL PRIMARY KEY,
  report_type VARCHAR(50) NOT NULL,  -- 'full', 'incremental', 'strategy'

  data_start TIMESTAMPTZ,
  data_end TIMESTAMPTZ,
  total_events INTEGER,
  resolved_events INTEGER,

  -- Analysis results
  strategies_tested INTEGER,
  significant_strategies INTEGER,
  top_strategies JSONB,  -- Array of top strategy results
  correlation_matrix JSONB,
  recommendations JSONB,

  -- Metadata
  config_used JSONB,
  execution_time_ms INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quant_reports_type ON quant_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_quant_reports_created ON quant_reports(created_at DESC);

-- -----------------------------------------------------------------------------
-- Strategy Performance History - Track strategy metrics over time
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategy_performance_history (
  id SERIAL PRIMARY KEY,
  strategy_id VARCHAR(64) NOT NULL,
  snapshot_date DATE NOT NULL,

  -- Metrics at snapshot time
  sample_size INTEGER,
  win_rate NUMERIC(5,4),
  total_pnl NUMERIC(18,2),
  roi NUMERIC(8,4),
  profit_factor NUMERIC(8,4),
  edge_points NUMERIC(8,4),
  sharpe_ratio NUMERIC(8,4),
  kelly_fraction NUMERIC(5,4),

  -- Rolling metrics (last 7 days)
  rolling_7d_win_rate NUMERIC(5,4),
  rolling_7d_pnl NUMERIC(18,2),
  rolling_7d_trades INTEGER,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(strategy_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_strategy_performance_strategy ON strategy_performance_history(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_performance_date ON strategy_performance_history(snapshot_date DESC);

-- -----------------------------------------------------------------------------
-- Add is_resolved column to contrarian_events if not exists
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contrarian_events' AND column_name = 'is_resolved'
  ) THEN
    ALTER TABLE contrarian_events ADD COLUMN is_resolved BOOLEAN DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_contrarian_events_resolved ON contrarian_events(is_resolved) WHERE is_resolved = TRUE;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Helper function: Update timestamp trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to monitored_strategies
DROP TRIGGER IF EXISTS update_monitored_strategies_updated_at ON monitored_strategies;
CREATE TRIGGER update_monitored_strategies_updated_at
  BEFORE UPDATE ON monitored_strategies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Comments for documentation
-- -----------------------------------------------------------------------------
COMMENT ON TABLE optimization_jobs IS 'Tracks GTO grid search and optimization runs';
COMMENT ON TABLE optimization_results IS 'Stores results from grid search with rankings by multiple objectives';
COMMENT ON TABLE monitored_strategies IS 'Active strategies being monitored for drift detection';
COMMENT ON TABLE drift_alerts IS 'Alerts generated when strategy performance drifts from baseline';
COMMENT ON TABLE quant_reports IS 'Stored quant analysis reports (VPIN, Hawkes, Benford, etc.)';
COMMENT ON TABLE strategy_performance_history IS 'Daily snapshots of strategy performance for trend analysis';

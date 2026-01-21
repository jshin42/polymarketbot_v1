import { Pool } from 'pg';
import { createLogger } from '@polymarketbot/shared';
import {
  type AnalysisConfig,
  type ContrarianEvent,
  AnalysisService,
} from './analysis.service.js';

// =============================================================================
// Monitoring Service - Strategy Drift Detection & Health Monitoring
// =============================================================================

const logger = createLogger('monitoring-service');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface StrategyHealth {
  strategyId: string;
  name: string;
  isHealthy: boolean;
  currentMetrics: {
    winRate: number;
    roi: number;
    edgePoints: number;
    recentPnL: number;
    sampleSize: number;
  };
  baselineMetrics: {
    winRate: number;
    roi: number;
    edgePoints: number;
    sampleSize: number;
  };
  alerts: DriftAlert[];
  recommendedKellyAdjustment: number;
  lastCheckAt: Date;
}

export interface DriftAlert {
  alertId?: number;
  strategyId: string;
  alertType: 'drift' | 'performance' | 'sample_size' | 'kelly';
  metric: string;
  expectedValue: number;
  observedValue: number;
  deviationSigma: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  recommendation: string;
  acknowledged?: boolean;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  createdAt?: Date;
}

export interface MonitoredStrategy {
  id: number;
  strategyId: string;
  name: string;
  description: string;
  config: Partial<AnalysisConfig>;
  baselineWinRate: number;
  baselineRoi: number;
  baselineEdgePoints: number;
  baselineKelly: number;
  baselineSampleSize: number;
  baselineDate: Date;
  currentWinRate: number | null;
  currentRoi: number | null;
  currentEdgePoints: number | null;
  currentSampleSize: number | null;
  recommendedKelly: number | null;
  isActive: boolean;
  isHealthy: boolean;
  lastCheckAt: Date | null;
  checkIntervalMinutes: number;
}

export interface CUSUMResult {
  changeDetected: boolean;
  changePointIndex: number | null;
  cumsumPositive: number[];
  cumsumNegative: number[];
  threshold: number;
}

export interface MonitoringConfig {
  // Drift detection thresholds (in standard deviations)
  warningSigma: number;      // Default: 1.5
  criticalSigma: number;     // Default: 2.5

  // CUSUM parameters
  cusumThreshold: number;    // Default: 5.0
  cusumDrift: number;        // Default: 0.5

  // Performance thresholds
  minSampleSizeForAlert: number;  // Default: 20
  maxKellyAdjustment: number;     // Default: 0.5

  // Check interval
  defaultCheckIntervalMinutes: number;  // Default: 60
}

const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  warningSigma: 1.5,
  criticalSigma: 2.5,
  cusumThreshold: 5.0,
  cusumDrift: 0.5,
  minSampleSizeForAlert: 20,
  maxKellyAdjustment: 0.5,
  defaultCheckIntervalMinutes: 60,
};

// -----------------------------------------------------------------------------
// Monitoring Service Class
// -----------------------------------------------------------------------------

export class MonitoringService {
  private pool: Pool;
  private analysisService: AnalysisService;
  private config: MonitoringConfig;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    pool: Pool,
    analysisService: AnalysisService,
    config: Partial<MonitoringConfig> = {}
  ) {
    this.pool = pool;
    this.analysisService = analysisService;
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Strategy Registration
  // ---------------------------------------------------------------------------

  /**
   * Start monitoring a strategy
   */
  async startMonitoring(
    strategyConfig: Partial<AnalysisConfig>,
    name: string,
    description?: string
  ): Promise<MonitoredStrategy> {
    // Generate strategy ID from config
    const strategyId = this.generateStrategyId(strategyConfig);

    // Get baseline metrics
    const events = await this.analysisService.getContrarianEventsFromDB({
      lookbackDays: 30,
      resolvedOnly: true,
      ...strategyConfig,
    } as AnalysisConfig);

    const resolved = events.filter(e => e.outcomeWon !== null);
    const baseline = this.calculateMetrics(resolved);

    // Insert into database
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO monitored_strategies
       (strategy_id, name, description, config,
        baseline_win_rate, baseline_roi, baseline_edge_points, baseline_kelly, baseline_sample_size, baseline_date,
        is_active, is_healthy, check_interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), true, true, $10)
       ON CONFLICT (strategy_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         config = EXCLUDED.config,
         baseline_win_rate = EXCLUDED.baseline_win_rate,
         baseline_roi = EXCLUDED.baseline_roi,
         baseline_edge_points = EXCLUDED.baseline_edge_points,
         baseline_kelly = EXCLUDED.baseline_kelly,
         baseline_sample_size = EXCLUDED.baseline_sample_size,
         baseline_date = NOW(),
         is_active = true,
         updated_at = NOW()
       RETURNING id`,
      [
        strategyId,
        name,
        description || '',
        JSON.stringify(strategyConfig),
        baseline.winRate,
        baseline.roi,
        baseline.edgePoints,
        baseline.kellyFraction,
        baseline.n,
        this.config.defaultCheckIntervalMinutes,
      ]
    );

    logger.info({ strategyId, name, baseline }, 'Started monitoring strategy');

    return {
      id: result.rows[0].id,
      strategyId,
      name,
      description: description || '',
      config: strategyConfig,
      baselineWinRate: baseline.winRate,
      baselineRoi: baseline.roi,
      baselineEdgePoints: baseline.edgePoints,
      baselineKelly: baseline.kellyFraction,
      baselineSampleSize: baseline.n,
      baselineDate: new Date(),
      currentWinRate: null,
      currentRoi: null,
      currentEdgePoints: null,
      currentSampleSize: null,
      recommendedKelly: null,
      isActive: true,
      isHealthy: true,
      lastCheckAt: null,
      checkIntervalMinutes: this.config.defaultCheckIntervalMinutes,
    };
  }

  /**
   * Stop monitoring a strategy
   */
  async stopMonitoring(strategyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE monitored_strategies SET is_active = false, updated_at = NOW() WHERE strategy_id = $1`,
      [strategyId]
    );
    logger.info({ strategyId }, 'Stopped monitoring strategy');
  }

  // ---------------------------------------------------------------------------
  // Health Checks
  // ---------------------------------------------------------------------------

  /**
   * Check all active strategies for drift
   */
  async checkAllStrategies(): Promise<StrategyHealth[]> {
    const result = await this.pool.query<{
      id: number;
      strategy_id: string;
      name: string;
      config: string;
      baseline_win_rate: number;
      baseline_roi: number;
      baseline_edge_points: number;
      baseline_kelly: number;
      baseline_sample_size: number;
    }>(
      `SELECT id, strategy_id, name, config, baseline_win_rate, baseline_roi, baseline_edge_points, baseline_kelly, baseline_sample_size
       FROM monitored_strategies
       WHERE is_active = true`
    );

    const healthReports: StrategyHealth[] = [];

    for (const row of result.rows) {
      const config = JSON.parse(row.config);
      const health = await this.checkStrategyHealth(row.strategy_id, config, {
        winRate: row.baseline_win_rate,
        roi: row.baseline_roi,
        edgePoints: row.baseline_edge_points,
        kellyFraction: row.baseline_kelly,
        n: row.baseline_sample_size,
      });

      healthReports.push({
        ...health,
        name: row.name,
      });

      // Update database with current metrics
      await this.updateStrategyMetrics(row.strategy_id, health);
    }

    return healthReports;
  }

  /**
   * Check health of a single strategy
   */
  async checkStrategyHealth(
    strategyId: string,
    config: Partial<AnalysisConfig>,
    baseline: { winRate: number; roi: number; edgePoints: number; kellyFraction: number; n: number }
  ): Promise<StrategyHealth> {
    // Get recent events (last 7 days for comparison)
    const events = await this.analysisService.getContrarianEventsFromDB({
      lookbackDays: 7,
      resolvedOnly: true,
      ...config,
    } as AnalysisConfig);

    const resolved = events.filter(e => e.outcomeWon !== null);
    const current = this.calculateMetrics(resolved);

    // Detect drift for each metric
    const alerts: DriftAlert[] = [];

    // Win rate drift
    const winRateDrift = this.detectDrift(
      strategyId,
      'win_rate',
      baseline.winRate,
      current.winRate,
      current.n
    );
    if (winRateDrift) alerts.push(winRateDrift);

    // ROI drift
    const roiDrift = this.detectDrift(
      strategyId,
      'roi',
      baseline.roi,
      current.roi,
      current.n
    );
    if (roiDrift) alerts.push(roiDrift);

    // Edge points drift
    const edgeDrift = this.detectDrift(
      strategyId,
      'edge_points',
      baseline.edgePoints,
      current.edgePoints,
      current.n
    );
    if (edgeDrift) alerts.push(edgeDrift);

    // Sample size warning
    if (current.n < this.config.minSampleSizeForAlert) {
      alerts.push({
        strategyId,
        alertType: 'sample_size',
        metric: 'sample_size',
        expectedValue: this.config.minSampleSizeForAlert,
        observedValue: current.n,
        deviationSigma: 0,
        severity: 'warning',
        message: `Low sample size: ${current.n} events (minimum: ${this.config.minSampleSizeForAlert})`,
        recommendation: 'Wait for more data before making adjustments',
      });
    }

    // Calculate recommended Kelly adjustment
    const kellyAdjustment = this.recalibrateKelly(baseline, current);

    // Determine overall health
    const hasCriticalAlert = alerts.some(a => a.severity === 'critical');
    const hasWarningAlert = alerts.some(a => a.severity === 'warning');
    const isHealthy = !hasCriticalAlert && !hasWarningAlert;

    // Store alerts
    for (const alert of alerts) {
      await this.storeAlert(alert);
    }

    return {
      strategyId,
      name: '',
      isHealthy,
      currentMetrics: {
        winRate: current.winRate,
        roi: current.roi,
        edgePoints: current.edgePoints,
        recentPnL: current.totalPnL,
        sampleSize: current.n,
      },
      baselineMetrics: {
        winRate: baseline.winRate,
        roi: baseline.roi,
        edgePoints: baseline.edgePoints,
        sampleSize: baseline.n,
      },
      alerts,
      recommendedKellyAdjustment: kellyAdjustment,
      lastCheckAt: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Drift Detection
  // ---------------------------------------------------------------------------

  /**
   * Detect drift in a metric using z-score
   */
  private detectDrift(
    strategyId: string,
    metric: string,
    expected: number,
    observed: number,
    n: number
  ): DriftAlert | null {
    if (n < this.config.minSampleSizeForAlert) return null;

    // Calculate standard error (using binomial approximation for rates)
    const se = Math.sqrt(expected * (1 - expected) / n);
    if (se === 0) return null;

    const zScore = Math.abs((observed - expected) / se);
    const isNegative = observed < expected;

    if (zScore >= this.config.criticalSigma) {
      return {
        strategyId,
        alertType: 'drift',
        metric,
        expectedValue: expected,
        observedValue: observed,
        deviationSigma: zScore * (isNegative ? -1 : 1),
        severity: 'critical',
        message: `Critical drift detected in ${metric}: expected ${(expected * 100).toFixed(1)}%, observed ${(observed * 100).toFixed(1)}% (${zScore.toFixed(1)}σ)`,
        recommendation: isNegative
          ? 'Consider reducing position sizes or pausing the strategy'
          : 'Performance exceeds baseline - may indicate regime change',
      };
    }

    if (zScore >= this.config.warningSigma) {
      return {
        strategyId,
        alertType: 'drift',
        metric,
        expectedValue: expected,
        observedValue: observed,
        deviationSigma: zScore * (isNegative ? -1 : 1),
        severity: 'warning',
        message: `Drift warning in ${metric}: expected ${(expected * 100).toFixed(1)}%, observed ${(observed * 100).toFixed(1)}% (${zScore.toFixed(1)}σ)`,
        recommendation: 'Monitor closely for continued drift',
      };
    }

    return null;
  }

  /**
   * CUSUM (Cumulative Sum) change-point detection
   * Uses the Page-Hinkley algorithm for detecting mean shifts
   */
  detectChangePoint(
    values: number[],
    threshold: number = this.config.cusumThreshold,
    drift: number = this.config.cusumDrift
  ): CUSUMResult {
    if (values.length < 5) {
      return {
        changeDetected: false,
        changePointIndex: null,
        cumsumPositive: [],
        cumsumNegative: [],
        threshold,
      };
    }

    // Calculate target (mean of first half or baseline)
    const baselineEnd = Math.floor(values.length / 3);
    const target = values.slice(0, baselineEnd).reduce((a, b) => a + b, 0) / baselineEnd;

    const cumsumPositive: number[] = [];
    const cumsumNegative: number[] = [];
    let sPlus = 0;
    let sMinus = 0;
    let changePointIndex: number | null = null;

    for (let i = 0; i < values.length; i++) {
      const x = values[i];

      // Update positive CUSUM (detecting increase)
      sPlus = Math.max(0, sPlus + x - target - drift);
      cumsumPositive.push(sPlus);

      // Update negative CUSUM (detecting decrease)
      sMinus = Math.max(0, sMinus + target - x - drift);
      cumsumNegative.push(sMinus);

      // Check for change point
      if (sPlus > threshold || sMinus > threshold) {
        if (changePointIndex === null) {
          changePointIndex = i;
        }
      }
    }

    return {
      changeDetected: changePointIndex !== null,
      changePointIndex,
      cumsumPositive,
      cumsumNegative,
      threshold,
    };
  }

  /**
   * Detect change points in a time series of win rates
   */
  async detectWinRateChangePoint(
    strategyId: string,
    windowSize: number = 10
  ): Promise<CUSUMResult & { dates: Date[] }> {
    // Get strategy config
    const result = await this.pool.query<{ config: string }>(
      `SELECT config FROM monitored_strategies WHERE strategy_id = $1`,
      [strategyId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    const config = JSON.parse(result.rows[0].config);

    // Get events for last 60 days
    const events = await this.analysisService.getContrarianEventsFromDB({
      lookbackDays: 60,
      resolvedOnly: true,
      ...config,
    } as AnalysisConfig);

    // Group by date and calculate rolling win rates
    const sortedEvents = [...events]
      .filter(e => e.outcomeWon !== null)
      .sort((a, b) => new Date(a.tradeTimestamp).getTime() - new Date(b.tradeTimestamp).getTime());

    if (sortedEvents.length < windowSize * 2) {
      return {
        changeDetected: false,
        changePointIndex: null,
        cumsumPositive: [],
        cumsumNegative: [],
        threshold: this.config.cusumThreshold,
        dates: [],
      };
    }

    // Calculate rolling win rates
    const winRates: number[] = [];
    const dates: Date[] = [];

    for (let i = windowSize - 1; i < sortedEvents.length; i++) {
      const windowEvents = sortedEvents.slice(i - windowSize + 1, i + 1);
      const wins = windowEvents.filter(e => e.outcomeWon).length;
      winRates.push(wins / windowSize);
      dates.push(new Date(sortedEvents[i].tradeTimestamp));
    }

    const cusumResult = this.detectChangePoint(winRates);

    return {
      ...cusumResult,
      dates,
    };
  }

  // ---------------------------------------------------------------------------
  // Kelly Recalibration
  // ---------------------------------------------------------------------------

  /**
   * Recalibrate Kelly fraction based on current vs baseline performance
   */
  recalibrateKelly(
    baseline: { winRate: number; kellyFraction: number },
    current: { winRate: number; n: number }
  ): number {
    if (current.n < this.config.minSampleSizeForAlert) {
      // Not enough data - keep baseline
      return baseline.kellyFraction;
    }

    // Calculate new Kelly based on current win rate
    const p = current.winRate;
    const q = 1 - p;

    // Assume average price of 0.5 for Kelly calculation
    // In practice, this should use actual average price
    const avgPrice = 0.5;
    const b = avgPrice > 0 ? (1 - avgPrice) / avgPrice : 0;

    let newKelly = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

    // Apply half-Kelly for safety
    newKelly *= 0.5;

    // Limit adjustment to maxKellyAdjustment from baseline
    const maxIncrease = baseline.kellyFraction * (1 + this.config.maxKellyAdjustment);
    const maxDecrease = baseline.kellyFraction * (1 - this.config.maxKellyAdjustment);

    return Math.max(maxDecrease, Math.min(maxIncrease, newKelly));
  }

  // ---------------------------------------------------------------------------
  // Scheduled Monitoring
  // ---------------------------------------------------------------------------

  /**
   * Start periodic monitoring
   */
  startPeriodicMonitoring(intervalMinutes: number = 60): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    logger.info({ intervalMinutes }, 'Starting periodic monitoring');

    this.checkInterval = setInterval(async () => {
      try {
        const results = await this.checkAllStrategies();
        logger.info({ strategiesChecked: results.length }, 'Periodic check completed');
      } catch (error) {
        logger.error({ error }, 'Periodic check failed');
      }
    }, intervalMinutes * 60 * 1000);

    // Also run immediately
    this.checkAllStrategies().catch(error => {
      logger.error({ error }, 'Initial check failed');
    });
  }

  /**
   * Stop periodic monitoring
   */
  stopPeriodicMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Stopped periodic monitoring');
    }
  }

  // ---------------------------------------------------------------------------
  // Data Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Get all monitored strategies
   */
  async getMonitoredStrategies(activeOnly: boolean = true): Promise<MonitoredStrategy[]> {
    const query = activeOnly
      ? `SELECT * FROM monitored_strategies WHERE is_active = true ORDER BY created_at DESC`
      : `SELECT * FROM monitored_strategies ORDER BY created_at DESC`;

    const result = await this.pool.query(query);

    return result.rows.map(row => ({
      id: row.id,
      strategyId: row.strategy_id,
      name: row.name,
      description: row.description,
      config: JSON.parse(row.config),
      baselineWinRate: parseFloat(row.baseline_win_rate),
      baselineRoi: parseFloat(row.baseline_roi),
      baselineEdgePoints: parseFloat(row.baseline_edge_points),
      baselineKelly: parseFloat(row.baseline_kelly),
      baselineSampleSize: row.baseline_sample_size,
      baselineDate: row.baseline_date,
      currentWinRate: row.current_win_rate ? parseFloat(row.current_win_rate) : null,
      currentRoi: row.current_roi ? parseFloat(row.current_roi) : null,
      currentEdgePoints: row.current_edge_points ? parseFloat(row.current_edge_points) : null,
      currentSampleSize: row.current_sample_size,
      recommendedKelly: row.recommended_kelly ? parseFloat(row.recommended_kelly) : null,
      isActive: row.is_active,
      isHealthy: row.is_healthy,
      lastCheckAt: row.last_check_at,
      checkIntervalMinutes: row.check_interval_minutes,
    }));
  }

  /**
   * Get recent alerts
   */
  async getRecentAlerts(
    limit: number = 50,
    severity?: 'info' | 'warning' | 'critical',
    unacknowledgedOnly: boolean = false
  ): Promise<DriftAlert[]> {
    let query = `
      SELECT *
      FROM drift_alerts
      WHERE 1=1
    `;
    const params: (string | number | boolean)[] = [];
    let paramIndex = 1;

    if (severity) {
      query += ` AND severity = $${paramIndex++}`;
      params.push(severity);
    }

    if (unacknowledgedOnly) {
      query += ` AND acknowledged = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(query, params);

    return result.rows.map(row => ({
      alertId: row.id,
      strategyId: row.strategy_id,
      alertType: row.alert_type,
      metric: row.metric,
      expectedValue: parseFloat(row.expected_value),
      observedValue: parseFloat(row.observed_value),
      deviationSigma: parseFloat(row.deviation_sigma),
      severity: row.severity,
      message: row.message,
      recommendation: row.recommendation,
      acknowledged: row.acknowledged,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      createdAt: row.created_at,
    }));
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: number, acknowledgedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE drift_alerts
       SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $1
       WHERE id = $2`,
      [acknowledgedBy, alertId]
    );
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Generate strategy ID from config
   */
  private generateStrategyId(config: Partial<AnalysisConfig>): string {
    const parts = [
      config.contrarianMode || 'default',
      `size${config.minSizeUsd || 1000}`,
      `win${config.windowMinutes || 60}`,
      config.minPrice !== undefined ? `minP${config.minPrice}` : '',
      config.maxPrice !== undefined ? `maxP${config.maxPrice}` : '',
      config.outcomeFilter || '',
    ].filter(Boolean);

    return parts.join('_');
  }

  /**
   * Calculate metrics from events
   */
  private calculateMetrics(events: ContrarianEvent[]): {
    n: number;
    winRate: number;
    roi: number;
    edgePoints: number;
    kellyFraction: number;
    totalPnL: number;
  } {
    if (events.length === 0) {
      return { n: 0, winRate: 0, roi: 0, edgePoints: 0, kellyFraction: 0, totalPnL: 0 };
    }

    const resolved = events.filter(e => e.outcomeWon !== null);
    if (resolved.length === 0) {
      return { n: 0, winRate: 0, roi: 0, edgePoints: 0, kellyFraction: 0, totalPnL: 0 };
    }

    const wins = resolved.filter(e => e.outcomeWon);
    const losses = resolved.filter(e => !e.outcomeWon);
    const n = resolved.length;
    const winRate = wins.length / n;

    const totalNotional = resolved.reduce((sum, e) => sum + e.tradeNotional, 0);
    const totalWinPnL = wins.reduce((sum, e) => sum + e.tradeNotional * (1 - e.tradePrice), 0);
    const totalLossPnL = losses.reduce((sum, e) => sum - e.tradeNotional * e.tradePrice, 0);
    const totalPnL = totalWinPnL + totalLossPnL;
    const roi = totalNotional > 0 ? totalPnL / totalNotional : 0;

    const avgPrice = resolved.reduce((sum, e) => sum + e.tradePrice, 0) / n;
    const edgePoints = (winRate - avgPrice) * 100;

    const p = winRate;
    const q = 1 - p;
    const b = avgPrice > 0 ? (1 - avgPrice) / avgPrice : 0;
    const kellyFraction = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

    return { n, winRate, roi, edgePoints, kellyFraction, totalPnL };
  }

  /**
   * Update strategy metrics in database
   */
  private async updateStrategyMetrics(strategyId: string, health: StrategyHealth): Promise<void> {
    await this.pool.query(
      `UPDATE monitored_strategies
       SET current_win_rate = $1,
           current_roi = $2,
           current_edge_points = $3,
           current_sample_size = $4,
           recommended_kelly = $5,
           is_healthy = $6,
           last_check_at = NOW(),
           updated_at = NOW()
       WHERE strategy_id = $7`,
      [
        health.currentMetrics.winRate,
        health.currentMetrics.roi,
        health.currentMetrics.edgePoints,
        health.currentMetrics.sampleSize,
        health.recommendedKellyAdjustment,
        health.isHealthy,
        strategyId,
      ]
    );
  }

  /**
   * Store alert in database
   */
  private async storeAlert(alert: DriftAlert): Promise<void> {
    await this.pool.query(
      `INSERT INTO drift_alerts
       (strategy_id, alert_type, metric, expected_value, observed_value, deviation_sigma, severity, message, recommendation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        alert.strategyId,
        alert.alertType,
        alert.metric,
        alert.expectedValue,
        alert.observedValue,
        alert.deviationSigma,
        alert.severity,
        alert.message,
        alert.recommendation,
      ]
    );
  }
}

// Export default config
export { DEFAULT_MONITORING_CONFIG };

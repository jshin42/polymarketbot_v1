import { Pool } from 'pg';
import { createLogger } from '@polymarketbot/shared';
import crypto from 'crypto';
import {
  type AnalysisConfig,
  type ContrarianMode,
  type ContrarianEvent,
  type PnLMetrics,
  type CorrelationSummary,
  AnalysisService,
} from './analysis.service.js';
import { benjaminiHochberg } from './statistics.service.js';

// =============================================================================
// GTO Optimization Service - Grid Search & Pareto Frontier Optimization
// =============================================================================

const logger = createLogger('optimization-service');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type OptimizationObjective =
  | 'pnl'
  | 'roi'
  | 'profitFactor'
  | 'edgePoints'
  | 'sharpeRatio'
  | 'kellyFraction'
  | 'informationRatio';

export interface PriceRange {
  min: number;
  max: number;
}

export interface TimeRange {
  min: number;
  max: number;
}

export interface GridSearchConfig {
  // Parameter ranges to search
  contrarianModes: ContrarianMode[];
  minSizeRanges: number[];
  windowMinutesRanges: number[];
  priceRanges: PriceRange[];
  timeRanges: TimeRange[];
  outcomeFilters: ('Yes' | 'No' | 'all')[];

  // Constraints
  minSampleSize: number;
  fdrAlpha: number;

  // Optimization objectives
  objectives: OptimizationObjective[];
}

export interface GridSearchResult {
  configId: string;
  config: Partial<AnalysisConfig>;
  metrics: {
    n: number;
    winRate: number;
    pnl: number;
    roi: number;
    profitFactor: number;
    edgePoints: number;
    sharpeRatio: number;
    kellyFraction: number;
    informationRatio: number;
    pValue: number;
    adjustedPValue: number;
    avgPrice: number;
    breakEvenRate: number;
    ci: [number, number];
  };
  rank: Record<OptimizationObjective, number>;
  isStatisticallySignificant: boolean;
  isParetoOptimal: boolean;
}

export interface ParetoFrontier {
  points: GridSearchResult[];
  dominatedCount: number;
  objectives: OptimizationObjective[];
}

export interface SensitivityAnalysis {
  parameterName: string;
  baselineValue: number | string;
  variations: Array<{
    value: number | string;
    metricDelta: Record<OptimizationObjective, number>;
    isSignificantChange: boolean;
  }>;
}

export interface OptimizationJob {
  id: number;
  jobType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: GridSearchConfig | null;
  totalConfigs: number;
  processedConfigs: number;
  validConfigs: number;
  startedAt: Date | null;
  completedAt: Date | null;
  executionTimeMs: number | null;
  errorMessage: string | null;
}

const DEFAULT_GRID_CONFIG: GridSearchConfig = {
  contrarianModes: ['vs_ofi', 'vs_trend', 'price_only', 'vs_both'],
  minSizeRanges: [500, 1000, 5000],
  windowMinutesRanges: [30, 60, 120],
  priceRanges: [
    { min: 0.10, max: 0.25 },
    { min: 0.25, max: 0.40 },
    { min: 0.40, max: 0.60 },
    { min: 0.60, max: 0.80 },
    { min: 0.80, max: 1.00 },
  ],
  timeRanges: [
    { min: 0, max: 15 },
    { min: 15, max: 30 },
    { min: 30, max: 60 },
    { min: 45, max: 60 },
  ],
  outcomeFilters: ['Yes', 'No', 'all'],
  minSampleSize: 30,
  fdrAlpha: 0.1,
  objectives: ['pnl', 'roi', 'profitFactor', 'edgePoints', 'sharpeRatio'],
};

// -----------------------------------------------------------------------------
// Optimization Service Class
// -----------------------------------------------------------------------------

export class OptimizationService {
  private pool: Pool;
  private analysisService: AnalysisService;
  private currentJob: OptimizationJob | null = null;
  private results: GridSearchResult[] = [];

  constructor(pool: Pool, analysisService: AnalysisService) {
    this.pool = pool;
    this.analysisService = analysisService;
  }

  // ---------------------------------------------------------------------------
  // Grid Search
  // ---------------------------------------------------------------------------

  /**
   * Generate all parameter combinations from config
   */
  private generateConfigurations(config: GridSearchConfig): Partial<AnalysisConfig>[] {
    const configs: Partial<AnalysisConfig>[] = [];

    for (const mode of config.contrarianModes) {
      for (const minSize of config.minSizeRanges) {
        for (const window of config.windowMinutesRanges) {
          for (const priceRange of config.priceRanges) {
            for (const timeRange of config.timeRanges) {
              for (const outcome of config.outcomeFilters) {
                configs.push({
                  contrarianMode: mode,
                  minSizeUsd: minSize,
                  windowMinutes: window,
                  minPrice: priceRange.min,
                  maxPrice: priceRange.max,
                  minMinutes: timeRange.min,
                  // maxMinutes would be windowMinutes
                  outcomeFilter: outcome,
                  lookbackDays: 30,
                  resolvedOnly: true,
                });
              }
            }
          }
        }
      }
    }

    return configs;
  }

  /**
   * Generate a unique config ID from config parameters
   */
  private generateConfigId(config: Partial<AnalysisConfig>): string {
    const hash = crypto.createHash('md5');
    hash.update(JSON.stringify(config));
    return hash.digest('hex').substring(0, 12);
  }

  /**
   * Calculate Sharpe ratio from P&L events
   */
  calculateSharpeRatio(events: ContrarianEvent[]): number {
    if (events.length < 2) return 0;

    // Calculate returns for each trade
    const returns = events.map(e => {
      if (e.outcomeWon === null) return 0;
      const returnVal = e.outcomeWon
        ? (1 - e.tradePrice) // Win: profit = 1 - price
        : -e.tradePrice;     // Loss: loss = -price
      return returnVal;
    });

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;

    // Annualized Sharpe (assuming daily trading, 252 trading days)
    return (mean / stdDev) * Math.sqrt(252);
  }

  /**
   * Calculate information ratio (edge consistency)
   */
  calculateInformationRatio(events: ContrarianEvent[]): number {
    if (events.length < 10) return 0;

    // Group by week and calculate weekly edge
    const weeklyEdges: number[] = [];
    const sortedEvents = [...events].sort(
      (a, b) => new Date(a.tradeTimestamp).getTime() - new Date(b.tradeTimestamp).getTime()
    );

    let weekStart = new Date(sortedEvents[0].tradeTimestamp);
    let weekEvents: ContrarianEvent[] = [];

    for (const event of sortedEvents) {
      const eventDate = new Date(event.tradeTimestamp);
      const daysDiff = (eventDate.getTime() - weekStart.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDiff >= 7) {
        if (weekEvents.length >= 3) {
          const weekWins = weekEvents.filter(e => e.outcomeWon).length;
          const weekWinRate = weekWins / weekEvents.length;
          const weekAvgPrice = weekEvents.reduce((s, e) => s + e.tradePrice, 0) / weekEvents.length;
          const edge = weekWinRate - weekAvgPrice;
          weeklyEdges.push(edge);
        }
        weekStart = eventDate;
        weekEvents = [];
      }
      weekEvents.push(event);
    }

    if (weeklyEdges.length < 2) return 0;

    const meanEdge = weeklyEdges.reduce((s, e) => s + e, 0) / weeklyEdges.length;
    const variance = weeklyEdges.reduce((s, e) => s + Math.pow(e - meanEdge, 2), 0) / (weeklyEdges.length - 1);
    const trackingError = Math.sqrt(variance);

    if (trackingError === 0) return meanEdge > 0 ? Infinity : 0;

    return meanEdge / trackingError;
  }

  /**
   * Run grid search optimization
   */
  async runGridSearch(
    config: GridSearchConfig = DEFAULT_GRID_CONFIG
  ): Promise<{
    results: GridSearchResult[];
    paretoFrontier: ParetoFrontier;
    executionTime: number;
    totalConfigurations: number;
    validConfigurations: number;
  }> {
    const startTime = Date.now();
    logger.info('Starting grid search optimization');

    // Generate all configurations
    const configurations = this.generateConfigurations(config);
    logger.info(`Generated ${configurations.length} configurations to test`);

    // Create job record
    const jobResult = await this.pool.query<{ id: number }>(
      `INSERT INTO optimization_jobs
       (job_type, status, config, total_configs, started_at)
       VALUES ('grid_search', 'running', $1, $2, NOW())
       RETURNING id`,
      [JSON.stringify(config), configurations.length]
    );
    const jobId = jobResult.rows[0].id;

    const results: GridSearchResult[] = [];
    const rawPValues: number[] = [];

    try {
      // Evaluate each configuration
      for (let i = 0; i < configurations.length; i++) {
        const cfg = configurations[i];
        const configId = this.generateConfigId(cfg);

        try {
          // Get events for this configuration
          const events = await this.analysisService.getContrarianEventsFromDB({
            ...cfg,
            lookbackDays: cfg.lookbackDays || 30,
            resolvedOnly: true,
          } as AnalysisConfig);

          // Filter by time range if specified
          let filteredEvents = events;
          if (cfg.minMinutes !== undefined) {
            filteredEvents = events.filter(e => e.minutesBeforeClose >= cfg.minMinutes!);
          }

          // Skip if below minimum sample size
          if (filteredEvents.length < config.minSampleSize) {
            continue;
          }

          // Calculate metrics
          const resolvedEvents = filteredEvents.filter(e => e.outcomeWon !== null);
          if (resolvedEvents.length < config.minSampleSize) continue;

          const wins = resolvedEvents.filter(e => e.outcomeWon);
          const losses = resolvedEvents.filter(e => !e.outcomeWon);
          const n = resolvedEvents.length;
          const winRate = wins.length / n;

          // P&L calculations
          const totalNotional = resolvedEvents.reduce((sum, e) => sum + e.tradeNotional, 0);
          const totalWinPnL = wins.reduce((sum, e) => sum + e.tradeNotional * (1 - e.tradePrice), 0);
          const totalLossPnL = losses.reduce((sum, e) => sum - e.tradeNotional * e.tradePrice, 0);
          const pnl = totalWinPnL + totalLossPnL;
          const roi = totalNotional > 0 ? pnl / totalNotional : 0;

          const avgPrice = resolvedEvents.reduce((sum, e) => sum + e.tradePrice, 0) / n;
          const breakEvenRate = avgPrice;
          const edgePoints = (winRate - breakEvenRate) * 100;

          const profitFactor = Math.abs(totalLossPnL) > 0
            ? totalWinPnL / Math.abs(totalLossPnL)
            : totalWinPnL > 0 ? Infinity : 0;

          // Kelly fraction
          const p = winRate;
          const q = 1 - p;
          const b = avgPrice > 0 ? (1 - avgPrice) / avgPrice : 0;
          const kellyFraction = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

          const sharpeRatio = this.calculateSharpeRatio(resolvedEvents);
          const informationRatio = this.calculateInformationRatio(resolvedEvents);

          // Calculate p-value using binomial test approximation
          const baselineRate = 0.05; // Approximate baseline win rate
          const z = (winRate - baselineRate) / Math.sqrt(baselineRate * (1 - baselineRate) / n);
          const pValue = 1 - this.normalCDF(z);
          rawPValues.push(pValue);

          // Bootstrap CI
          const ci = this.bootstrapWinRateCI(resolvedEvents, 0.95);

          results.push({
            configId,
            config: cfg,
            metrics: {
              n,
              winRate,
              pnl,
              roi,
              profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
              edgePoints,
              sharpeRatio: Number.isFinite(sharpeRatio) ? sharpeRatio : 0,
              kellyFraction,
              informationRatio: Number.isFinite(informationRatio) ? informationRatio : 0,
              pValue,
              adjustedPValue: pValue, // Will be updated after FDR
              avgPrice,
              breakEvenRate,
              ci,
            },
            rank: {} as Record<OptimizationObjective, number>,
            isStatisticallySignificant: false,
            isParetoOptimal: false,
          });

          // Update job progress
          if (i % 100 === 0) {
            await this.pool.query(
              `UPDATE optimization_jobs SET processed_configs = $1 WHERE id = $2`,
              [i + 1, jobId]
            );
          }
        } catch (err) {
          logger.warn(`Error evaluating config ${configId}: ${err}`);
        }
      }

      // Apply FDR correction
      if (rawPValues.length > 0) {
        const adjustedPValues = benjaminiHochberg(rawPValues, config.fdrAlpha);
        for (let i = 0; i < results.length; i++) {
          results[i].metrics.adjustedPValue = adjustedPValues[i];
          results[i].isStatisticallySignificant = adjustedPValues[i] < config.fdrAlpha;
        }
      }

      // Calculate ranks for each objective
      this.calculateRanks(results, config.objectives);

      // Identify Pareto optimal solutions
      const paretoFrontier = this.computeParetoFrontier(results, config.objectives);

      // Store results
      await this.storeResults(jobId, results);

      const executionTime = Date.now() - startTime;

      // Update job status
      await this.pool.query(
        `UPDATE optimization_jobs
         SET status = 'completed',
             processed_configs = $1,
             valid_configs = $2,
             completed_at = NOW(),
             execution_time_ms = $3
         WHERE id = $4`,
        [configurations.length, results.length, executionTime, jobId]
      );

      this.results = results;

      logger.info(`Grid search completed: ${results.length} valid configs from ${configurations.length} total`);

      return {
        results,
        paretoFrontier,
        executionTime,
        totalConfigurations: configurations.length,
        validConfigurations: results.length,
      };
    } catch (error) {
      await this.pool.query(
        `UPDATE optimization_jobs SET status = 'failed', error_message = $1 WHERE id = $2`,
        [String(error), jobId]
      );
      throw error;
    }
  }

  /**
   * Calculate ranks for each optimization objective
   */
  private calculateRanks(
    results: GridSearchResult[],
    objectives: OptimizationObjective[]
  ): void {
    for (const objective of objectives) {
      // Sort by objective (descending for all)
      const sorted = [...results].sort((a, b) => {
        const aVal = this.getObjectiveValue(a, objective);
        const bVal = this.getObjectiveValue(b, objective);
        return bVal - aVal; // Descending
      });

      // Assign ranks
      for (let i = 0; i < sorted.length; i++) {
        const result = results.find(r => r.configId === sorted[i].configId);
        if (result) {
          result.rank[objective] = i + 1;
        }
      }
    }
  }

  /**
   * Get the value of an objective from a result
   */
  private getObjectiveValue(result: GridSearchResult, objective: OptimizationObjective): number {
    switch (objective) {
      case 'pnl': return result.metrics.pnl;
      case 'roi': return result.metrics.roi;
      case 'profitFactor': return result.metrics.profitFactor;
      case 'edgePoints': return result.metrics.edgePoints;
      case 'sharpeRatio': return result.metrics.sharpeRatio;
      case 'kellyFraction': return result.metrics.kellyFraction;
      case 'informationRatio': return result.metrics.informationRatio;
      default: return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Pareto Frontier
  // ---------------------------------------------------------------------------

  /**
   * Compute Pareto frontier for multi-objective optimization
   */
  computeParetoFrontier(
    results: GridSearchResult[],
    objectives: OptimizationObjective[]
  ): ParetoFrontier {
    const paretoPoints: GridSearchResult[] = [];
    let dominatedCount = 0;

    for (const candidate of results) {
      let isDominated = false;

      for (const other of results) {
        if (candidate.configId === other.configId) continue;

        // Check if 'other' dominates 'candidate'
        let dominatesAll = true;
        let strictlyBetterInOne = false;

        for (const obj of objectives) {
          const candidateVal = this.getObjectiveValue(candidate, obj);
          const otherVal = this.getObjectiveValue(other, obj);

          if (otherVal < candidateVal) {
            dominatesAll = false;
            break;
          }
          if (otherVal > candidateVal) {
            strictlyBetterInOne = true;
          }
        }

        if (dominatesAll && strictlyBetterInOne) {
          isDominated = true;
          break;
        }
      }

      if (!isDominated) {
        candidate.isParetoOptimal = true;
        paretoPoints.push(candidate);
      } else {
        dominatedCount++;
      }
    }

    return {
      points: paretoPoints,
      dominatedCount,
      objectives,
    };
  }

  // ---------------------------------------------------------------------------
  // Sensitivity Analysis
  // ---------------------------------------------------------------------------

  /**
   * Run sensitivity analysis on a single parameter
   */
  async runSensitivityAnalysis(
    baseConfig: Partial<AnalysisConfig>,
    parameterName: keyof AnalysisConfig,
    variations: (number | string)[]
  ): Promise<SensitivityAnalysis> {
    const baselineValue = baseConfig[parameterName];
    const variationResults: SensitivityAnalysis['variations'] = [];

    // Get baseline metrics
    const baselineEvents = await this.analysisService.getContrarianEventsFromDB({
      lookbackDays: 30,
      resolvedOnly: true,
      ...baseConfig,
    } as AnalysisConfig);

    const baselineMetrics = this.calculateMetrics(baselineEvents);

    for (const value of variations) {
      const varConfig = { ...baseConfig, [parameterName]: value };
      const varEvents = await this.analysisService.getContrarianEventsFromDB({
        lookbackDays: 30,
        resolvedOnly: true,
        ...varConfig,
      } as AnalysisConfig);

      const varMetrics = this.calculateMetrics(varEvents);

      const metricDelta: Record<OptimizationObjective, number> = {
        pnl: varMetrics.pnl - baselineMetrics.pnl,
        roi: varMetrics.roi - baselineMetrics.roi,
        profitFactor: varMetrics.profitFactor - baselineMetrics.profitFactor,
        edgePoints: varMetrics.edgePoints - baselineMetrics.edgePoints,
        sharpeRatio: varMetrics.sharpeRatio - baselineMetrics.sharpeRatio,
        kellyFraction: varMetrics.kellyFraction - baselineMetrics.kellyFraction,
        informationRatio: varMetrics.informationRatio - baselineMetrics.informationRatio,
      };

      // Consider a change significant if ROI changes by more than 5 percentage points
      const isSignificantChange = Math.abs(metricDelta.roi) > 0.05;

      variationResults.push({
        value,
        metricDelta,
        isSignificantChange,
      });
    }

    return {
      parameterName: String(parameterName),
      baselineValue: String(baselineValue),
      variations: variationResults,
    };
  }

  /**
   * Calculate all metrics for a set of events
   */
  private calculateMetrics(events: ContrarianEvent[]): {
    pnl: number;
    roi: number;
    profitFactor: number;
    edgePoints: number;
    sharpeRatio: number;
    kellyFraction: number;
    informationRatio: number;
  } {
    const resolved = events.filter(e => e.outcomeWon !== null);
    if (resolved.length === 0) {
      return { pnl: 0, roi: 0, profitFactor: 0, edgePoints: 0, sharpeRatio: 0, kellyFraction: 0, informationRatio: 0 };
    }

    const wins = resolved.filter(e => e.outcomeWon);
    const losses = resolved.filter(e => !e.outcomeWon);
    const n = resolved.length;
    const winRate = wins.length / n;

    const totalNotional = resolved.reduce((sum, e) => sum + e.tradeNotional, 0);
    const totalWinPnL = wins.reduce((sum, e) => sum + e.tradeNotional * (1 - e.tradePrice), 0);
    const totalLossPnL = losses.reduce((sum, e) => sum - e.tradeNotional * e.tradePrice, 0);
    const pnl = totalWinPnL + totalLossPnL;
    const roi = totalNotional > 0 ? pnl / totalNotional : 0;

    const avgPrice = resolved.reduce((sum, e) => sum + e.tradePrice, 0) / n;
    const edgePoints = (winRate - avgPrice) * 100;

    const profitFactor = Math.abs(totalLossPnL) > 0
      ? totalWinPnL / Math.abs(totalLossPnL)
      : totalWinPnL > 0 ? 999 : 0;

    const p = winRate;
    const q = 1 - p;
    const b = avgPrice > 0 ? (1 - avgPrice) / avgPrice : 0;
    const kellyFraction = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

    const sharpeRatio = this.calculateSharpeRatio(resolved);
    const informationRatio = this.calculateInformationRatio(resolved);

    return {
      pnl,
      roi,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
      edgePoints,
      sharpeRatio: Number.isFinite(sharpeRatio) ? sharpeRatio : 0,
      kellyFraction,
      informationRatio: Number.isFinite(informationRatio) ? informationRatio : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Ranking & Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Load results from database if not in memory
   */
  private async loadResultsFromDB(): Promise<void> {
    if (this.results.length > 0) return;

    const result = await this.pool.query<{
      id: number;
      job_id: number;
      config_hash: string;
      config: Partial<AnalysisConfig>;
      sample_size: number;
      win_rate: string | null;
      total_pnl: string | null;
      roi: string | null;
      profit_factor: string | null;
      edge_points: string | null;
      sharpe_ratio: string | null;
      kelly_fraction: string | null;
      p_value: string | null;
      adjusted_p_value: string | null;
      ci_lower: string | null;
      ci_upper: string | null;
      rank_pnl: number | null;
      rank_roi: number | null;
      rank_profit_factor: number | null;
      rank_edge: number | null;
      rank_sharpe: number | null;
      is_significant: boolean;
      is_pareto_optimal: boolean;
    }>(`
      SELECT * FROM optimization_results
      ORDER BY rank_pnl ASC NULLS LAST
    `);

    this.results = result.rows.map(row => ({
      configId: row.config_hash,
      config: row.config,
      metrics: {
        n: row.sample_size,
        winRate: row.win_rate ? parseFloat(row.win_rate) : 0,
        pnl: row.total_pnl ? parseFloat(row.total_pnl) : 0,
        roi: row.roi ? parseFloat(row.roi) : 0,
        profitFactor: row.profit_factor ? parseFloat(row.profit_factor) : 0,
        edgePoints: row.edge_points ? parseFloat(row.edge_points) : 0,
        sharpeRatio: row.sharpe_ratio ? parseFloat(row.sharpe_ratio) : 0,
        kellyFraction: row.kelly_fraction ? parseFloat(row.kelly_fraction) : 0,
        informationRatio: 0,  // Not stored in DB yet
        pValue: row.p_value ? parseFloat(row.p_value) : 1,
        adjustedPValue: row.adjusted_p_value ? parseFloat(row.adjusted_p_value) : 1,
        avgPrice: 0,  // Not stored in DB yet
        breakEvenRate: 0,  // Not stored in DB yet
        ci: [
          row.ci_lower ? parseFloat(row.ci_lower) : 0,
          row.ci_upper ? parseFloat(row.ci_upper) : 0,
        ] as [number, number],
      },
      rank: {
        pnl: row.rank_pnl ?? 0,
        roi: row.rank_roi ?? 0,
        profitFactor: row.rank_profit_factor ?? 0,
        edgePoints: row.rank_edge ?? 0,
        sharpeRatio: row.rank_sharpe ?? 0,
        kellyFraction: 0,
        informationRatio: 0,
      },
      isStatisticallySignificant: row.is_significant,
      isParetoOptimal: row.is_pareto_optimal,
    }));

    logger.info({ count: this.results.length }, 'Loaded optimization results from database');
  }

  /**
   * Get ranked strategies from stored results
   */
  async getRankedStrategies(
    sortBy: OptimizationObjective = 'pnl',
    limit: number = 20,
    significantOnly: boolean = false
  ): Promise<GridSearchResult[]> {
    // Load from DB if not in memory
    await this.loadResultsFromDB();

    let filtered = [...this.results];

    if (significantOnly) {
      filtered = filtered.filter(r => r.isStatisticallySignificant);
    }

    // Sort by the specified objective
    filtered.sort((a, b) => {
      const aVal = this.getObjectiveValue(a, sortBy);
      const bVal = this.getObjectiveValue(b, sortBy);
      return bVal - aVal;
    });

    return filtered.slice(0, limit);
  }

  /**
   * Get Pareto frontier from stored results
   */
  async getParetoFrontier(
    objectives: OptimizationObjective[] = ['pnl', 'roi', 'profitFactor']
  ): Promise<ParetoFrontier> {
    // Load from DB if not in memory
    await this.loadResultsFromDB();

    return this.computeParetoFrontier(this.results, objectives);
  }

  /**
   * Get optimization job status
   */
  async getJobStatus(jobId?: number): Promise<OptimizationJob | null> {
    const query = jobId
      ? `SELECT * FROM optimization_jobs WHERE id = $1`
      : `SELECT * FROM optimization_jobs ORDER BY created_at DESC LIMIT 1`;

    const result = await this.pool.query<{
      id: number;
      job_type: string;
      status: string;
      config: GridSearchConfig | null;  // JSONB is already parsed by pg driver
      total_configs: number;
      processed_configs: number;
      valid_configs: number;
      started_at: Date | null;
      completed_at: Date | null;
      execution_time_ms: number | null;
      error_message: string | null;
    }>(query, jobId ? [jobId] : []);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      jobType: row.job_type,
      status: row.status as OptimizationJob['status'],
      config: row.config,  // JSONB is already an object, no need to parse
      totalConfigs: row.total_configs,
      processedConfigs: row.processed_configs,
      validConfigs: row.valid_configs,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      executionTimeMs: row.execution_time_ms,
      errorMessage: row.error_message,
    };
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /**
   * Store optimization results in database
   */
  private async storeResults(jobId: number, results: GridSearchResult[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const result of results) {
        await client.query(
          `INSERT INTO optimization_results
           (job_id, config_hash, config, sample_size, win_rate, total_pnl, roi,
            profit_factor, edge_points, sharpe_ratio, kelly_fraction,
            p_value, adjusted_p_value, ci_lower, ci_upper, is_significant,
            is_pareto_optimal, rank_pnl, rank_roi, rank_profit_factor, rank_edge, rank_sharpe)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
           ON CONFLICT (job_id, config_hash) DO UPDATE SET
             sample_size = EXCLUDED.sample_size,
             win_rate = EXCLUDED.win_rate,
             total_pnl = EXCLUDED.total_pnl`,
          [
            jobId,
            result.configId,
            JSON.stringify(result.config),
            result.metrics.n,
            result.metrics.winRate,
            result.metrics.pnl,
            result.metrics.roi,
            result.metrics.profitFactor,
            result.metrics.edgePoints,
            result.metrics.sharpeRatio,
            result.metrics.kellyFraction,
            result.metrics.pValue,
            result.metrics.adjustedPValue,
            result.metrics.ci[0],
            result.metrics.ci[1],
            result.isStatisticallySignificant,
            result.isParetoOptimal,
            result.rank.pnl || null,
            result.rank.roi || null,
            result.rank.profitFactor || null,
            result.rank.edgePoints || null,
            result.rank.sharpeRatio || null,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------------------

  /**
   * Standard normal CDF approximation
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Bootstrap confidence interval for win rate
   */
  private bootstrapWinRateCI(
    events: ContrarianEvent[],
    confidenceLevel: number = 0.95,
    nBootstrap: number = 1000
  ): [number, number] {
    const n = events.length;
    if (n === 0) return [0, 0];

    const winRates: number[] = [];

    for (let i = 0; i < nBootstrap; i++) {
      // Sample with replacement
      let wins = 0;
      for (let j = 0; j < n; j++) {
        const idx = Math.floor(Math.random() * n);
        if (events[idx].outcomeWon) wins++;
      }
      winRates.push(wins / n);
    }

    winRates.sort((a, b) => a - b);

    const alpha = 1 - confidenceLevel;
    const lowerIdx = Math.floor((alpha / 2) * nBootstrap);
    const upperIdx = Math.floor((1 - alpha / 2) * nBootstrap);

    return [winRates[lowerIdx], winRates[upperIdx]];
  }
}

// Export default config for external use
export { DEFAULT_GRID_CONFIG };

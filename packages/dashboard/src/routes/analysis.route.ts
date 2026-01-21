import type { FastifyInstance } from 'fastify';
import { createLogger } from '@polymarketbot/shared';
import { AnalysisService, type ContrarianMode } from '../services/analysis.service.js';
import { BackfillService } from '../services/backfill.service.js';
import {
  OptimizationService,
  type GridSearchConfig,
  type OptimizationObjective,
  DEFAULT_GRID_CONFIG,
} from '../services/optimization.service.js';
import { Pool } from 'pg';

// =============================================================================
// Analysis Routes - 30D Contrarian Research Analysis
// =============================================================================

const logger = createLogger('analysis-route');

export function registerAnalysisRoutes(
  app: FastifyInstance,
  analysisService: AnalysisService,
  pgPool?: Pool
): void {
  // Create backfill service if we have a pool
  const backfillService = pgPool ? new BackfillService(pgPool) : null;

  // Create optimization service if we have a pool
  const optimizationService = pgPool ? new OptimizationService(pgPool, analysisService) : null;

  /**
   * POST /api/analysis/backfill
   * Trigger a 30-day backfill of resolved markets and trades
   */
  app.post<{
    Body: {
      days?: number;
      windowMinutes?: number;
    };
  }>('/api/analysis/backfill', async (request, reply) => {
    if (!backfillService) {
      return reply.status(503).send({
        error: 'Backfill service unavailable - database not configured'
      });
    }

    try {
      const days = request.body?.days ?? 30;
      const windowMinutes = request.body?.windowMinutes ?? 120;

      // Start backfill in background
      logger.info({ days, windowMinutes }, 'Starting backfill');

      // Don't await - run in background
      backfillService.runFullBackfill({
        days,
        windowMinutes,
        minSizeUsd: 100, // Lower threshold to capture more data
      }).catch(error => {
        logger.error({ error }, 'Backfill failed');
      });

      return reply.status(202).send({
        message: 'Backfill started',
        config: { days, windowMinutes },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start backfill');
      return reply.status(500).send({ error: 'Failed to start backfill' });
    }
  });

  /**
   * GET /api/analysis/backfill/status
   * Get the status of the current or last backfill job
   */
  app.get('/api/analysis/backfill/status', async (request, reply) => {
    try {
      const status = await analysisService.getBackfillStatus();
      return reply.send(status);
    } catch (error) {
      logger.error({ error }, 'Failed to get backfill status');
      return reply.status(500).send({ error: 'Failed to get backfill status' });
    }
  });

  /**
   * GET /api/analysis/summary
   * Get correlation summary statistics for contrarian betting
   * Query params:
   *   - days: lookback period in days (default 30)
   *   - minSize: minimum trade size in USD (default 1000)
   *   - windowMinutes: minutes before close (default 60)
   *   - contrarianMode: 'price_only' | 'vs_trend' | 'vs_ofi' | 'vs_both' (default 'vs_ofi')
   *   - requireAsymmetry: require asymmetric book (default false)
   *   - requireNewWallet: require new wallet (default false)
   *   - maxWalletAgeDays: max wallet age in days (default 7)
   *   - maxSpreadBps: max spread in bps (default 500)
   *   - categories: comma-separated list of categories
   *   - ofiTrendDisagree: filter for OFI vs Trend disagreement (Erdős discovery)
   *   - outcomeFilter: 'Yes' | 'No' | 'all' - filter by traded outcome
   *   - minPrice: minimum trade price (e.g., 0.90 for 90c+)
   *   - maxPrice: maximum trade price (e.g., 0.40 for longshots)
   *   - minZScore: minimum size z-score
   *   - maxZScore: maximum size z-score (sweet spot is 200-500)
   *   - minMinutes: minimum minutes before close (exclude last N min)
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
      maxWalletAgeDays?: string;
      maxSpreadBps?: string;
      minDepthUsd?: string;
      categories?: string;
      // Erdős-inspired filters
      ofiTrendDisagree?: string;
      outcomeFilter?: string;
      minPrice?: string;
      maxPrice?: string;
      minZScore?: string;
      maxZScore?: string;
      minMinutes?: string;
    };
  }>('/api/analysis/summary', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const summary = await analysisService.getCorrelationSummary(config);
      return reply.send(summary);
    } catch (error) {
      logger.error({ error }, 'Failed to get analysis summary');
      return reply.status(500).send({ error: 'Failed to get analysis summary' });
    }
  });

  /**
   * GET /api/analysis/signals
   * Get recent contrarian signals with results
   * Query params: same as /summary plus limit
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
      limit?: string;
    };
  }>('/api/analysis/signals', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const limit = parseInt(request.query.limit ?? '20', 10);

      const signals = await analysisService.getContrarianSignals(config, limit);

      return reply.send({
        count: signals.length,
        signals,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get contrarian signals');
      return reply.status(500).send({ error: 'Failed to get contrarian signals' });
    }
  });

  /**
   * GET /api/analysis/rolling
   * Get rolling correlation data for charting
   * Query params: same as /summary plus rollingWindow
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
      rollingWindow?: string;
    };
  }>('/api/analysis/rolling', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const rollingWindow = parseInt(request.query.rollingWindow ?? '7', 10);

      const dataPoints = await analysisService.getRollingCorrelation(config, rollingWindow);

      return reply.send({
        count: dataPoints.length,
        rollingWindowDays: rollingWindow,
        dataPoints,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get rolling correlation');
      return reply.status(500).send({ error: 'Failed to get rolling correlation' });
    }
  });

  /**
   * GET /api/analysis/events
   * Get contrarian events with pagination
   * Query params: same as /summary plus limit and offset
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
      maxWalletAgeDays?: string;
      maxSpreadBps?: string;
      categories?: string;
      limit?: string;
      offset?: string;
      // Erdős-inspired filters
      ofiTrendDisagree?: string;
      outcomeFilter?: string;
      minPrice?: string;
      maxPrice?: string;
      minZScore?: string;
      maxZScore?: string;
      minMinutes?: string;
    };
  }>('/api/analysis/events', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 100);
      const offset = parseInt(request.query.offset ?? '0', 10);

      const { events, total } = await analysisService.getContrarianEvents(config, limit, offset);

      return reply.send({
        events,
        total,
        limit,
        offset,
        hasMore: offset + events.length < total,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get contrarian events');
      return reply.status(500).send({ error: 'Failed to get contrarian events' });
    }
  });

  /**
   * GET /api/analysis/breakdown/:factor
   * Get breakdown by a specific factor
   * Params: factor = 'liquidity' | 'time_to_close' | 'category' | 'new_wallet'
   */
  app.get<{
    Params: { factor: string };
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
    };
  }>('/api/analysis/breakdown/:factor', async (request, reply) => {
    try {
      const factor = request.params.factor as 'liquidity' | 'time_to_close' | 'category' | 'new_wallet';

      if (!['liquidity', 'time_to_close', 'category', 'new_wallet'].includes(factor)) {
        return reply.status(400).send({
          error: 'Invalid factor. Must be one of: liquidity, time_to_close, category, new_wallet'
        });
      }

      const config = parseAnalysisConfig(request.query);
      const breakdown = await analysisService.getBreakdown(factor, config);

      return reply.send({
        factor,
        breakdown,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get breakdown');
      return reply.status(500).send({ error: 'Failed to get breakdown' });
    }
  });

  /**
   * GET /api/analysis/model
   * Get logistic regression model report
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      contrarianMode?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
    };
  }>('/api/analysis/model', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const report = await analysisService.getModelReport(config);

      if (!report) {
        return reply.send({
          error: 'Insufficient data for model training (need at least 50 events)',
          report: null,
        });
      }

      return reply.send({ report });
    } catch (error) {
      logger.error({ error }, 'Failed to get model report');
      return reply.status(500).send({ error: 'Failed to get model report' });
    }
  });

  /**
   * GET /api/analysis/compare
   * Compare all contrarian modes with FDR-corrected p-values
   * Query params: same as /summary plus fdr
   */
  app.get<{
    Querystring: {
      days?: string;
      minSize?: string;
      windowMinutes?: string;
      requireAsymmetry?: string;
      requireNewWallet?: string;
      fdr?: string;
    };
  }>('/api/analysis/compare', async (request, reply) => {
    try {
      const config = parseAnalysisConfig(request.query);
      const fdr = parseFloat(request.query.fdr ?? '0.1');

      const comparisons = await analysisService.compareContrarianModes(config, fdr);

      return reply.send({
        fdr,
        comparisons,
        bestMode: comparisons.length > 0 ? comparisons[0].summary.contrarianMode : null,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to compare contrarian modes');
      return reply.status(500).send({ error: 'Failed to compare contrarian modes' });
    }
  });

  /**
   * GET /api/analysis/categories
   * Get list of available categories
   */
  app.get('/api/analysis/categories', async (request, reply) => {
    try {
      // Return hardcoded list of known Polymarket categories
      const categories = [
        'Politics',
        'Sports',
        'Crypto',
        'Science',
        'Entertainment',
        'Business',
        'Finance',
        'Technology',
        'World',
        'Culture',
      ];

      return reply.send({ categories });
    } catch (error) {
      logger.error({ error }, 'Failed to get categories');
      return reply.status(500).send({ error: 'Failed to get categories' });
    }
  });

  // =============================================================================
  // GTO Optimization Endpoints
  // =============================================================================

  /**
   * POST /api/analysis/optimize
   * Run grid search optimization with specified parameters
   * Body: GridSearchConfig (optional - uses defaults if not provided)
   */
  app.post<{
    Body: Partial<GridSearchConfig>;
  }>('/api/analysis/optimize', async (request, reply) => {
    if (!optimizationService) {
      return reply.status(503).send({
        error: 'Optimization service unavailable - database not configured'
      });
    }

    try {
      const config: GridSearchConfig = {
        ...DEFAULT_GRID_CONFIG,
        ...request.body,
      };

      logger.info({ config }, 'Starting grid search optimization');

      // Run grid search (this can take a while, so we return immediately)
      const promise = optimizationService.runGridSearch(config);

      // Don't await - run in background
      promise.catch(error => {
        logger.error({ error }, 'Grid search optimization failed');
      });

      return reply.status(202).send({
        message: 'Optimization started',
        config,
        totalConfigurations: config.contrarianModes.length *
          config.minSizeRanges.length *
          config.windowMinutesRanges.length *
          config.priceRanges.length *
          config.timeRanges.length *
          config.outcomeFilters.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start optimization');
      return reply.status(500).send({ error: 'Failed to start optimization' });
    }
  });

  /**
   * GET /api/analysis/optimize/status
   * Get the status of the current or last optimization job
   * Query params:
   *   - jobId: specific job ID (optional, returns latest if not provided)
   */
  app.get<{
    Querystring: {
      jobId?: string;
    };
  }>('/api/analysis/optimize/status', async (request, reply) => {
    if (!optimizationService) {
      return reply.status(503).send({
        error: 'Optimization service unavailable - database not configured'
      });
    }

    try {
      const jobId = request.query.jobId ? parseInt(request.query.jobId, 10) : undefined;
      const status = await optimizationService.getJobStatus(jobId);

      if (!status) {
        return reply.status(404).send({ error: 'No optimization jobs found' });
      }

      return reply.send(status);
    } catch (error) {
      logger.error({ error }, 'Failed to get optimization status');
      return reply.status(500).send({ error: 'Failed to get optimization status' });
    }
  });

  /**
   * GET /api/analysis/pareto
   * Get Pareto frontier points from the most recent optimization
   * Query params:
   *   - objectives: comma-separated list of objectives (default: pnl,roi,profitFactor)
   */
  app.get<{
    Querystring: {
      objectives?: string;
    };
  }>('/api/analysis/pareto', async (request, reply) => {
    if (!optimizationService) {
      return reply.status(503).send({
        error: 'Optimization service unavailable - database not configured'
      });
    }

    try {
      const objectivesStr = request.query.objectives ?? 'pnl,roi,profitFactor';
      const objectives = objectivesStr.split(',').filter(Boolean) as OptimizationObjective[];

      const validObjectives: OptimizationObjective[] = [
        'pnl', 'roi', 'profitFactor', 'edgePoints', 'sharpeRatio', 'kellyFraction', 'informationRatio'
      ];

      const filteredObjectives = objectives.filter(o => validObjectives.includes(o));

      if (filteredObjectives.length === 0) {
        return reply.status(400).send({
          error: 'Invalid objectives. Valid values: ' + validObjectives.join(', ')
        });
      }

      const frontier = await optimizationService.getParetoFrontier(filteredObjectives);

      return reply.send({
        ...frontier,
        count: frontier.points.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get Pareto frontier');
      return reply.status(500).send({ error: 'Failed to get Pareto frontier' });
    }
  });

  /**
   * POST /api/analysis/sensitivity
   * Run sensitivity analysis on a single parameter
   * Body:
   *   - baseConfig: partial AnalysisConfig
   *   - parameter: parameter name to vary
   *   - values: array of values to test
   */
  app.post<{
    Body: {
      baseConfig: Partial<{
        contrarianMode: ContrarianMode;
        minSizeUsd: number;
        windowMinutes: number;
        minPrice: number;
        maxPrice: number;
      }>;
      parameter: string;
      values: (number | string)[];
    };
  }>('/api/analysis/sensitivity', async (request, reply) => {
    if (!optimizationService) {
      return reply.status(503).send({
        error: 'Optimization service unavailable - database not configured'
      });
    }

    try {
      const { baseConfig, parameter, values } = request.body;

      if (!parameter || !values || values.length === 0) {
        return reply.status(400).send({
          error: 'Missing required fields: parameter, values'
        });
      }

      const validParams = [
        'contrarianMode', 'minSizeUsd', 'windowMinutes', 'minPrice', 'maxPrice',
        'minMinutes', 'minZScore', 'maxZScore', 'outcomeFilter'
      ];

      if (!validParams.includes(parameter)) {
        return reply.status(400).send({
          error: `Invalid parameter. Valid values: ${validParams.join(', ')}`
        });
      }

      const result = await optimizationService.runSensitivityAnalysis(
        baseConfig as Partial<import('../services/analysis.service.js').AnalysisConfig>,
        parameter as keyof import('../services/analysis.service.js').AnalysisConfig,
        values
      );

      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to run sensitivity analysis');
      return reply.status(500).send({ error: 'Failed to run sensitivity analysis' });
    }
  });

  /**
   * GET /api/analysis/strategies
   * Get ranked strategies from optimization results
   * Query params:
   *   - sortBy: objective to sort by (default: pnl)
   *   - limit: max results (default: 20)
   *   - significantOnly: only return statistically significant results (default: false)
   */
  app.get<{
    Querystring: {
      sortBy?: string;
      limit?: string;
      significantOnly?: string;
    };
  }>('/api/analysis/strategies', async (request, reply) => {
    if (!optimizationService) {
      return reply.status(503).send({
        error: 'Optimization service unavailable - database not configured'
      });
    }

    try {
      const sortBy = (request.query.sortBy ?? 'pnl') as OptimizationObjective;
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
      const significantOnly = request.query.significantOnly === 'true';

      const validObjectives: OptimizationObjective[] = [
        'pnl', 'roi', 'profitFactor', 'edgePoints', 'sharpeRatio', 'kellyFraction', 'informationRatio'
      ];

      if (!validObjectives.includes(sortBy)) {
        return reply.status(400).send({
          error: 'Invalid sortBy. Valid values: ' + validObjectives.join(', ')
        });
      }

      const strategies = await optimizationService.getRankedStrategies(sortBy, limit, significantOnly);

      return reply.send({
        count: strategies.length,
        sortBy,
        significantOnly,
        strategies,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get ranked strategies');
      return reply.status(500).send({ error: 'Failed to get ranked strategies' });
    }
  });

  /**
   * GET /api/analysis/monitor/:id/health
   * Get health status for a monitored strategy
   * Note: This is a placeholder - will be fully implemented with MonitoringService
   */
  app.get<{
    Params: { id: string };
  }>('/api/analysis/monitor/:id/health', async (request, reply) => {
    // TODO: Implement with MonitoringService
    const strategyId = request.params.id;

    return reply.send({
      strategyId,
      isHealthy: true,
      message: 'Monitoring service not yet implemented',
      placeholder: true,
    });
  });

  /**
   * GET /api/analysis/alerts
   * Get recent drift alerts
   * Query params:
   *   - severity: filter by severity (info, warning, critical)
   *   - unacknowledgedOnly: only return unacknowledged alerts (default: false)
   *   - limit: max results (default: 50)
   */
  app.get<{
    Querystring: {
      severity?: string;
      unacknowledgedOnly?: string;
      limit?: string;
    };
  }>('/api/analysis/alerts', async (request, reply) => {
    if (!pgPool) {
      return reply.status(503).send({
        error: 'Database not configured'
      });
    }

    try {
      const severity = request.query.severity;
      const unacknowledgedOnly = request.query.unacknowledgedOnly === 'true';
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);

      // Build query
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

      const result = await pgPool.query(query, params);

      return reply.send({
        count: result.rows.length,
        alerts: result.rows.map(row => ({
          id: row.id,
          strategyId: row.strategy_id,
          alertType: row.alert_type,
          metric: row.metric,
          expectedValue: row.expected_value,
          observedValue: row.observed_value,
          deviationSigma: row.deviation_sigma,
          severity: row.severity,
          message: row.message,
          recommendation: row.recommendation,
          acknowledged: row.acknowledged,
          acknowledgedAt: row.acknowledged_at,
          acknowledgedBy: row.acknowledged_by,
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get alerts');
      return reply.status(500).send({ error: 'Failed to get alerts' });
    }
  });

  /**
   * POST /api/analysis/quant
   * Run quantitative analysis pipeline
   * Note: This is a placeholder - will be fully implemented with QuantAnalysisService
   */
  app.post<{
    Body: {
      reportType?: 'full' | 'incremental' | 'strategy';
      strategyId?: string;
    };
  }>('/api/analysis/quant', async (request, reply) => {
    // TODO: Implement with QuantAnalysisService
    const reportType = request.body?.reportType ?? 'full';

    return reply.status(202).send({
      message: 'Quant analysis started',
      reportType,
      placeholder: true,
      note: 'QuantAnalysisService not yet implemented - will include VPIN, Hawkes, Benford analysis',
    });
  });
}

// Helper function to parse query params into config
function parseAnalysisConfig(query: {
  days?: string;
  minSize?: string;
  windowMinutes?: string;
  contrarianMode?: string;
  requireAsymmetry?: string;
  requireNewWallet?: string;
  maxWalletAgeDays?: string;
  maxSpreadBps?: string;
  minDepthUsd?: string;
  categories?: string;
  // Erdős-inspired filters (81.82% win rate discovery)
  ofiTrendDisagree?: string;
  outcomeFilter?: string;
  minPrice?: string;
  maxPrice?: string;
  minZScore?: string;
  maxZScore?: string;
  minMinutes?: string;
}): {
  lookbackDays: number;
  minSizeUsd: number;
  windowMinutes: number;
  contrarianMode: ContrarianMode;
  requireAsymmetricBook: boolean;
  requireNewWallet: boolean;
  maxWalletAgeDays: number;
  maxSpreadBps: number;
  minDepthUsd: number;
  categories: string[];
  resolvedOnly: boolean;
  // Erdős-inspired filters
  ofiTrendDisagree?: boolean;
  outcomeFilter?: 'Yes' | 'No' | 'all';
  minPrice?: number;
  maxPrice?: number;
  minZScore?: number;
  maxZScore?: number;
  minMinutes?: number;
} {
  const contrarianMode = query.contrarianMode as ContrarianMode;
  const validModes: ContrarianMode[] = ['price_only', 'vs_trend', 'vs_ofi', 'vs_both'];

  // Parse outcome filter
  const outcomeFilter = query.outcomeFilter as 'Yes' | 'No' | 'all' | undefined;
  const validOutcomes = ['Yes', 'No', 'all'];

  return {
    lookbackDays: parseInt(query.days ?? '30', 10),
    minSizeUsd: parseInt(query.minSize ?? '1000', 10),
    windowMinutes: parseInt(query.windowMinutes ?? '60', 10),
    contrarianMode: validModes.includes(contrarianMode) ? contrarianMode : 'vs_ofi',
    requireAsymmetricBook: query.requireAsymmetry === 'true',
    requireNewWallet: query.requireNewWallet === 'true',
    maxWalletAgeDays: parseInt(query.maxWalletAgeDays ?? '7', 10),
    maxSpreadBps: parseInt(query.maxSpreadBps ?? '500', 10),
    minDepthUsd: parseInt(query.minDepthUsd ?? '100', 10),
    categories: query.categories ? query.categories.split(',').filter(Boolean) : [],
    resolvedOnly: true,
    // Erdős-inspired filters (81.82% win rate discovery)
    ofiTrendDisagree: query.ofiTrendDisagree === 'true',
    outcomeFilter: validOutcomes.includes(outcomeFilter ?? '') ? outcomeFilter : undefined,
    minPrice: query.minPrice ? parseFloat(query.minPrice) : undefined,
    maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
    minZScore: query.minZScore ? parseFloat(query.minZScore) : undefined,
    maxZScore: query.maxZScore ? parseFloat(query.maxZScore) : undefined,
    minMinutes: query.minMinutes ? parseInt(query.minMinutes, 10) : undefined,
  };
}

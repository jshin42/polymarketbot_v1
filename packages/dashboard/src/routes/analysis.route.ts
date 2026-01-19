import type { FastifyInstance } from 'fastify';
import { createLogger } from '@polymarketbot/shared';
import { AnalysisService, type ContrarianMode } from '../services/analysis.service.js';
import { BackfillService } from '../services/backfill.service.js';
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
   *   - contrarianMode: 'price_only' | 'vs_trend' | 'vs_ofi' | 'vs_both' (default 'vs_both')
   *   - requireAsymmetry: require asymmetric book (default false)
   *   - requireNewWallet: require new wallet (default false)
   *   - maxWalletAgeDays: max wallet age in days (default 7)
   *   - maxSpreadBps: max spread in bps (default 500)
   *   - categories: comma-separated list of categories
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
} {
  const contrarianMode = query.contrarianMode as ContrarianMode;
  const validModes: ContrarianMode[] = ['price_only', 'vs_trend', 'vs_ofi', 'vs_both'];

  return {
    lookbackDays: parseInt(query.days ?? '30', 10),
    minSizeUsd: parseInt(query.minSize ?? '1000', 10),
    windowMinutes: parseInt(query.windowMinutes ?? '60', 10),
    contrarianMode: validModes.includes(contrarianMode) ? contrarianMode : 'vs_both',
    requireAsymmetricBook: query.requireAsymmetry === 'true',
    requireNewWallet: query.requireNewWallet === 'true',
    maxWalletAgeDays: parseInt(query.maxWalletAgeDays ?? '7', 10),
    maxSpreadBps: parseInt(query.maxSpreadBps ?? '500', 10),
    minDepthUsd: parseInt(query.minDepthUsd ?? '100', 10),
    categories: query.categories ? query.categories.split(',').filter(Boolean) : [],
    resolvedOnly: true,
  };
}

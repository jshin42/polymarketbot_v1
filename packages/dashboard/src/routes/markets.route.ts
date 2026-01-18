import type { FastifyInstance } from 'fastify';
import { AggregationService } from '../services/aggregation.service.js';
import { createLogger } from '@polymarketbot/shared';

// =============================================================================
// Markets Route
// =============================================================================

const logger = createLogger('markets-route');

export function registerMarketsRoutes(
  app: FastifyInstance,
  aggregationService: AggregationService
): void {
  /**
   * GET /api/markets
   * List all tracked markets with their current status.
   */
  app.get('/api/markets', async (request, reply) => {
    try {
      const markets = await aggregationService.getTrackedMarkets();
      return reply.send({
        count: markets.length,
        markets,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get markets');
      return reply.status(500).send({ error: 'Failed to get markets' });
    }
  });

  /**
   * GET /api/markets/closing-soon
   * List markets closing within the next N minutes.
   * Query params:
   *   - minutes: max minutes until close (default 1440 = 24h)
   *   - excludeSports: whether to exclude sports/esports (default true)
   *   - limit: max results (default 20)
   */
  app.get<{ Querystring: { minutes?: string; excludeSports?: string; limit?: string } }>(
    '/api/markets/closing-soon',
    async (request, reply) => {
      try {
        const minutes = parseInt(request.query.minutes ?? '10080', 10); // Default 7 days (was 24h)
        const excludeSports = request.query.excludeSports !== 'false';
        const limit = parseInt(request.query.limit ?? '20', 10);

        let markets;
        if (excludeSports) {
          // Use filtered method that excludes sports/esports
          markets = await aggregationService.getMarketsClosingSoon({
            maxMinutes: minutes,
            limit,
          });
        } else {
          // Return all markets closing soon
          const allMarkets = await aggregationService.getTrackedMarkets();
          markets = allMarkets
            .filter((m) => m.timeToCloseMinutes <= minutes && m.timeToCloseMinutes > 0)
            .slice(0, limit);
        }

        return reply.send({
          count: markets.length,
          threshold_minutes: minutes,
          excludeSports,
          markets,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get closing-soon markets');
        return reply.status(500).send({ error: 'Failed to get closing-soon markets' });
      }
    }
  );

  /**
   * GET /api/markets/high-signal
   * List markets with anomaly score above threshold.
   */
  app.get<{ Querystring: { threshold?: string } }>(
    '/api/markets/high-signal',
    async (request, reply) => {
      try {
        const threshold = parseFloat(request.query.threshold ?? '0.65');
        const allMarkets = await aggregationService.getTrackedMarkets();
        const highSignal = allMarkets.filter(
          (m) => m.latestAnomalyScore !== null && m.latestAnomalyScore >= threshold
        );

        // Sort by anomaly score descending
        highSignal.sort((a, b) => (b.latestAnomalyScore ?? 0) - (a.latestAnomalyScore ?? 0));

        return reply.send({
          count: highSignal.length,
          threshold,
          markets: highSignal,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get high-signal markets');
        return reply.status(500).send({ error: 'Failed to get high-signal markets' });
      }
    }
  );
}

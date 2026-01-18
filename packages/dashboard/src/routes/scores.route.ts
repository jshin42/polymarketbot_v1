import type { FastifyInstance } from 'fastify';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { AggregationService } from '../services/aggregation.service.js';

// =============================================================================
// Scores Route
// =============================================================================

const logger = createLogger('scores-route');

export function registerScoresRoutes(
  app: FastifyInstance,
  redis: Redis,
  aggregationService: AggregationService
): void {
  /**
   * GET /api/scores
   * List latest scores for all tracked markets.
   */
  app.get('/api/scores', async (request, reply) => {
    try {
      const scores = await aggregationService.getLatestScores();
      return reply.send({
        count: scores.length,
        scores,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get scores');
      return reply.status(500).send({ error: 'Failed to get scores' });
    }
  });

  /**
   * GET /api/scores/:tokenId
   * Get latest score for a specific token.
   */
  app.get<{ Params: { tokenId: string } }>('/api/scores/:tokenId', async (request, reply) => {
    try {
      const { tokenId } = request.params;
      const scoreJson = await redis.get(RedisKeys.scoreCache(tokenId));

      if (!scoreJson) {
        return reply.status(404).send({ error: 'Score not found' });
      }

      const score = JSON.parse(scoreJson);
      return reply.send({
        tokenId,
        ...score,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get score');
      return reply.status(500).send({ error: 'Failed to get score' });
    }
  });

  /**
   * GET /api/scores/:tokenId/features
   * Get latest feature vector for a specific token.
   */
  app.get<{ Params: { tokenId: string } }>(
    '/api/scores/:tokenId/features',
    async (request, reply) => {
      try {
        const { tokenId } = request.params;
        const features = await redis.hgetall(RedisKeys.featureCache(tokenId));

        if (!features || Object.keys(features).length === 0) {
          return reply.status(404).send({ error: 'Features not found' });
        }

        // Parse numeric values
        const parsedFeatures: Record<string, number | string | boolean> = {};
        for (const [key, value] of Object.entries(features)) {
          const numValue = parseFloat(value);
          parsedFeatures[key] = isNaN(numValue) ? value : numValue;
        }

        return reply.send({
          tokenId,
          features: parsedFeatures,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get features');
        return reply.status(500).send({ error: 'Failed to get features' });
      }
    }
  );

  /**
   * GET /api/scores/top
   * Get top N scores by composite score.
   */
  app.get<{ Querystring: { limit?: string } }>('/api/scores/top', async (request, reply) => {
    try {
      const limit = parseInt(request.query.limit ?? '10', 10);
      const scores = await aggregationService.getLatestScores();
      const topScores = scores.slice(0, limit);

      return reply.send({
        count: topScores.length,
        scores: topScores,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get top scores');
      return reply.status(500).send({ error: 'Failed to get top scores' });
    }
  });

  /**
   * GET /api/opportunities
   * Get enriched opportunities with market data, close times, and Polymarket links.
   * Query params:
   *   - limit: max number of results (default 20)
   *   - maxDays: filter to markets closing within N days
   *   - sortBy: 'score' (default) or 'closeTime'
   */
  app.get<{ Querystring: { limit?: string; maxDays?: string; sortBy?: string } }>(
    '/api/opportunities',
    async (request, reply) => {
      try {
        const limit = parseInt(request.query.limit ?? '20', 10);
        const maxDays = request.query.maxDays ? parseFloat(request.query.maxDays) : null;
        const sortBy = request.query.sortBy ?? 'score';

        let opportunities = await aggregationService.getEnrichedOpportunities();

        // Filter by days if specified
        if (maxDays !== null) {
          opportunities = opportunities.filter(o => o.daysUntilClose <= maxDays);
        }

        // Sort by closeTime if requested (soonest first)
        if (sortBy === 'closeTime') {
          opportunities.sort((a, b) => a.daysUntilClose - b.daysUntilClose);
        }

        // Apply limit
        opportunities = opportunities.slice(0, limit);

        return reply.send({
          count: opportunities.length,
          opportunities,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get opportunities');
        return reply.status(500).send({ error: 'Failed to get opportunities' });
      }
    }
  );

  /**
   * GET /api/activity
   * Get recent high-value trades with wallet profile information.
   * Query params:
   *   - limit: max number of results (default 20)
   *   - minUsd: minimum trade size in USD (default 1000)
   */
  app.get<{ Querystring: { limit?: string; minUsd?: string } }>(
    '/api/activity',
    async (request, reply) => {
      try {
        const limit = parseInt(request.query.limit ?? '20', 10);
        const minUsd = parseFloat(request.query.minUsd ?? '1000');

        let activity = await aggregationService.getRecentActivity(limit * 2);

        // Filter by minimum USD if specified
        if (minUsd > 0) {
          activity = activity.filter(a => a.sizeUsd >= minUsd);
        }

        // Apply limit
        activity = activity.slice(0, limit);

        return reply.send({
          count: activity.length,
          activity,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get activity');
        return reply.status(500).send({ error: 'Failed to get activity' });
      }
    }
  );

  /**
   * GET /api/activity/top
   * Get top N largest trades from recent activity.
   * Query params:
   *   - limit: max number of results (default 10)
   */
  app.get<{ Querystring: { limit?: string } }>(
    '/api/activity/top',
    async (request, reply) => {
      try {
        const limit = parseInt(request.query.limit ?? '10', 10);
        const topTrades = await aggregationService.getTopTrades(limit);

        return reply.send({
          count: topTrades.length,
          trades: topTrades,
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get top trades');
        return reply.status(500).send({ error: 'Failed to get top trades' });
      }
    }
  );
}

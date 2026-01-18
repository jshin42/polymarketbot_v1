import type { FastifyInstance } from 'fastify';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { AggregationService } from '../services/aggregation.service.js';

// =============================================================================
// Stats Route
// =============================================================================

const logger = createLogger('stats-route');

export function registerStatsRoutes(
  app: FastifyInstance,
  redis: Redis,
  aggregationService: AggregationService
): void {
  /**
   * GET /api/stats
   * Get system-wide statistics.
   */
  app.get('/api/stats', async (request, reply) => {
    try {
      const stats = await aggregationService.getSystemStats();
      return reply.send(stats);
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      return reply.status(500).send({ error: 'Failed to get stats' });
    }
  });

  /**
   * GET /api/stats/pnl
   * Get detailed P&L breakdown.
   */
  app.get('/api/stats/pnl', async (request, reply) => {
    try {
      const [bankrollStr, dailyPnlStr, peakStr, drawdownStr, consecutiveLossesStr] =
        await Promise.all([
          redis.get(RedisKeys.paperBankroll()),
          redis.get(RedisKeys.dailyPnl()),
          redis.get('paper:peak_bankroll'),
          redis.get(RedisKeys.drawdownPct()),
          redis.get(RedisKeys.consecutiveLosses()),
        ]);

      const bankroll = parseFloat(bankrollStr ?? '10000');
      const dailyPnl = parseFloat(dailyPnlStr ?? '0');
      const peakBankroll = parseFloat(peakStr ?? '10000');
      const drawdownPct = parseFloat(drawdownStr ?? '0');
      const consecutiveLosses = parseInt(consecutiveLossesStr ?? '0', 10);

      const totalPnl = bankroll - 10000; // Assumes initial bankroll of 10000

      return reply.send({
        bankroll,
        initialBankroll: 10000,
        totalPnl,
        totalPnlPct: (totalPnl / 10000) * 100,
        dailyPnl,
        dailyPnlPct: (dailyPnl / bankroll) * 100,
        peakBankroll,
        currentDrawdown: drawdownPct * 100,
        maxDrawdown: ((peakBankroll - bankroll) / peakBankroll) * 100,
        consecutiveLosses,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get P&L stats');
      return reply.status(500).send({ error: 'Failed to get P&L stats' });
    }
  });

  /**
   * GET /api/stats/risk
   * Get risk exposure details.
   */
  app.get('/api/stats/risk', async (request, reply) => {
    try {
      const [
        bankrollStr,
        exposureStr,
        circuitBreakerData,
        positionSizes,
      ] = await Promise.all([
        redis.get(RedisKeys.paperBankroll()),
        redis.get(RedisKeys.totalExposure()),
        redis.hgetall(RedisKeys.circuitBreaker()),
        redis.hgetall(RedisKeys.positionSize()),
      ]);

      const bankroll = parseFloat(bankrollStr ?? '10000');
      const totalExposure = parseFloat(exposureStr ?? '0');
      const circuitBreakerActive = circuitBreakerData?.active === 'true';

      // Calculate position breakdown
      const positionBreakdown: Array<{ tokenId: string; sizeUsd: number; pct: number }> = [];
      for (const [tokenId, sizeStr] of Object.entries(positionSizes)) {
        const sizeUsd = parseFloat(sizeStr);
        positionBreakdown.push({
          tokenId,
          sizeUsd,
          pct: (sizeUsd / bankroll) * 100,
        });
      }

      // Sort by size descending
      positionBreakdown.sort((a, b) => b.sizeUsd - a.sizeUsd);

      return reply.send({
        bankroll,
        totalExposure,
        exposurePct: (totalExposure / bankroll) * 100,
        maxExposurePct: 10, // From config
        exposureRemaining: Math.max(0, bankroll * 0.1 - totalExposure),
        circuitBreaker: {
          active: circuitBreakerActive,
          reason: circuitBreakerData?.reason ?? null,
          activatedAt: circuitBreakerData?.activatedAt
            ? parseInt(circuitBreakerData.activatedAt, 10)
            : null,
        },
        positionBreakdown,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get risk stats');
      return reply.status(500).send({ error: 'Failed to get risk stats' });
    }
  });

  /**
   * GET /api/stats/decisions
   * Get recent trading decisions.
   */
  app.get<{ Querystring: { limit?: string } }>('/api/stats/decisions', async (request, reply) => {
    try {
      const limit = parseInt(request.query.limit ?? '20', 10);
      const decisions = await aggregationService.getRecentDecisions(limit);

      const approved = decisions.filter((d) => d.approved);
      const rejected = decisions.filter((d) => !d.approved);

      return reply.send({
        total: decisions.length,
        approved: approved.length,
        rejected: rejected.length,
        approvalRate: decisions.length > 0 ? (approved.length / decisions.length) * 100 : 0,
        decisions,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get decisions');
      return reply.status(500).send({ error: 'Failed to get decisions' });
    }
  });

  /**
   * POST /api/stats/reset-daily
   * Reset daily P&L (admin action).
   */
  app.post('/api/stats/reset-daily', async (request, reply) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const currentDailyPnl = await redis.get(RedisKeys.dailyPnl());

      // Archive current daily P&L
      if (currentDailyPnl) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        await redis.set(RedisKeys.dailyPnlByDate(yesterday), currentDailyPnl);
      }

      // Reset
      await redis.set(RedisKeys.dailyPnl(), '0');

      logger.info({ date: today }, 'Daily P&L reset via API');

      return reply.send({
        success: true,
        previousPnl: parseFloat(currentDailyPnl ?? '0'),
        newPnl: 0,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to reset daily P&L');
      return reply.status(500).send({ error: 'Failed to reset daily P&L' });
    }
  });

  /**
   * POST /api/stats/reset-circuit-breaker
   * Reset circuit breaker (admin action).
   */
  app.post('/api/stats/reset-circuit-breaker', async (request, reply) => {
    try {
      await redis.del(RedisKeys.circuitBreaker());
      await redis.set(RedisKeys.consecutiveLosses(), '0');

      logger.info('Circuit breaker reset via API');

      return reply.send({
        success: true,
        message: 'Circuit breaker has been reset',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to reset circuit breaker');
      return reply.status(500).send({ error: 'Failed to reset circuit breaker' });
    }
  });
}

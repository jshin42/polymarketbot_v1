import type { FastifyInstance } from 'fastify';
import { AggregationService } from '../services/aggregation.service.js';
import { createLogger } from '@polymarketbot/shared';

// =============================================================================
// Positions Route
// =============================================================================

const logger = createLogger('positions-route');

export function registerPositionsRoutes(
  app: FastifyInstance,
  aggregationService: AggregationService
): void {
  /**
   * GET /api/positions
   * List all open positions.
   */
  app.get('/api/positions', async (request, reply) => {
    try {
      const positions = await aggregationService.getOpenPositions();

      // Calculate totals
      let totalSizeUsd = 0;
      let totalUnrealizedPnl = 0;

      for (const position of positions) {
        totalSizeUsd += position.sizeUsd;
        if (position.unrealizedPnl !== null) {
          totalUnrealizedPnl += position.unrealizedPnl;
        }
      }

      return reply.send({
        count: positions.length,
        totalSizeUsd,
        totalUnrealizedPnl,
        positions,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get positions');
      return reply.status(500).send({ error: 'Failed to get positions' });
    }
  });

  /**
   * GET /api/positions/summary
   * Get positions summary grouped by side.
   */
  app.get('/api/positions/summary', async (request, reply) => {
    try {
      const positions = await aggregationService.getOpenPositions();

      const yesPositions = positions.filter((p) => p.side === 'YES');
      const noPositions = positions.filter((p) => p.side === 'NO');

      const yesSizeUsd = yesPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
      const noSizeUsd = noPositions.reduce((sum, p) => sum + p.sizeUsd, 0);

      const yesPnl = yesPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
      const noPnl = noPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

      return reply.send({
        yes: {
          count: yesPositions.length,
          totalSizeUsd: yesSizeUsd,
          unrealizedPnl: yesPnl,
        },
        no: {
          count: noPositions.length,
          totalSizeUsd: noSizeUsd,
          unrealizedPnl: noPnl,
        },
        total: {
          count: positions.length,
          totalSizeUsd: yesSizeUsd + noSizeUsd,
          unrealizedPnl: yesPnl + noPnl,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get positions summary');
      return reply.status(500).send({ error: 'Failed to get positions summary' });
    }
  });

  /**
   * GET /api/positions/at-risk
   * Get positions with negative unrealized P&L.
   */
  app.get('/api/positions/at-risk', async (request, reply) => {
    try {
      const positions = await aggregationService.getOpenPositions();
      const atRisk = positions.filter(
        (p) => p.unrealizedPnl !== null && p.unrealizedPnl < 0
      );

      // Sort by loss magnitude (most negative first)
      atRisk.sort((a, b) => (a.unrealizedPnl ?? 0) - (b.unrealizedPnl ?? 0));

      const totalLoss = atRisk.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

      return reply.send({
        count: atRisk.length,
        totalLoss,
        positions: atRisk,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get at-risk positions');
      return reply.status(500).send({ error: 'Failed to get at-risk positions' });
    }
  });
}

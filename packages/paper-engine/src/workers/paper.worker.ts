import { Worker, Job } from 'bullmq';
import { RedisKeys, createLogger, Redis, type Decision, type OrderbookSnapshot } from '@polymarketbot/shared';
import { PaperExecutionService, type FillResult } from '../services/paper-execution.service.js';
import { PositionTrackerService, type PaperPosition } from '../services/position-tracker.service.js';
import { PnlCalculatorService } from '../services/pnl-calculator.service.js';

// =============================================================================
// Paper Engine Worker
// =============================================================================

const logger = createLogger('paper-worker');

export interface PaperJobData {
  decision: Decision;
  marketData: {
    timestamp: number;
    closeTime: number;
    currentMid: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
    topOfBookDepth: number;
  };
}

export interface PaperJobResult {
  tokenId: string;
  timestamp: number;
  executed: boolean;
  fill: FillResult | null;
  position: PaperPosition | null;
  error: string | null;
}

export interface PaperWorkerDeps {
  redis: Redis;
}

/**
 * Create paper engine worker that simulates order execution.
 */
export async function createPaperWorker(
  deps: PaperWorkerDeps
): Promise<Worker<PaperJobData, PaperJobResult>> {
  const { redis } = deps;

  // Initialize services
  const executionService = new PaperExecutionService();
  const positionTracker = new PositionTrackerService(redis);
  const pnlCalculator = new PnlCalculatorService(redis);

  const worker = new Worker<PaperJobData, PaperJobResult>(
    RedisKeys.queues.paper,
    async (job: Job<PaperJobData>): Promise<PaperJobResult> => {
      const { decision, marketData } = job.data;
      const { tokenId } = decision;

      logger.debug(
        { tokenId, action: decision.action, size: decision.targetSizeUsd },
        'Processing paper execution job'
      );

      try {
        // Build synthetic orderbook from market data for simulation
        const syntheticOrderbook = buildSyntheticOrderbook(marketData);

        // Simulate execution
        const fill = executionService.simulateFill(decision, syntheticOrderbook);

        if (!fill.filled) {
          logger.info(
            {
              tokenId,
              reason: fill.unfilledReason,
            },
            'Paper execution not filled'
          );

          return {
            tokenId,
            timestamp: marketData.timestamp,
            executed: false,
            fill,
            position: null,
            error: fill.unfilledReason,
          };
        }

        // Determine position side and direction
        const side = decision.side as 'YES' | 'NO' ?? 'YES';
        const direction = decision.direction as 'LONG' | 'SHORT' ?? 'LONG';

        // Create position
        const position = await positionTracker.openPosition(
          tokenId,
          decision.conditionId,
          side,
          direction,
          fill
        );

        logger.info(
          {
            positionId: position.id,
            tokenId,
            side,
            fillPrice: fill.fillPrice,
            fillSize: fill.fillSizeUsd,
            slippage: fill.slippageBps,
          },
          'Paper position opened'
        );

        return {
          tokenId,
          timestamp: marketData.timestamp,
          executed: true,
          fill,
          position,
          error: null,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, tokenId }, 'Paper execution job failed');

        return {
          tokenId,
          timestamp: marketData.timestamp,
          executed: false,
          fill: null,
          position: null,
          error: errorMessage,
        };
      }
    },
    {
      connection: redis.duplicate() as any, // BullMQ connection type
      concurrency: 5,
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    if (result.executed) {
      logger.info(
        {
          jobId: job.id,
          tokenId: result.tokenId,
          fillPrice: result.fill?.fillPrice,
          fillSize: result.fill?.fillSizeUsd,
        },
        'Paper execution completed'
      );
    }
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      'Paper execution job failed'
    );
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Paper worker error');
  });

  logger.info('Paper engine worker started');

  return worker;
}

/**
 * Build a synthetic orderbook from market data for simulation.
 * This is a simplification - in production you'd fetch the actual book.
 *
 * Creates a realistic order book with:
 * - Top of book at best bid/ask prices
 * - Additional depth levels with decreasing liquidity
 */
function buildSyntheticOrderbook(marketData: {
  bestBid: number;
  bestAsk: number;
  topOfBookDepth: number;
}): OrderbookSnapshot {
  const { bestBid, bestAsk, topOfBookDepth } = marketData;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  // Create synthetic depth levels
  // Assume liquidity decreases away from mid
  const bids: Array<{ price: number; size: number }> = [];
  const asks: Array<{ price: number; size: number }> = [];

  // Top of book
  bids.push({ price: bestBid, size: topOfBookDepth / bestBid });
  asks.push({ price: bestAsk, size: topOfBookDepth / bestAsk });

  // Additional levels (decreasing liquidity)
  for (let i = 1; i <= 4; i++) {
    const bidPrice = bestBid - i * 0.01;
    const askPrice = bestAsk + i * 0.01;
    const depthMultiplier = Math.max(0.2, 1 - i * 0.2);

    if (bidPrice > 0.01) {
      bids.push({
        price: bidPrice,
        size: (topOfBookDepth * depthMultiplier) / bidPrice,
      });
    }
    if (askPrice < 0.99) {
      asks.push({
        price: askPrice,
        size: (topOfBookDepth * depthMultiplier) / askPrice,
      });
    }
  }

  return {
    tokenId: '',
    timestamp: Date.now(),
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice: mid,
    spread,
    spreadBps: mid > 0 ? (spread / mid) * 10000 : null,
  };
}

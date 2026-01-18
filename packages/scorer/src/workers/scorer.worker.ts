import { Worker, Queue, Job } from 'bullmq';
import { RedisKeys, type FeatureVector, type CompositeScore, type OrderbookSnapshot, createLogger, Redis } from '@polymarketbot/shared';
import { ScoringService } from '../services/scoring.service.js';

// =============================================================================
// Types
// =============================================================================

const logger = createLogger('scorer-worker');

interface CachedOrderbookState {
  orderbook: OrderbookSnapshot;
  metrics: {
    bidDepth5Pct: number;
    bidDepth10Pct: number;
    askDepth5Pct: number;
    askDepth10Pct: number;
  };
}

export interface ScoreJobData {
  tokenId: string;
  conditionId: string;
  timestamp: number;
  features: FeatureVector;
}

export interface ScoreJobResult {
  tokenId: string;
  timestamp: number;
  scores: CompositeScore;
}

// =============================================================================
// Worker Factory
// =============================================================================

export interface ScorerWorkerDeps {
  redis: Redis;
  strategyQueue: Queue;
}

export async function createScorerWorker(deps: ScorerWorkerDeps): Promise<Worker> {
  const { redis, strategyQueue } = deps;
  const scoringService = new ScoringService(redis);

  const worker = new Worker<ScoreJobData, ScoreJobResult>(
    RedisKeys.queues.score,
    async (job: Job<ScoreJobData>) => {
      const { tokenId, conditionId, timestamp, features } = job.data;

      logger.debug({ jobId: job.id, tokenId }, 'Processing score job');

      try {
        // Compute scores
        const scores = await scoringService.computeScores(
          tokenId,
          conditionId,
          timestamp,
          features
        );

        // Only emit to strategy queue if signal is significant and not in no-trade zone
        if (scores.signalStrength !== 'none' && !features.timeToClose.inNoTradeZone) {
          // Fetch orderbook state from Redis for market data
          const orderbookStateStr = await redis.get(RedisKeys.orderbookState(tokenId));
          const marketMetadataStr = await redis.get(RedisKeys.marketMetadata(conditionId));

          if (!orderbookStateStr) {
            logger.warn({ tokenId }, 'No orderbook state found, skipping strategy emit');
          } else {
            const orderbookState: CachedOrderbookState = JSON.parse(orderbookStateStr);
            const marketMetadata = marketMetadataStr ? JSON.parse(marketMetadataStr) : {};

            // Build marketData from cached orderbook state
            const marketData = {
              closeTime: marketMetadata.endDateIso
                ? new Date(marketMetadata.endDateIso).getTime()
                : Date.now() + 24 * 60 * 60 * 1000, // Default 24h if unknown
              currentMid: orderbookState.orderbook.midPrice ?? 0.5,
              bestBid: orderbookState.orderbook.bestBid ?? 0.49,
              bestAsk: orderbookState.orderbook.bestAsk ?? 0.51,
              spread: orderbookState.orderbook.spread ?? 0.02,
              topOfBookDepth: (orderbookState.metrics.bidDepth5Pct + orderbookState.metrics.askDepth5Pct) / 2,
            };

            await strategyQueue.add(
              `strategy-${tokenId}-${timestamp}`,
              {
                tokenId,
                conditionId,
                timestamp,
                scores,
                features,
                marketData,
              },
              {
                removeOnComplete: 100,
                removeOnFail: 50,
              }
            );

            logger.info(
              {
                tokenId,
                signalStrength: scores.signalStrength,
                compositeScore: scores.compositeScore.toFixed(3),
                marketMid: marketData.currentMid,
              },
              'Signal emitted to strategy'
            );
          }
        }

        return {
          tokenId,
          timestamp,
          scores,
        };
      } catch (error) {
        logger.error({ error, jobId: job.id, tokenId }, 'Score job failed');
        throw error;
      }
    },
    {
      connection: redis.duplicate(),
      concurrency: 20,
      limiter: {
        max: 100,
        duration: 1000,
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, tokenId: job.data.tokenId }, 'Score job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Score job failed permanently');
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Scorer worker error');
  });

  return worker;
}

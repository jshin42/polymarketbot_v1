import { Worker, Queue, Job } from 'bullmq';
import {
  RedisKeys,
  createLogger,
  Redis,
  RedisTTL,
  type FeatureVector,
  type OrderbookSnapshot,
  type OrderbookMetrics,
  type Trade,
} from '@polymarketbot/shared';
import { FeatureComputerService } from '../services/feature-computer.service.js';
import { RollingStateService } from '../services/rolling-state.service.js';

// =============================================================================
// Types
// =============================================================================

const logger = createLogger('feature-worker');

export interface FeatureJobData {
  type: 'orderbook' | 'trade';
  tokenId: string;
  conditionId: string;
  timestamp: number;
  data: {
    orderbook?: OrderbookSnapshot;
    metrics?: OrderbookMetrics;
    trade?: Trade;
  };
}

export interface FeatureJobResult {
  tokenId: string;
  timestamp: number;
  features: FeatureVector;
}

// =============================================================================
// Worker Factory
// =============================================================================

export interface FeatureWorkerDeps {
  redis: Redis;
  scoreQueue: Queue;
}

export async function createFeatureWorker(deps: FeatureWorkerDeps): Promise<Worker> {
  const { redis, scoreQueue } = deps;

  const rollingState = new RollingStateService(redis);
  const featureComputer = new FeatureComputerService(redis, rollingState);

  const worker = new Worker<FeatureJobData, FeatureJobResult>(
    RedisKeys.queues.features,
    async (job: Job<FeatureJobData>) => {
      const { type, tokenId, conditionId, timestamp, data } = job.data;

      logger.debug({ jobId: job.id, type, tokenId }, 'Processing feature job');

      try {
        // Update rolling state based on event type
        if (type === 'trade' && data.trade) {
          await rollingState.recordTrade(tokenId, data.trade);
        } else if (type === 'orderbook' && data.orderbook && data.metrics) {
          await rollingState.recordOrderbook(tokenId, data.orderbook, data.metrics);
        }

        // Compute full feature vector
        const features = await featureComputer.computeFeatures(
          tokenId,
          conditionId,
          timestamp,
          type === 'trade' ? data.trade : undefined,
          type === 'orderbook' ? { orderbook: data.orderbook!, metrics: data.metrics! } : undefined
        );

        // Cache feature vector
        await redis.set(
          RedisKeys.featureCache(tokenId),
          JSON.stringify(features),
          'EX',
          RedisTTL.featureCache
        );

        // Emit to scorer queue
        await scoreQueue.add(
          `score-${tokenId}-${timestamp}`,
          {
            tokenId,
            conditionId,
            timestamp,
            features,
          },
          {
            removeOnComplete: 100,
            removeOnFail: 50,
          }
        );

        const result: FeatureJobResult = {
          tokenId,
          timestamp,
          features,
        };

        logger.debug({ tokenId, anomalyComponents: features.tradeSize?.sizeTailScore }, 'Features computed');

        return result;
      } catch (error) {
        logger.error({ error, jobId: job.id, type, tokenId }, 'Feature job failed');
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
    logger.debug({ jobId: job.id, tokenId: job.data.tokenId }, 'Feature job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Feature job failed permanently');
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Feature worker error');
  });

  return worker;
}

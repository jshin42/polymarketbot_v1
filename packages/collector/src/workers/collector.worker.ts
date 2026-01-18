import { Worker, Queue, Job } from 'bullmq';
import { RedisKeys, RedisTTL, createLogger, Redis } from '@polymarketbot/shared';
import { GammaClient } from '../clients/gamma.client.js';
import { ClobRestClient } from '../clients/clob-rest.client.js';
import { DataApiClient } from '../clients/data-api.client.js';
import { WalletEnricherService } from '../services/wallet-enricher.service.js';
import { processMarketMetadataJob } from '../jobs/market-metadata.job.js';
import { processOrderbookSnapshotJob } from '../jobs/orderbook-snapshot.job.js';
import { processTradePollJob } from '../jobs/trade-poll.job.js';

// =============================================================================
// Types
// =============================================================================

export interface MarketMetadataJobData {
  withinHours: number;
}

export interface OrderbookSnapshotJobData {
  tokenId: string;
  conditionId: string;
}

export interface TradePollJobData {
  tokenId: string;
  conditionId: string;
  since?: number; // Unix timestamp of last trade
}

export type CollectorJobData =
  | { type: 'market-metadata'; data: MarketMetadataJobData }
  | { type: 'orderbook-snapshot'; data: OrderbookSnapshotJobData }
  | { type: 'trade-poll'; data: TradePollJobData };

// =============================================================================
// Worker Factory
// =============================================================================

const logger = createLogger('collector-worker');

export interface CollectorWorkerDeps {
  redis: Redis;
  gammaClient: GammaClient;
  clobClient: ClobRestClient;
  dataApiClient: DataApiClient;
  walletEnricherService: WalletEnricherService;
  featuresQueue: Queue;
}

export async function createCollectorWorker(deps: CollectorWorkerDeps): Promise<Worker> {
  const { redis, gammaClient, clobClient, dataApiClient, walletEnricherService, featuresQueue } = deps;

  const worker = new Worker<CollectorJobData>(
    RedisKeys.queues.normalize,
    async (job: Job<CollectorJobData>) => {
      const { type, data } = job.data;

      logger.debug({ jobId: job.id, type }, 'Processing collector job');

      try {
        switch (type) {
          case 'market-metadata':
            return await processMarketMetadataJob(data, { redis, gammaClient });

          case 'orderbook-snapshot':
            return await processOrderbookSnapshotJob(data, { redis, clobClient, featuresQueue });

          case 'trade-poll':
            return await processTradePollJob(data, { redis, dataApiClient, walletEnricherService, featuresQueue });

          default:
            logger.warn({ type }, 'Unknown job type');
            return null;
        }
      } catch (error) {
        logger.error({ error, jobId: job.id, type }, 'Collector job failed');
        throw error;
      }
    },
    {
      connection: redis.duplicate(),
      concurrency: 20,
      limiter: {
        max: 50,
        duration: 1000,
      },
    }
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, type: job.data.type }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Job failed permanently');
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Worker error');
  });

  return worker;
}

// =============================================================================
// Job Schedulers
// =============================================================================

export interface SchedulerConfig {
  marketMetadataIntervalMs: number;
  orderbookSnapshotIntervalMs: number;
  tradePollIntervalMs: number;
  withinHours: number;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  marketMetadataIntervalMs: 5 * 60 * 1000, // 5 minutes
  orderbookSnapshotIntervalMs: 1000, // 1 second
  tradePollIntervalMs: 1000, // 1 second
  withinHours: 24, // Track markets closing within 24 hours
};

export async function startSchedulers(
  redis: Redis,
  collectorQueue: Queue<CollectorJobData>,
  config: Partial<SchedulerConfig> = {}
): Promise<{ stop: () => void }> {
  const cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  const intervals: NodeJS.Timeout[] = [];

  // Schedule market metadata discovery
  const marketMetadataInterval = setInterval(async () => {
    try {
      await collectorQueue.add(
        'market-metadata',
        { type: 'market-metadata', data: { withinHours: cfg.withinHours } },
        { removeOnComplete: 100, removeOnFail: 50 }
      );
    } catch (error) {
      logger.error({ error }, 'Failed to schedule market metadata job');
    }
  }, cfg.marketMetadataIntervalMs);
  intervals.push(marketMetadataInterval);

  // Trigger immediately on startup
  await collectorQueue.add(
    'market-metadata-startup',
    { type: 'market-metadata', data: { withinHours: cfg.withinHours } },
    { removeOnComplete: 100, removeOnFail: 50 }
  );

  // Schedule orderbook snapshots and trade polls for tracked tokens
  const tokenPollInterval = setInterval(async () => {
    try {
      const trackedTokens = await redis.smembers(RedisKeys.trackedTokens());

      for (const tokenData of trackedTokens) {
        const { tokenId, conditionId } = JSON.parse(tokenData);

        // Schedule orderbook snapshot
        await collectorQueue.add(
          `orderbook-${tokenId}`,
          {
            type: 'orderbook-snapshot',
            data: { tokenId, conditionId },
          },
          {
            removeOnComplete: 50,
            removeOnFail: 20,
            jobId: `orderbook-${tokenId}-${Date.now()}`,
          }
        );

        // Schedule trade poll
        const lastTradeKey = RedisKeys.lastUpdate('trade', tokenId);
        const lastTradeStr = await redis.get(lastTradeKey);
        const since = lastTradeStr ? parseInt(lastTradeStr, 10) : undefined;

        await collectorQueue.add(
          `trade-poll-${tokenId}`,
          {
            type: 'trade-poll',
            data: { tokenId, conditionId, since },
          },
          {
            removeOnComplete: 50,
            removeOnFail: 20,
            jobId: `trade-${tokenId}-${Date.now()}`,
          }
        );
      }
    } catch (error) {
      logger.error({ error }, 'Failed to schedule token poll jobs');
    }
  }, cfg.orderbookSnapshotIntervalMs);
  intervals.push(tokenPollInterval);

  logger.info(
    {
      marketMetadataIntervalMs: cfg.marketMetadataIntervalMs,
      orderbookSnapshotIntervalMs: cfg.orderbookSnapshotIntervalMs,
      tradePollIntervalMs: cfg.tradePollIntervalMs,
      withinHours: cfg.withinHours,
    },
    'Schedulers started'
  );

  return {
    stop: () => {
      for (const interval of intervals) {
        clearInterval(interval);
      }
      logger.info('Schedulers stopped');
    },
  };
}

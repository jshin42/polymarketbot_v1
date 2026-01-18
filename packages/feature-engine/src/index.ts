import { Queue } from 'bullmq';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { createFeatureWorker } from './workers/feature.worker.js';

type RedisClient = InstanceType<typeof Redis>;

// =============================================================================
// Exports
// =============================================================================

export * from './algorithms/index.js';
export { RollingStateService } from './services/rolling-state.service.js';
export { FeatureComputerService } from './services/feature-computer.service.js';
export { createFeatureWorker, type FeatureJobData, type FeatureJobResult } from './workers/feature.worker.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('feature-engine-service');

async function main() {
  logger.info('Starting feature-engine service');

  // Initialize Redis connection
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    maxRetriesPerRequest: null,
  });

  redis.on('error', (error) => {
    logger.error({ error }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Redis connected');
  });

  // Initialize score queue for output
  const scoreQueue = new Queue(RedisKeys.queues.score, {
    connection: redis.duplicate(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  });

  // Create worker
  const worker = await createFeatureWorker({ redis, scoreQueue });

  logger.info('Feature-engine service started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down feature-engine service');

    await worker.close();
    await scoreQueue.close();
    await redis.quit();

    logger.info('Feature-engine service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_FEATURE_ENGINE === 'true') {
  main().catch((error) => {
    logger.fatal({ error }, 'Failed to start feature-engine service');
    process.exit(1);
  });
}

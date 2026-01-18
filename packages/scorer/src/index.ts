import { Queue } from 'bullmq';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { createScorerWorker } from './workers/scorer.worker.js';

// =============================================================================
// Exports
// =============================================================================

export { ScoringService } from './services/scoring.service.js';
export { computeAnomalyScore } from './computations/anomaly-score.js';
export { computeExecutionScore } from './computations/execution-score.js';
export { computeEdgeScore, determineTradeDirection } from './computations/edge-score.js';
export { createScorerWorker, type ScoreJobData, type ScoreJobResult } from './workers/scorer.worker.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('scorer-service');

async function main() {
  logger.info('Starting scorer service');

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

  // Initialize strategy queue for output
  const strategyQueue = new Queue(RedisKeys.queues.strategy, {
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
  const worker = await createScorerWorker({ redis, strategyQueue });

  logger.info('Scorer service started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down scorer service');

    await worker.close();
    await strategyQueue.close();
    await redis.quit();

    logger.info('Scorer service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_SCORER === 'true') {
  main().catch((error) => {
    logger.fatal({ error }, 'Failed to start scorer service');
    process.exit(1);
  });
}

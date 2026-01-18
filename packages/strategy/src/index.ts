import { Queue } from 'bullmq';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { createStrategyWorker } from './workers/strategy.worker.js';

// =============================================================================
// Exports
// =============================================================================

export { DecisionService } from './services/decision.service.js';
export { KellySizingService } from './services/kelly-sizing.service.js';
export { RiskGuards } from './guards/risk-guards.js';
export { StalenessGuards } from './guards/staleness-guards.js';
export { createStrategyWorker, type StrategyJobData, type StrategyJobResult } from './workers/strategy.worker.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('strategy-service');

async function main() {
  logger.info('Starting strategy service');

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

  // Initialize paper queue for output
  const paperQueue = new Queue(RedisKeys.queues.paper, {
    connection: redis.duplicate(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  });

  // Initialize paper bankroll if not set
  const bankroll = await redis.get(RedisKeys.paperBankroll());
  if (!bankroll) {
    const initialBankroll = process.env.PAPER_INITIAL_BANKROLL ?? '10000';
    await redis.set(RedisKeys.paperBankroll(), initialBankroll);
    logger.info({ bankroll: initialBankroll }, 'Initialized paper bankroll');
  }

  // Create worker
  const worker = await createStrategyWorker({ redis, paperQueue });

  logger.info('Strategy service started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down strategy service');

    await worker.close();
    await paperQueue.close();
    await redis.quit();

    logger.info('Strategy service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_STRATEGY === 'true') {
  main().catch((error) => {
    logger.fatal({ error }, 'Failed to start strategy service');
    process.exit(1);
  });
}

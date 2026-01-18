import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { createPaperWorker } from './workers/paper.worker.js';

// =============================================================================
// Exports
// =============================================================================

export { PaperExecutionService, type FillResult } from './services/paper-execution.service.js';
export { PositionTrackerService, type PaperPosition } from './services/position-tracker.service.js';
export { PnlCalculatorService, type PnlSummary } from './services/pnl-calculator.service.js';
export { createPaperWorker, type PaperJobData, type PaperJobResult } from './workers/paper.worker.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('paper-engine-service');

async function main() {
  logger.info('Starting paper-engine service');

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

  // Initialize paper bankroll if not set
  const bankroll = await redis.get(RedisKeys.paperBankroll());
  if (!bankroll) {
    const initialBankroll = process.env.PAPER_INITIAL_BANKROLL ?? '10000';
    await redis.set(RedisKeys.paperBankroll(), initialBankroll);
    await redis.set('paper:peak_bankroll', initialBankroll);
    logger.info({ bankroll: initialBankroll }, 'Initialized paper bankroll');
  }

  // Initialize daily P&L if not set
  const dailyPnl = await redis.get(RedisKeys.dailyPnl());
  if (!dailyPnl) {
    await redis.set(RedisKeys.dailyPnl(), '0');
  }

  // Initialize other counters
  const exposure = await redis.get(RedisKeys.totalExposure());
  if (!exposure) {
    await redis.set(RedisKeys.totalExposure(), '0');
  }

  const consecutiveLosses = await redis.get(RedisKeys.consecutiveLosses());
  if (!consecutiveLosses) {
    await redis.set(RedisKeys.consecutiveLosses(), '0');
  }

  const drawdown = await redis.get(RedisKeys.drawdownPct());
  if (!drawdown) {
    await redis.set(RedisKeys.drawdownPct(), '0');
  }

  // Create worker
  const worker = await createPaperWorker({ redis });

  logger.info('Paper-engine service started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down paper-engine service');

    await worker.close();
    await redis.quit();

    logger.info('Paper-engine service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_PAPER_ENGINE === 'true') {
  main().catch((error) => {
    logger.fatal({ error }, 'Failed to start paper-engine service');
    process.exit(1);
  });
}

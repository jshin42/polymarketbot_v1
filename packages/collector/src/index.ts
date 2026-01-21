import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import { GammaClient } from './clients/gamma.client.js';
import { ClobRestClient } from './clients/clob-rest.client.js';
import { ClobWebSocketClient } from './clients/clob-ws.client.js';
import { DataApiClient } from './clients/data-api.client.js';
import { PolygonscanClient } from './clients/polygonscan.client.js';
import { WalletEnricherService } from './services/wallet-enricher.service.js';
import {
  createCollectorWorker,
  startSchedulers,
  type CollectorJobData,
} from './workers/collector.worker.js';

// =============================================================================
// Exports
// =============================================================================

export { ClobRestClient, ClobApiError } from './clients/clob-rest.client.js';
export { ClobWebSocketClient, type ClobWebSocketEvents } from './clients/clob-ws.client.js';
export { DataApiClient, DataApiError } from './clients/data-api.client.js';
export { GammaClient, GammaApiError } from './clients/gamma.client.js';
export { PolygonscanClient, PolygonscanApiError } from './clients/polygonscan.client.js';
export { WalletEnricherService, type WalletEnrichment, type WalletEnricherConfig } from './services/wallet-enricher.service.js';
export { createCollectorWorker, startSchedulers } from './workers/collector.worker.js';
export type {
  CollectorJobData,
  MarketMetadataJobData,
  OrderbookSnapshotJobData,
  TradePollJobData,
} from './workers/collector.worker.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('collector-service');

async function main() {
  logger.info('Starting collector service');

  // Initialize Redis connection
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    maxRetriesPerRequest: null, // Required for BullMQ
  });

  redis.on('error', (error) => {
    logger.error({ error }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Redis connected');
  });

  // Initialize PostgreSQL connection for trade persistence
  let pgPool: Pool | null = null;
  const pgHost = process.env.POSTGRES_HOST ?? process.env.DATABASE_HOST;

  if (pgHost) {
    try {
      pgPool = new Pool({
        host: pgHost,
        port: parseInt(process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432', 10),
        database: process.env.POSTGRES_DB ?? process.env.DATABASE_NAME ?? 'polymarketbot',
        user: process.env.POSTGRES_USER ?? process.env.DATABASE_USER ?? 'postgres',
        password: process.env.POSTGRES_PASSWORD ?? process.env.DATABASE_PASSWORD ?? 'postgres',
        max: 20,
      });

      await pgPool.query('SELECT 1');
      logger.info('PostgreSQL connected for trade persistence');
    } catch (error) {
      logger.warn({ error }, 'PostgreSQL connection failed - trades will not be persisted to database');
      pgPool = null;
    }
  } else {
    logger.info('PostgreSQL not configured - trades will only be stored in Redis');
  }

  // Initialize clients
  const gammaClient = new GammaClient();
  const clobClient = new ClobRestClient({
    apiKey: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
    address: process.env.POLYMARKET_ADDRESS,
  });
  const dataApiClient = new DataApiClient();

  // Initialize wallet enricher service for real Polygonscan data
  const polygonscanApiKey = process.env.POLYGONSCAN_API_KEY;
  if (!polygonscanApiKey) {
    logger.warn('POLYGONSCAN_API_KEY not set - wallet enrichment will use fallback data');
  }
  const walletEnricherService = new WalletEnricherService(redis, {
    polygonscanApiKey: polygonscanApiKey ?? '',
  });

  // Initialize queues
  const collectorQueue = new Queue<CollectorJobData>(RedisKeys.queues.normalize, {
    connection: redis.duplicate(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  });

  const featuresQueue = new Queue(RedisKeys.queues.features, {
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
  const worker = await createCollectorWorker({
    redis,
    gammaClient,
    clobClient,
    dataApiClient,
    walletEnricherService,
    featuresQueue,
    pgPool,
  });

  // Start schedulers
  const schedulers = await startSchedulers(redis, collectorQueue, {
    marketMetadataIntervalMs: parseInt(process.env.MARKET_METADATA_INTERVAL_MS ?? '300000', 10),
    orderbookSnapshotIntervalMs: parseInt(process.env.ORDERBOOK_INTERVAL_MS ?? '1000', 10),
    tradePollIntervalMs: parseInt(process.env.TRADE_POLL_INTERVAL_MS ?? '1000', 10),
    withinHours: parseInt(process.env.TRACK_WITHIN_HOURS ?? '24', 10),
  });

  logger.info('Collector service started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down collector service');

    schedulers.stop();
    await worker.close();
    await collectorQueue.close();
    await featuresQueue.close();
    await redis.quit();
    if (pgPool) {
      await pgPool.end();
    }

    logger.info('Collector service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_COLLECTOR === 'true') {
  main().catch((error) => {
    logger.fatal({ error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error }, 'Failed to start collector service');
    console.error('Startup error:', error);
    process.exit(1);
  });
}

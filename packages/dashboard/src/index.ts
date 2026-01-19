import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger, Redis } from '@polymarketbot/shared';

import { AggregationService } from './services/aggregation.service.js';
import { AnalysisService } from './services/analysis.service.js';
import { registerHealthRoutes } from './routes/health.route.js';
import { registerMarketsRoutes } from './routes/markets.route.js';
import { registerScoresRoutes } from './routes/scores.route.js';
import { registerPositionsRoutes } from './routes/positions.route.js';
import { registerStatsRoutes } from './routes/stats.route.js';
import { registerAnalysisRoutes } from './routes/analysis.route.js';

// =============================================================================
// Exports
// =============================================================================

export { AggregationService } from './services/aggregation.service.js';
export { registerHealthRoutes } from './routes/health.route.js';
export { registerMarketsRoutes } from './routes/markets.route.js';
export { registerScoresRoutes } from './routes/scores.route.js';
export { registerPositionsRoutes } from './routes/positions.route.js';
export { registerStatsRoutes } from './routes/stats.route.js';
export { AnalysisService } from './services/analysis.service.js';
export { registerAnalysisRoutes } from './routes/analysis.route.js';

// =============================================================================
// Service Entry Point
// =============================================================================

const logger = createLogger('dashboard-service');

async function main() {
  logger.info('Starting dashboard service');

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

  // Initialize PostgreSQL connection (optional)
  let pgPool: Pool | null = null;
  const pgHost = process.env.POSTGRES_HOST ?? process.env.DATABASE_HOST;

  if (pgHost) {
    pgPool = new Pool({
      host: pgHost,
      port: parseInt(process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432', 10),
      database: process.env.POSTGRES_DB ?? process.env.DATABASE_NAME ?? 'polymarketbot',
      user: process.env.POSTGRES_USER ?? process.env.DATABASE_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? process.env.DATABASE_PASSWORD ?? 'postgres',
      max: 10,
    });

    try {
      await pgPool.query('SELECT 1');
      logger.info('PostgreSQL connected');
    } catch (error) {
      logger.warn({ error }, 'PostgreSQL connection failed - running without database');
      pgPool = null;
    }
  } else {
    logger.info('PostgreSQL not configured - running without database');
  }

  // Initialize services
  const aggregationService = new AggregationService(redis, pgPool ?? undefined);
  const analysisService = new AnalysisService(redis, pgPool ?? undefined);

  // Create Fastify server
  const app = Fastify({
    logger: false, // Use our own logger
  });

  // Register CORS
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? '*',
  });

  // Register static file serving for dashboard UI
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // Register routes
  registerHealthRoutes(app, redis, pgPool);
  registerMarketsRoutes(app, aggregationService);
  registerScoresRoutes(app, redis, aggregationService);
  registerPositionsRoutes(app, aggregationService);
  registerStatsRoutes(app, redis, aggregationService);
  registerAnalysisRoutes(app, analysisService, pgPool ?? undefined);

  // Start server
  const host = process.env.DASHBOARD_HOST ?? '0.0.0.0';
  const port = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);

  await app.listen({ host, port });
  logger.info({ host, port }, 'Dashboard server started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down dashboard service');

    await app.close();
    if (pgPool) {
      await pgPool.end();
    }
    await redis.quit();

    logger.info('Dashboard service stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run if this is the main module
const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '');
if (isMainModule || process.env.RUN_DASHBOARD === 'true') {
  main().catch((error) => {
    logger.fatal({ error }, 'Failed to start dashboard service');
    process.exit(1);
  });
}

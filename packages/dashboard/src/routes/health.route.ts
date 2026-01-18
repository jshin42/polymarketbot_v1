import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createLogger, Redis } from '@polymarketbot/shared';

// =============================================================================
// Health Route
// =============================================================================

const logger = createLogger('health-route');

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  services: {
    redis: 'ok' | 'error';
    postgres: 'ok' | 'error' | 'not_configured';
  };
  version: string;
}

const startTime = Date.now();

export function registerHealthRoutes(
  app: FastifyInstance,
  redis: Redis,
  pgPool: Pool | null
): void {
  app.get('/health', async (request, reply) => {
    const status = await checkHealth(redis, pgPool);
    const statusCode = status.status === 'ok' ? 200 : status.status === 'degraded' ? 200 : 503;
    return reply.status(statusCode).send(status);
  });

  app.get('/health/live', async (request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  app.get('/health/ready', async (request, reply) => {
    const status = await checkHealth(redis, pgPool);
    const ready = status.status !== 'unhealthy';
    return reply.status(ready ? 200 : 503).send({ ready });
  });
}

async function checkHealth(redis: Redis, pgPool: Pool | null): Promise<HealthStatus> {
  const services: HealthStatus['services'] = {
    redis: 'error',
    postgres: pgPool ? 'error' : 'not_configured',
  };

  // Check Redis
  try {
    const pingResult = await redis.ping();
    if (pingResult === 'PONG') {
      services.redis = 'ok';
    }
  } catch (error) {
    logger.warn({ error }, 'Redis health check failed');
  }

  // Check PostgreSQL
  if (pgPool) {
    try {
      const result = await pgPool.query('SELECT 1');
      if (result.rows.length > 0) {
        services.postgres = 'ok';
      }
    } catch (error) {
      logger.warn({ error }, 'PostgreSQL health check failed');
    }
  }

  // Determine overall status
  let status: HealthStatus['status'] = 'ok';
  if (services.redis === 'error') {
    status = 'unhealthy';
  } else if (services.postgres === 'error') {
    status = 'degraded';
  }

  return {
    status,
    timestamp: Date.now(),
    uptime: Date.now() - startTime,
    services,
    version: process.env.npm_package_version ?? '0.1.0',
  };
}

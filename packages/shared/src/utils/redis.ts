// =============================================================================
// Redis Utility
// =============================================================================
//
// Provides consistent Redis client factory and type exports.
// All packages should import Redis utilities from here.

import { Redis, type RedisOptions } from 'ioredis';

export { Redis, type RedisOptions };

/**
 * Default Redis connection options for the bot.
 */
export const DEFAULT_REDIS_OPTIONS: RedisOptions = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
};

/**
 * Creates a configured Redis client instance.
 *
 * @param options - Additional Redis options to merge with defaults
 * @returns Configured Redis client
 *
 * @example
 * ```typescript
 * import { createRedisClient } from '@polymarketbot/shared';
 * const redis = createRedisClient();
 * await redis.ping();
 * ```
 */
export function createRedisClient(options?: Partial<RedisOptions>): Redis {
  return new Redis({
    ...DEFAULT_REDIS_OPTIONS,
    ...options,
  });
}

/**
 * Type alias for the Redis client instance.
 */
export type RedisClient = Redis;

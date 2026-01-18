// =============================================================================
// External Library Type Helpers
// =============================================================================

import type { Redis } from 'ioredis';
import type { Logger as PinoLogger, LoggerOptions as PinoLoggerOptions } from 'pino';

/**
 * Redis client type for use in type annotations.
 * Use this instead of `Redis` directly to avoid ESM namespace issues.
 */
export type RedisClient = Redis;

/**
 * Pino logger type
 */
export type Logger = PinoLogger;

/**
 * Pino logger options type
 */
export type LoggerOptions = PinoLoggerOptions;

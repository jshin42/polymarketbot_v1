// =============================================================================
// Logger Utility
// =============================================================================
//
// Provides a consistent logger factory that works across ESM and CJS modules.
// All packages should import createLogger from here instead of directly from pino.

import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';

export type { Logger, LoggerOptions };

/**
 * Creates a pino logger instance with standard configuration.
 *
 * @param name - The name for the logger (appears in log output)
 * @param options - Additional pino options to merge
 * @returns Configured pino Logger instance
 *
 * @example
 * ```typescript
 * import { createLogger } from '@polymarketbot/shared';
 * const logger = createLogger('my-service');
 * logger.info('Service started');
 * ```
 */
export function createLogger(name: string, options?: Partial<LoggerOptions>): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    ...options,
  });
}

/**
 * Re-export pino for cases where direct access is needed.
 */
export { pino };

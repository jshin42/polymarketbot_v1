// =============================================================================
// Utility Exports
// =============================================================================

export {
  RedisKeys,
  RedisTTL,
} from './redis-keys.js';

export {
  computeTimeToClose,
  computeTimeRamp,
  isInNoTradeZone,
  getTimeBucket,
  formatDuration,
  getDateString,
  now,
  parseIsoDateTime,
  addDuration,
  DEFAULT_TIME_RAMP_PARAMS,
  type TimeRampParams,
} from './time.js';

export {
  clamp,
  sigmoid,
  median,
  mad,
  robustZScore,
  computeRollingStats,
  lerp,
  mapRange,
  round,
  percentChange,
  bpsChange,
  ema,
  weightedAverage,
  vwap,
  sharpeRatio,
  maxDrawdown,
  type RollingStats,
} from './math.js';

export {
  checkStaleness,
  isTradeSafe,
  checkCombinedStaleness,
  createStalenessTracker,
  DEFAULT_STALENESS_THRESHOLDS,
  type StalenessStatus,
  type StalenessCheck,
  type CombinedStalenessCheck,
  type StalenessTracker,
  type DataType,
} from './staleness.js';

export {
  createLogger,
  pino,
  type Logger,
  type LoggerOptions,
} from './logger.js';

export {
  Redis,
  createRedisClient,
  DEFAULT_REDIS_OPTIONS,
  type RedisClient,
  type RedisOptions,
} from './redis.js';

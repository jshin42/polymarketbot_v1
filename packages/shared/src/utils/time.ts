// =============================================================================
// Time Utilities
// =============================================================================

/**
 * Parameters for the time-to-close ramp function
 */
export interface TimeRampParams {
  /** Ramp steepness (higher = steeper ramp near close) */
  alpha: number;
  /** Decay rate (higher = faster transition to max) */
  beta: number;
  /** Maximum multiplier cap */
  maxMultiplier: number;
}

/**
 * Default time ramp parameters
 */
export const DEFAULT_TIME_RAMP_PARAMS: TimeRampParams = {
  alpha: 2.0,
  beta: 0.1,
  maxMultiplier: 5.0,
};

/**
 * Compute time-to-close in various units
 */
export function computeTimeToClose(
  currentTime: Date | number,
  closeTime: Date | number
): {
  ttcMs: number;
  ttcSeconds: number;
  ttcMinutes: number;
  ttcHours: number;
  isPast: boolean;
} {
  const currentMs = typeof currentTime === 'number' ? currentTime : currentTime.getTime();
  const closeMs = typeof closeTime === 'number' ? closeTime : closeTime.getTime();

  const ttcMs = closeMs - currentMs;
  const isPast = ttcMs < 0;

  return {
    ttcMs: Math.max(0, ttcMs),
    ttcSeconds: Math.max(0, ttcMs / 1000),
    ttcMinutes: Math.max(0, ttcMs / (1000 * 60)),
    ttcHours: Math.max(0, ttcMs / (1000 * 60 * 60)),
    isPast,
  };
}

/**
 * Compute time ramp multiplier
 *
 * The ramp function increases as time-to-close decreases:
 * - Far from close: multiplier ≈ 1
 * - Near close: multiplier approaches 1 + alpha
 *
 * Formula: ramp = 1 + alpha * exp(-beta * ttc_hours)
 *
 * @param ttcHours Time to close in hours
 * @param params Ramp parameters
 * @returns Ramp multiplier (>= 1)
 */
export function computeTimeRamp(
  ttcHours: number,
  params: TimeRampParams = DEFAULT_TIME_RAMP_PARAMS
): number {
  const { alpha, beta, maxMultiplier } = params;

  // Exponential ramp: increases as ttc decreases
  const rawRamp = 1 + alpha * Math.exp(-beta * ttcHours);

  // Cap at max multiplier
  return Math.min(rawRamp, maxMultiplier);
}

/**
 * Check if we're in the no-trade zone
 *
 * @param ttcSeconds Time to close in seconds
 * @param noTradeZoneSeconds No-trade zone threshold (default 120s)
 */
export function isInNoTradeZone(
  ttcSeconds: number,
  noTradeZoneSeconds: number = 120
): boolean {
  return ttcSeconds > 0 && ttcSeconds <= noTradeZoneSeconds;
}

/**
 * Get time bucket for categorical features
 */
export function getTimeBucket(ttcMinutes: number): {
  inLast5Minutes: boolean;
  inLast15Minutes: boolean;
  inLast30Minutes: boolean;
  inLastHour: boolean;
  inLast2Hours: boolean;
  bucket: '5m' | '15m' | '30m' | '1h' | '2h' | '>2h';
} {
  const inLast5Minutes = ttcMinutes <= 5;
  const inLast15Minutes = ttcMinutes <= 15;
  const inLast30Minutes = ttcMinutes <= 30;
  const inLastHour = ttcMinutes <= 60;
  const inLast2Hours = ttcMinutes <= 120;

  let bucket: '5m' | '15m' | '30m' | '1h' | '2h' | '>2h';
  if (inLast5Minutes) bucket = '5m';
  else if (inLast15Minutes) bucket = '15m';
  else if (inLast30Minutes) bucket = '30m';
  else if (inLastHour) bucket = '1h';
  else if (inLast2Hours) bucket = '2h';
  else bucket = '>2h';

  return {
    inLast5Minutes,
    inLast15Minutes,
    inLast30Minutes,
    inLastHour,
    inLast2Hours,
    bucket,
  };
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Get ISO date string for a given timestamp (YYYY-MM-DD)
 */
export function getDateString(timestamp: number | Date = Date.now()): string {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const isoString = date.toISOString();
  const datePartIndex = isoString.indexOf('T');
  return datePartIndex >= 0 ? isoString.substring(0, datePartIndex) : isoString.substring(0, 10);
}

/**
 * Get current timestamp in milliseconds
 */
export function now(): number {
  return Date.now();
}

/**
 * Parse ISO datetime string to timestamp
 */
export function parseIsoDateTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Add duration to timestamp
 */
export function addDuration(
  timestamp: number,
  duration: {
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    ms?: number;
  }
): number {
  const { days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = duration;
  return timestamp +
    days * 24 * 60 * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000 +
    ms;
}

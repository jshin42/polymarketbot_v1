// =============================================================================
// Math Utilities
// =============================================================================

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Sigmoid function for smooth 0-1 mapping
 *
 * @param x Input value
 * @param k Steepness (higher = steeper transition)
 * @param x0 Midpoint (where sigmoid = 0.5)
 */
export function sigmoid(x: number, k: number = 1, x0: number = 0): number {
  return 1 / (1 + Math.exp(-k * (x - x0)));
}

/**
 * Compute median of an array
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Compute Median Absolute Deviation (MAD)
 * MAD = median(|x_i - median(x)|)
 */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;

  const med = median(values);
  const deviations = values.map(v => Math.abs(v - med));
  return median(deviations);
}

/**
 * Compute robust z-score using median and MAD
 * z = (x - median) / (k * MAD)
 * k = 1.4826 is the consistency constant for normal distribution
 */
export function robustZScore(
  value: number,
  medianVal: number,
  madVal: number
): number {
  const CONSISTENCY_CONSTANT = 1.4826;

  if (madVal === 0) {
    // All values are the same; return 0 if value equals median
    return value === medianVal ? 0 : (value > medianVal ? Infinity : -Infinity);
  }

  return (value - medianVal) / (CONSISTENCY_CONSTANT * madVal);
}

/**
 * Rolling statistics computation
 */
export interface RollingStats {
  count: number;
  sum: number;
  mean: number;
  median: number;
  mad: number;
  min: number;
  max: number;
  variance: number;
  stdDev: number;
}

/**
 * Compute rolling statistics for an array
 */
export function computeRollingStats(values: number[]): RollingStats {
  if (values.length === 0) {
    return {
      count: 0,
      sum: 0,
      mean: 0,
      median: 0,
      mad: 0,
      min: 0,
      max: 0,
      variance: 0,
      stdDev: 0,
    };
  }

  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;
  const medianVal = median(values);
  const madVal = mad(values);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Variance and standard deviation
  const squaredDiffs = values.map(v => (v - mean) ** 2);
  const variance = count > 1 ? squaredDiffs.reduce((a, b) => a + b, 0) / (count - 1) : 0;
  const stdDev = Math.sqrt(variance);

  return {
    count,
    sum,
    mean,
    median: medianVal,
    mad: madVal,
    min,
    max,
    variance,
    stdDev,
  };
}

/**
 * Linear interpolation
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Map a value from one range to another
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  const t = (value - inMin) / (inMax - inMin);
  return lerp(outMin, outMax, t);
}

/**
 * Round to specified decimal places
 */
export function round(value: number, decimals: number = 2): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}

/**
 * Calculate percentage change
 */
export function percentChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : (to > 0 ? Infinity : -Infinity);
  return ((to - from) / from) * 100;
}

/**
 * Calculate basis points change
 */
export function bpsChange(from: number, to: number): number {
  return percentChange(from, to) * 100;
}

/**
 * Simple exponential moving average
 */
export function ema(values: number[], alpha: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;

  let result = values[0]!;
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i]! + (1 - alpha) * result;
  }
  return result;
}

/**
 * Weighted average
 */
export function weightedAverage(
  values: number[],
  weights: number[]
): number {
  if (values.length === 0 || weights.length === 0) return 0;
  if (values.length !== weights.length) {
    throw new Error('Values and weights must have same length');
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return 0;

  const weightedSum = values.reduce((sum, val, i) => sum + val * weights[i]!, 0);
  return weightedSum / totalWeight;
}

/**
 * Volume-weighted average price (VWAP)
 */
export function vwap(
  prices: number[],
  volumes: number[]
): number | null {
  if (prices.length === 0 || prices.length !== volumes.length) return null;

  const totalVolume = volumes.reduce((a, b) => a + b, 0);
  if (totalVolume === 0) return null;

  const weightedPriceSum = prices.reduce((sum, price, i) => sum + price * volumes[i]!, 0);
  return weightedPriceSum / totalVolume;
}

/**
 * Calculate Sharpe ratio (simplified)
 */
export function sharpeRatio(
  returns: number[],
  riskFreeRate: number = 0,
  annualizationFactor: number = 252 // Daily returns
): number {
  if (returns.length < 2) return 0;

  const stats = computeRollingStats(returns);
  const excessReturn = stats.mean - riskFreeRate;

  if (stats.stdDev === 0) return 0;

  return (excessReturn / stats.stdDev) * Math.sqrt(annualizationFactor);
}

/**
 * Calculate max drawdown from a series of values
 */
export function maxDrawdown(values: number[]): {
  maxDrawdown: number;
  maxDrawdownPct: number;
  peakIndex: number;
  troughIndex: number;
} {
  if (values.length === 0) {
    return { maxDrawdown: 0, maxDrawdownPct: 0, peakIndex: 0, troughIndex: 0 };
  }

  let maxDd = 0;
  let maxDdPct = 0;
  let peak = values[0]!;
  let peakIndex = 0;
  let troughIndex = 0;
  let currentPeakIndex = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;

    if (value > peak) {
      peak = value;
      currentPeakIndex = i;
    }

    const drawdown = peak - value;
    const drawdownPct = peak > 0 ? drawdown / peak : 0;

    if (drawdownPct > maxDdPct) {
      maxDd = drawdown;
      maxDdPct = drawdownPct;
      peakIndex = currentPeakIndex;
      troughIndex = i;
    }
  }

  return { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, peakIndex, troughIndex };
}

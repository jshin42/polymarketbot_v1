// =============================================================================
// Robust Z-Score Computation using Median and MAD
// =============================================================================

/**
 * Rolling statistics for robust z-score computation
 */
export interface RobustStats {
  median: number;
  mad: number; // Median Absolute Deviation
  count: number;
}

/**
 * Compute robust z-score using median and MAD
 *
 * The robust z-score is less sensitive to outliers than the standard z-score.
 * It uses median instead of mean, and MAD instead of standard deviation.
 *
 * Formula: z = (x - median) / (k * MAD)
 * where k = 1.4826 is the consistency constant for normal distribution
 *
 * @param value The value to compute z-score for
 * @param stats Rolling statistics (median and MAD)
 * @returns Robust z-score
 */
export function computeRobustZScore(
  value: number,
  stats: RobustStats
): number {
  const CONSISTENCY_CONSTANT = 1.4826;

  // Need at least some data points
  if (stats.count < 10) {
    return 0;
  }

  // If MAD is 0, all values are the same
  if (stats.mad === 0) {
    return value === stats.median ? 0 : (value > stats.median ? Infinity : -Infinity);
  }

  return (value - stats.median) / (CONSISTENCY_CONSTANT * stats.mad);
}

/**
 * Compute median of an array
 */
export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  return sorted[mid]!;
}

/**
 * Compute Median Absolute Deviation (MAD)
 */
export function mad(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const med = median(values);
  const deviations = values.map(v => Math.abs(v - med));
  return median(deviations);
}

/**
 * Compute rolling robust statistics from an array of values
 */
export function computeRobustStats(values: number[]): RobustStats {
  return {
    median: median(values),
    mad: mad(values),
    count: values.length,
  };
}

/**
 * Compute robust z-score directly from values
 */
export function computeRobustZScoreFromValues(
  value: number,
  values: number[]
): number {
  const stats = computeRobustStats(values);
  return computeRobustZScore(value, stats);
}

/**
 * Identify outliers using robust z-score
 *
 * @param values Array of values
 * @param threshold Z-score threshold (default 3)
 * @returns Indices of outliers
 */
export function identifyOutliers(
  values: number[],
  threshold: number = 3
): number[] {
  const stats = computeRobustStats(values);
  const outliers: number[] = [];

  for (let i = 0; i < values.length; i++) {
    const z = computeRobustZScore(values[i]!, stats);
    if (Math.abs(z) > threshold) {
      outliers.push(i);
    }
  }

  return outliers;
}

// =============================================================================
// Statistics Service - Statistical Functions for Research Analysis
// =============================================================================

/**
 * Result of correlation calculation
 */
export interface CorrelationResult {
  r: number;
  pValue: number;
  ci: [number, number];
}

/**
 * Result of logistic regression
 */
export interface LogisticModel {
  coefficients: number[];
  intercept: number;
  featureNames: string[];
  iterations: number;
  convergence: boolean;
}

/**
 * Calibration point for calibration curve
 */
export interface CalibrationPoint {
  binMidpoint: number;
  meanPredicted: number;
  meanActual: number;
  count: number;
}

/**
 * ROC curve point
 */
export interface RocPoint {
  threshold: number;
  tpr: number; // True positive rate (sensitivity)
  fpr: number; // False positive rate (1 - specificity)
}

// -----------------------------------------------------------------------------
// Normal Distribution Functions
// -----------------------------------------------------------------------------

/**
 * Standard normal CDF approximation (Abramowitz and Stegun)
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * T-distribution CDF approximation
 */
export function tDistCDF(t: number, df: number): number {
  if (df <= 0) return 0.5;
  // For large df, t-distribution approaches normal
  const x = t / Math.sqrt(1 + (t * t) / df);
  return normalCDF(x);
}

// -----------------------------------------------------------------------------
// Correlation Functions
// -----------------------------------------------------------------------------

/**
 * Point-biserial correlation between a binary predictor and binary outcome
 */
export function pointBiserialCorrelation(
  binaryPredictor: boolean[],
  binaryOutcome: boolean[]
): CorrelationResult {
  const n = binaryPredictor.length;
  if (n !== binaryOutcome.length || n < 4) {
    return { r: 0, pValue: 1, ci: [0, 0] };
  }

  const n1 = binaryPredictor.filter(x => x).length;
  const n0 = n - n1;

  if (n1 === 0 || n0 === 0) {
    return { r: 0, pValue: 1, ci: [0, 0] };
  }

  // Mean outcome for each group
  let sum1 = 0;
  let sum0 = 0;
  for (let i = 0; i < n; i++) {
    if (binaryPredictor[i]) {
      sum1 += binaryOutcome[i] ? 1 : 0;
    } else {
      sum0 += binaryOutcome[i] ? 1 : 0;
    }
  }
  const m1 = sum1 / n1;
  const m0 = sum0 / n0;

  // Pooled standard deviation
  let sumSq = 0;
  let sumOutcomes = 0;
  for (let i = 0; i < n; i++) {
    const val = binaryOutcome[i] ? 1 : 0;
    sumOutcomes += val;
    sumSq += val * val;
  }
  const mean = sumOutcomes / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  const s = Math.sqrt(variance);

  if (s === 0) {
    return { r: 0, pValue: 1, ci: [0, 0] };
  }

  // Point-biserial correlation
  const r = ((m1 - m0) / s) * Math.sqrt((n1 * n0) / (n * n));

  // Clamp r to valid range
  const rClamped = Math.max(-1, Math.min(1, r));

  // T-statistic for significance
  const rSq = rClamped * rClamped;
  if (rSq >= 1) {
    return { r: rClamped, pValue: 0, ci: [rClamped, rClamped] };
  }

  const tStat = rClamped * Math.sqrt((n - 2) / (1 - rSq));
  const pValue = 2 * (1 - tDistCDF(Math.abs(tStat), n - 2));

  // 95% CI using Fisher z-transform
  let ci: [number, number] = [-1, 1];
  if (Math.abs(rClamped) < 0.9999 && n > 3) {
    const z = 0.5 * Math.log((1 + rClamped) / (1 - rClamped));
    const se = 1 / Math.sqrt(n - 3);
    const zLo = z - 1.96 * se;
    const zHi = z + 1.96 * se;
    ci = [
      Math.max(-1, (Math.exp(2 * zLo) - 1) / (Math.exp(2 * zLo) + 1)),
      Math.min(1, (Math.exp(2 * zHi) - 1) / (Math.exp(2 * zHi) + 1)),
    ];
  }

  return { r: rClamped, pValue: Math.max(0, Math.min(1, pValue)), ci };
}

/**
 * Spearman rank correlation for continuous variables
 */
export function spearmanCorrelation(x: number[], y: number[]): CorrelationResult {
  if (x.length !== y.length || x.length < 3) {
    return { r: 0, pValue: 1, ci: [0, 0] };
  }

  const n = x.length;

  // Compute ranks
  const rankX = computeRanks(x);
  const rankY = computeRanks(y);

  // Pearson correlation on ranks
  const meanRankX = rankX.reduce((a, b) => a + b, 0) / n;
  const meanRankY = rankY.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;

  for (let i = 0; i < n; i++) {
    const dx = rankX[i] - meanRankX;
    const dy = rankY[i] - meanRankY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  if (sumSqX === 0 || sumSqY === 0) {
    return { r: 0, pValue: 1, ci: [0, 0] };
  }

  const rho = numerator / Math.sqrt(sumSqX * sumSqY);
  const rClamped = Math.max(-1, Math.min(1, rho));

  // Approximate p-value using t-distribution
  const rSq = rClamped * rClamped;
  if (rSq >= 1) {
    return { r: rClamped, pValue: 0, ci: [rClamped, rClamped] };
  }

  const tStat = rClamped * Math.sqrt((n - 2) / (1 - rSq));
  const pValue = 2 * (1 - tDistCDF(Math.abs(tStat), n - 2));

  // 95% CI using Fisher z-transform
  let ci: [number, number] = [-1, 1];
  if (Math.abs(rClamped) < 0.9999 && n > 3) {
    const z = 0.5 * Math.log((1 + rClamped) / (1 - rClamped));
    const se = 1 / Math.sqrt(n - 3);
    const zLo = z - 1.96 * se;
    const zHi = z + 1.96 * se;
    ci = [
      Math.max(-1, (Math.exp(2 * zLo) - 1) / (Math.exp(2 * zLo) + 1)),
      Math.min(1, (Math.exp(2 * zHi) - 1) / (Math.exp(2 * zHi) + 1)),
    ];
  }

  return { r: rClamped, pValue: Math.max(0, Math.min(1, pValue)), ci };
}

/**
 * Compute ranks with average ranks for ties
 */
function computeRanks(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    // Find all tied values
    while (j < n - 1 && indexed[j].value === indexed[j + 1].value) {
      j++;
    }
    // Assign average rank to all tied values
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j + 1;
  }

  return ranks;
}

// -----------------------------------------------------------------------------
// Logistic Regression
// -----------------------------------------------------------------------------

/**
 * Sigmoid function
 */
function sigmoid(z: number): number {
  if (z < -500) return 0;
  if (z > 500) return 1;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Simple logistic regression using gradient descent
 */
export function logisticRegression(
  X: number[][],
  y: boolean[],
  config?: { learningRate?: number; iterations?: number; lambda?: number }
): LogisticModel {
  const learningRate = config?.learningRate ?? 0.1;
  const maxIterations = config?.iterations ?? 1000;
  const lambda = config?.lambda ?? 0.01; // L2 regularization

  const n = X.length;
  if (n === 0 || n !== y.length) {
    return {
      coefficients: [],
      intercept: 0,
      featureNames: [],
      iterations: 0,
      convergence: false,
    };
  }

  const numFeatures = X[0].length;
  const weights = new Array(numFeatures).fill(0);
  let intercept = 0;

  const yNum = y.map(v => v ? 1 : 0);

  let converged = false;
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    const gradients = new Array(numFeatures).fill(0);
    let interceptGrad = 0;
    let totalLoss = 0;

    for (let i = 0; i < n; i++) {
      let z = intercept;
      for (let j = 0; j < numFeatures; j++) {
        z += weights[j] * X[i][j];
      }
      const pred = sigmoid(z);
      const error = pred - yNum[i];
      totalLoss += yNum[i] * Math.log(pred + 1e-10) + (1 - yNum[i]) * Math.log(1 - pred + 1e-10);

      interceptGrad += error;
      for (let j = 0; j < numFeatures; j++) {
        gradients[j] += error * X[i][j];
      }
    }

    // Update with L2 regularization
    intercept -= learningRate * (interceptGrad / n);
    for (let j = 0; j < numFeatures; j++) {
      weights[j] -= learningRate * (gradients[j] / n + lambda * weights[j]);
    }

    // Check convergence
    const gradMagnitude = Math.sqrt(
      interceptGrad * interceptGrad + gradients.reduce((a, b) => a + b * b, 0)
    ) / n;

    if (gradMagnitude < 1e-6) {
      converged = true;
      break;
    }
  }

  return {
    coefficients: weights,
    intercept,
    featureNames: [],
    iterations: iter,
    convergence: converged,
  };
}

/**
 * Predict probabilities using logistic model
 */
export function logisticPredict(model: LogisticModel, X: number[][]): number[] {
  return X.map(row => {
    let z = model.intercept;
    for (let j = 0; j < row.length; j++) {
      z += model.coefficients[j] * row[j];
    }
    return sigmoid(z);
  });
}

// -----------------------------------------------------------------------------
// Bootstrap and Confidence Intervals
// -----------------------------------------------------------------------------

/**
 * Bootstrap confidence interval for a statistic
 */
export function bootstrapCI(
  data: number[],
  statistic: (d: number[]) => number,
  nBootstrap: number = 1000,
  alpha: number = 0.05
): [number, number] {
  if (data.length === 0) {
    return [0, 0];
  }

  const bootstrapStats: number[] = [];

  for (let i = 0; i < nBootstrap; i++) {
    // Sample with replacement
    const sample = [];
    for (let j = 0; j < data.length; j++) {
      const idx = Math.floor(Math.random() * data.length);
      sample.push(data[idx]);
    }
    bootstrapStats.push(statistic(sample));
  }

  // Sort and get percentiles
  bootstrapStats.sort((a, b) => a - b);
  const lowerIdx = Math.floor((alpha / 2) * nBootstrap);
  const upperIdx = Math.floor((1 - alpha / 2) * nBootstrap);

  return [bootstrapStats[lowerIdx], bootstrapStats[Math.min(upperIdx, nBootstrap - 1)]];
}

// -----------------------------------------------------------------------------
// Multiple Testing Correction
// -----------------------------------------------------------------------------

/**
 * Benjamini-Hochberg FDR correction
 */
export function benjaminiHochberg(
  pValues: number[],
  alpha: number = 0.05
): {
  adjustedPValues: number[];
  significantIndices: number[];
  fdr: number;
} {
  const n = pValues.length;
  if (n === 0) {
    return { adjustedPValues: [], significantIndices: [], fdr: 0 };
  }

  // Sort p-values with original indices
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  // Compute adjusted p-values (Benjamini-Hochberg)
  const adjustedPValues = new Array(n);
  let minP = 1;

  for (let k = n - 1; k >= 0; k--) {
    const adjusted = Math.min(minP, indexed[k].p * n / (k + 1));
    adjustedPValues[indexed[k].i] = adjusted;
    minP = adjusted;
  }

  // Find significant indices
  const significantIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (adjustedPValues[i] < alpha) {
      significantIndices.push(i);
    }
  }

  // Estimate FDR
  const fdr = significantIndices.length > 0
    ? Math.max(...significantIndices.map(i => adjustedPValues[i]))
    : 0;

  return { adjustedPValues, significantIndices, fdr };
}

// -----------------------------------------------------------------------------
// AUC and ROC
// -----------------------------------------------------------------------------

/**
 * Calculate AUC-ROC using the trapezoidal rule
 */
export function calculateAUC(predictions: number[], labels: boolean[]): number {
  if (predictions.length !== labels.length || predictions.length === 0) {
    return 0.5;
  }

  // Sort by predictions descending
  const indexed = predictions.map((p, i) => ({ p, label: labels[i] }));
  indexed.sort((a, b) => b.p - a.p);

  const nPos = labels.filter(l => l).length;
  const nNeg = labels.length - nPos;

  if (nPos === 0 || nNeg === 0) {
    return 0.5;
  }

  let tpr = 0;
  let fpr = 0;
  let auc = 0;
  let prevTpr = 0;
  let prevFpr = 0;

  for (const item of indexed) {
    if (item.label) {
      tpr += 1 / nPos;
    } else {
      fpr += 1 / nNeg;
      // Trapezoidal rule
      auc += (tpr + prevTpr) * (fpr - prevFpr) / 2;
    }
    prevTpr = tpr;
    prevFpr = fpr;
  }

  return auc;
}

/**
 * Compute ROC curve points
 */
export function computeROC(
  predictions: number[],
  labels: boolean[],
  nThresholds: number = 100
): RocPoint[] {
  const points: RocPoint[] = [];

  const nPos = labels.filter(l => l).length;
  const nNeg = labels.length - nPos;

  if (nPos === 0 || nNeg === 0) {
    return [{ threshold: 0, tpr: 1, fpr: 1 }, { threshold: 1, tpr: 0, fpr: 0 }];
  }

  for (let i = 0; i <= nThresholds; i++) {
    const threshold = i / nThresholds;
    let tp = 0;
    let fp = 0;

    for (let j = 0; j < predictions.length; j++) {
      const predicted = predictions[j] >= threshold;
      if (predicted) {
        if (labels[j]) {
          tp++;
        } else {
          fp++;
        }
      }
    }

    points.push({
      threshold,
      tpr: tp / nPos,
      fpr: fp / nNeg,
    });
  }

  return points;
}

// -----------------------------------------------------------------------------
// Calibration
// -----------------------------------------------------------------------------

/**
 * Compute calibration curve
 */
export function calibrationCurve(
  predictions: number[],
  labels: boolean[],
  nBins: number = 10
): CalibrationPoint[] {
  if (predictions.length !== labels.length || predictions.length === 0) {
    return [];
  }

  const bins: { sumPred: number; sumActual: number; count: number }[] = [];
  for (let i = 0; i < nBins; i++) {
    bins.push({ sumPred: 0, sumActual: 0, count: 0 });
  }

  for (let i = 0; i < predictions.length; i++) {
    const binIdx = Math.min(Math.floor(predictions[i] * nBins), nBins - 1);
    bins[binIdx].sumPred += predictions[i];
    bins[binIdx].sumActual += labels[i] ? 1 : 0;
    bins[binIdx].count++;
  }

  return bins
    .map((bin, i) => ({
      binMidpoint: (i + 0.5) / nBins,
      meanPredicted: bin.count > 0 ? bin.sumPred / bin.count : (i + 0.5) / nBins,
      meanActual: bin.count > 0 ? bin.sumActual / bin.count : 0,
      count: bin.count,
    }))
    .filter(point => point.count > 0);
}

// -----------------------------------------------------------------------------
// Descriptive Statistics
// -----------------------------------------------------------------------------

/**
 * Compute basic statistics for an array
 */
export function descriptiveStats(values: number[]): {
  n: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  median: number;
  q25: number;
  q75: number;
} {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: 0, std: 0, min: 0, max: 0, median: 0, q25: 0, q75: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance || 0);

  return {
    n,
    mean,
    std,
    min: sorted[0],
    max: sorted[n - 1],
    median: quantile(sorted, 0.5),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
  };
}

/**
 * Compute quantile from sorted array
 */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];

  const pos = (n - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const frac = pos - lower;

  if (upper >= n) return sorted[n - 1];
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

/**
 * Compute robust z-score using median and MAD
 */
export function robustZScore(value: number, values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const deviations = values.map(v => Math.abs(v - median));
  const mad = quantile([...deviations].sort((a, b) => a - b), 0.5);

  if (mad === 0) return 0;
  return (value - median) / (1.4826 * mad);
}

/**
 * Compute percentile rank of a value in a distribution
 */
export function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 50;

  let count = 0;
  for (const v of values) {
    if (v < value) count++;
  }

  return (count / values.length) * 100;
}

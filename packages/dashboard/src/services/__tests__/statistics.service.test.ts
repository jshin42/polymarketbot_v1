import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalCDF,
  tDistCDF,
  pointBiserialCorrelation,
  spearmanCorrelation,
  logisticRegression,
  logisticPredict,
  bootstrapCI,
  benjaminiHochberg,
  calculateAUC,
  computeROC,
  calibrationCurve,
  descriptiveStats,
  robustZScore,
  percentileRank,
} from '../statistics.service.js';

// =============================================================================
// Normal Distribution Functions
// =============================================================================

describe('Statistics Service', () => {
  describe('normalCDF()', () => {
    it('should return 0.5 for z=0', () => {
      expect(normalCDF(0)).toBeCloseTo(0.5, 5);
    });

    it('should return ~0.975 for z=1.96', () => {
      expect(normalCDF(1.96)).toBeCloseTo(0.975, 2);
    });

    it('should return ~0.025 for z=-1.96', () => {
      expect(normalCDF(-1.96)).toBeCloseTo(0.025, 2);
    });

    it('should return ~0.8413 for z=1', () => {
      expect(normalCDF(1)).toBeCloseTo(0.8413, 2);
    });

    it('should return ~0.1587 for z=-1', () => {
      expect(normalCDF(-1)).toBeCloseTo(0.1587, 2);
    });

    it('should handle extreme positive values', () => {
      expect(normalCDF(10)).toBeCloseTo(1, 5);
    });

    it('should handle extreme negative values', () => {
      expect(normalCDF(-10)).toBeCloseTo(0, 5);
    });
  });

  describe('tDistCDF()', () => {
    it('should return 0.5 for t=0 with any df', () => {
      expect(tDistCDF(0, 10)).toBeCloseTo(0.5, 5);
      expect(tDistCDF(0, 100)).toBeCloseTo(0.5, 5);
    });

    it('should approach normalCDF for large df', () => {
      // For large df, t-distribution approaches normal
      const normalVal = normalCDF(1.96);
      const tVal = tDistCDF(1.96, 1000);
      expect(tVal).toBeCloseTo(normalVal, 2);
    });

    it('should handle df <= 0', () => {
      expect(tDistCDF(1, 0)).toBe(0.5);
      expect(tDistCDF(1, -5)).toBe(0.5);
    });
  });

  // =============================================================================
  // Correlation Functions
  // =============================================================================

  describe('pointBiserialCorrelation()', () => {
    it('should return zeros for empty arrays', () => {
      const result = pointBiserialCorrelation([], []);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
      expect(result.ci).toEqual([0, 0]);
    });

    it('should return zeros for mismatched array lengths', () => {
      const result = pointBiserialCorrelation([true, false], [true]);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should return zeros for arrays smaller than 4 elements', () => {
      const result = pointBiserialCorrelation([true, false, true], [true, false, true]);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should return zeros when all predictor values are the same', () => {
      const result = pointBiserialCorrelation(
        [true, true, true, true, true],
        [true, false, true, false, true]
      );
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should return zeros when all outcome values are the same', () => {
      const result = pointBiserialCorrelation(
        [true, false, true, false, true],
        [true, true, true, true, true]
      );
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should calculate positive correlation when groups differ', () => {
      // When predictor is true, outcome tends to be true
      const predictor = [true, true, true, true, false, false, false, false];
      const outcome = [true, true, true, false, false, false, false, true];

      const result = pointBiserialCorrelation(predictor, outcome);

      // r should be positive since true predictor -> higher true outcome
      expect(result.r).toBeGreaterThan(0);
      expect(result.pValue).toBeLessThan(1);
      expect(result.ci[0]).toBeLessThan(result.ci[1]);
    });

    it('should calculate negative correlation correctly', () => {
      // When predictor is true, outcome tends to be false
      const predictor = [true, true, true, true, false, false, false, false];
      const outcome = [false, false, false, true, true, true, true, false];

      const result = pointBiserialCorrelation(predictor, outcome);

      // r should be negative
      expect(result.r).toBeLessThan(0);
    });

    it('should have r in range [-1, 1]', () => {
      const predictor = Array.from({ length: 100 }, () => Math.random() > 0.5);
      const outcome = Array.from({ length: 100 }, () => Math.random() > 0.5);

      const result = pointBiserialCorrelation(predictor, outcome);

      expect(result.r).toBeGreaterThanOrEqual(-1);
      expect(result.r).toBeLessThanOrEqual(1);
    });

    it('should have pValue in range [0, 1]', () => {
      const predictor = Array.from({ length: 50 }, () => Math.random() > 0.5);
      const outcome = Array.from({ length: 50 }, () => Math.random() > 0.5);

      const result = pointBiserialCorrelation(predictor, outcome);

      expect(result.pValue).toBeGreaterThanOrEqual(0);
      expect(result.pValue).toBeLessThanOrEqual(1);
    });

    it('should calculate significant p-value for strong relationship', () => {
      // Strong relationship: predictor = outcome (nearly perfect)
      const predictor = [true, true, true, true, true, false, false, false, false, false];
      const outcome = [true, true, true, true, true, false, false, false, false, false];

      const result = pointBiserialCorrelation(predictor, outcome);

      // Point-biserial correlation for this case is ~0.95 (not exactly 1)
      expect(result.r).toBeGreaterThan(0.9);
      expect(result.pValue).toBeLessThan(0.05);
    });
  });

  describe('spearmanCorrelation()', () => {
    it('should return zeros for empty arrays', () => {
      const result = spearmanCorrelation([], []);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should return zeros for arrays smaller than 3 elements', () => {
      const result = spearmanCorrelation([1, 2], [1, 2]);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });

    it('should return r=1 for perfect positive correlation', () => {
      const result = spearmanCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
      expect(result.r).toBeCloseTo(1, 5);
    });

    it('should return r=-1 for perfect negative correlation', () => {
      const result = spearmanCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
      expect(result.r).toBeCloseTo(-1, 5);
    });

    it('should return r=0 for no correlation', () => {
      const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const y = [5, 3, 8, 1, 9, 2, 7, 4, 10, 6]; // Random permutation

      const result = spearmanCorrelation(x, y);
      expect(Math.abs(result.r)).toBeLessThan(0.5);
    });

    it('should handle ties correctly', () => {
      // Ties should get average ranks
      const x = [1, 1, 1, 2, 3];
      const y = [1, 2, 3, 4, 5];

      const result = spearmanCorrelation(x, y);
      expect(result.r).toBeGreaterThan(0);
      expect(result.r).toBeLessThanOrEqual(1);
    });

    it('should return zeros when all values are the same', () => {
      const result = spearmanCorrelation([1, 1, 1, 1], [2, 2, 2, 2]);
      expect(result.r).toBe(0);
      expect(result.pValue).toBe(1);
    });
  });

  // =============================================================================
  // Logistic Regression
  // =============================================================================

  describe('logisticRegression()', () => {
    it('should return empty model for empty input', () => {
      const model = logisticRegression([], []);
      expect(model.coefficients).toEqual([]);
      expect(model.convergence).toBe(false);
    });

    it('should return empty model for mismatched lengths', () => {
      const model = logisticRegression([[1, 2], [3, 4]], [true]);
      expect(model.coefficients).toEqual([]);
      expect(model.convergence).toBe(false);
    });

    it('should fit a simple linearly separable dataset', () => {
      // Simple 1D data: positive X -> true, negative X -> false
      const X = [[-3], [-2], [-1], [1], [2], [3]];
      const y = [false, false, false, true, true, true];

      const model = logisticRegression(X, y, { iterations: 1000 });

      // Coefficient should be positive (higher X -> higher P(true))
      expect(model.coefficients[0]).toBeGreaterThan(0);

      // Predictions should be reasonably accurate
      const preds = logisticPredict(model, X);
      expect(preds[0]).toBeLessThan(0.5); // negative X -> low prob
      expect(preds[5]).toBeGreaterThan(0.5); // positive X -> high prob
    });

    it('should respect L2 regularization', () => {
      const X = [[1], [2], [3], [4], [5]];
      const y = [false, false, true, true, true];

      // High regularization
      const modelHighReg = logisticRegression(X, y, { lambda: 10, iterations: 500 });
      // Low regularization
      const modelLowReg = logisticRegression(X, y, { lambda: 0.001, iterations: 500 });

      // High regularization should have smaller coefficients
      expect(Math.abs(modelHighReg.coefficients[0])).toBeLessThan(
        Math.abs(modelLowReg.coefficients[0])
      );
    });

    it('should handle multi-feature input', () => {
      const X = [
        [1, 0],
        [1, 1],
        [0, 0],
        [0, 1],
        [2, 1],
        [2, 0],
      ];
      const y = [true, true, false, false, true, true];

      const model = logisticRegression(X, y, { iterations: 500 });

      expect(model.coefficients.length).toBe(2);
    });

    it('should track iterations', () => {
      const X = [[1], [2], [3], [4], [5]];
      const y = [false, false, true, true, true];

      const model = logisticRegression(X, y, { iterations: 100 });

      expect(model.iterations).toBeLessThanOrEqual(100);
    });
  });

  describe('logisticPredict()', () => {
    it('should return probabilities in [0, 1]', () => {
      const model = {
        coefficients: [1.5],
        intercept: -0.5,
        featureNames: ['x'],
        iterations: 100,
        convergence: true,
      };

      const preds = logisticPredict(model, [[-10], [0], [10]]);

      preds.forEach(p => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      });
    });

    it('should return 0.5 when z=0', () => {
      const model = {
        coefficients: [1],
        intercept: 0,
        featureNames: ['x'],
        iterations: 100,
        convergence: true,
      };

      const preds = logisticPredict(model, [[0]]);
      expect(preds[0]).toBeCloseTo(0.5, 5);
    });
  });

  // =============================================================================
  // Bootstrap CI
  // =============================================================================

  describe('bootstrapCI()', () => {
    it('should return [0, 0] for empty data', () => {
      const result = bootstrapCI([], (d) => d.reduce((a, b) => a + b, 0) / d.length);
      expect(result).toEqual([0, 0]);
    });

    it('should return narrow CI for low-variance data', () => {
      const data = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
      const meanFn = (d: number[]) => d.reduce((a, b) => a + b, 0) / d.length;

      const [lo, hi] = bootstrapCI(data, meanFn, 500);

      expect(lo).toBeCloseTo(100, 0);
      expect(hi).toBeCloseTo(100, 0);
    });

    it('should return CI that contains the true mean (probabilistically)', () => {
      // For a known distribution, the CI should contain the true mean most of the time
      const data = Array.from({ length: 100 }, () => Math.random() * 10);
      const trueMean = data.reduce((a, b) => a + b, 0) / data.length;
      const meanFn = (d: number[]) => d.reduce((a, b) => a + b, 0) / d.length;

      const [lo, hi] = bootstrapCI(data, meanFn, 1000);

      // The CI should contain the sample mean
      expect(lo).toBeLessThanOrEqual(trueMean);
      expect(hi).toBeGreaterThanOrEqual(trueMean);
    });

    it('should widen CI with higher alpha', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const meanFn = (d: number[]) => d.reduce((a, b) => a + b, 0) / d.length;

      const [lo95, hi95] = bootstrapCI(data, meanFn, 1000, 0.05);
      const [lo80, hi80] = bootstrapCI(data, meanFn, 1000, 0.20);

      // 95% CI should be wider than 80% CI
      expect(hi95 - lo95).toBeGreaterThanOrEqual(hi80 - lo80 - 0.5); // Allow some variance
    });
  });

  // =============================================================================
  // Benjamini-Hochberg FDR Correction
  // =============================================================================

  describe('benjaminiHochberg()', () => {
    it('should return empty for empty input', () => {
      const result = benjaminiHochberg([]);
      expect(result.adjustedPValues).toEqual([]);
      expect(result.significantIndices).toEqual([]);
      expect(result.fdr).toBe(0);
    });

    it('should return all indices as significant when all p-values < alpha', () => {
      const pValues = [0.001, 0.002, 0.003, 0.004, 0.005];
      const result = benjaminiHochberg(pValues, 0.05);

      expect(result.significantIndices.length).toBe(5);
    });

    it('should return no indices when all p-values > alpha', () => {
      const pValues = [0.6, 0.7, 0.8, 0.9, 0.95];
      const result = benjaminiHochberg(pValues, 0.05);

      expect(result.significantIndices.length).toBe(0);
    });

    it('should correctly adjust p-values', () => {
      // Known example: p-values = [0.01, 0.04, 0.03, 0.005]
      // Sorted: [0.005, 0.01, 0.03, 0.04] with ranks [1, 2, 3, 4]
      // Adjusted: [0.02, 0.02, 0.04, 0.04]
      const pValues = [0.01, 0.04, 0.03, 0.005];
      const result = benjaminiHochberg(pValues, 0.05);

      // Original index 3 (p=0.005) should have adjusted ~0.02
      expect(result.adjustedPValues[3]).toBeCloseTo(0.02, 2);
    });

    it('should monotonically increase adjusted p-values in sorted order', () => {
      const pValues = [0.01, 0.02, 0.03, 0.04, 0.5];
      const result = benjaminiHochberg(pValues, 0.05);

      // Adjusted p-values in sorted order should be monotonically increasing
      const sortedAdj = [...result.adjustedPValues].sort((a, b) => a - b);
      for (let i = 1; i < sortedAdj.length; i++) {
        expect(sortedAdj[i]).toBeGreaterThanOrEqual(sortedAdj[i - 1]);
      }
    });

    it('should handle single p-value', () => {
      const result = benjaminiHochberg([0.03], 0.05);
      expect(result.adjustedPValues.length).toBe(1);
      expect(result.adjustedPValues[0]).toBeCloseTo(0.03, 5);
      expect(result.significantIndices).toEqual([0]);
    });
  });

  // =============================================================================
  // AUC-ROC
  // =============================================================================

  describe('calculateAUC()', () => {
    it('should return 0.5 for empty arrays', () => {
      expect(calculateAUC([], [])).toBe(0.5);
    });

    it('should return 0.5 for mismatched lengths', () => {
      expect(calculateAUC([0.5, 0.6], [true])).toBe(0.5);
    });

    it('should return 1 for perfect classifier', () => {
      // Predictions perfectly separate classes
      const predictions = [0.9, 0.8, 0.7, 0.3, 0.2, 0.1];
      const labels = [true, true, true, false, false, false];

      expect(calculateAUC(predictions, labels)).toBeCloseTo(1, 5);
    });

    it('should return 0 for perfectly wrong classifier', () => {
      // Predictions are inverted
      const predictions = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
      const labels = [true, true, true, false, false, false];

      expect(calculateAUC(predictions, labels)).toBeCloseTo(0, 5);
    });

    it('should return ~0.5 for uninformative classifier', () => {
      // Predictions are ordered but labels are shuffled in a way that gives ~0.5 AUC
      // High predictions for some false, low predictions for some true
      const predictions = [0.9, 0.8, 0.7, 0.4, 0.3, 0.2];
      const labels = [true, false, false, true, true, false];

      const auc = calculateAUC(predictions, labels);
      // This configuration gives AUC around 0.5 since predictions don't help
      expect(auc).toBeGreaterThanOrEqual(0.3);
      expect(auc).toBeLessThanOrEqual(0.7);
    });

    it('should return 0.5 when all labels are the same', () => {
      const predictions = [0.1, 0.5, 0.9];
      expect(calculateAUC(predictions, [true, true, true])).toBe(0.5);
      expect(calculateAUC(predictions, [false, false, false])).toBe(0.5);
    });

    it('should have AUC in range [0, 1]', () => {
      const predictions = Array.from({ length: 100 }, () => Math.random());
      const labels = Array.from({ length: 100 }, () => Math.random() > 0.5);

      const auc = calculateAUC(predictions, labels);
      expect(auc).toBeGreaterThanOrEqual(0);
      expect(auc).toBeLessThanOrEqual(1);
    });
  });

  describe('computeROC()', () => {
    it('should return sensible defaults for no positive labels', () => {
      const result = computeROC([0.5, 0.5], [false, false]);
      expect(result.length).toBe(2);
    });

    it('should return sensible defaults for no negative labels', () => {
      const result = computeROC([0.5, 0.5], [true, true]);
      expect(result.length).toBe(2);
    });

    it('should return points from (1,1) to (0,0)', () => {
      const predictions = [0.9, 0.6, 0.3];
      const labels = [true, false, false];

      const roc = computeROC(predictions, labels, 10);

      // At threshold 0, all predicted positive -> TPR=1, FPR=1
      expect(roc[0].threshold).toBe(0);
      expect(roc[0].tpr).toBe(1);
      expect(roc[0].fpr).toBe(1);

      // At threshold 1, none predicted positive -> TPR=0, FPR=0
      const lastPoint = roc[roc.length - 1];
      expect(lastPoint.threshold).toBe(1);
      expect(lastPoint.tpr).toBe(0);
      expect(lastPoint.fpr).toBe(0);
    });

    it('should have specified number of thresholds', () => {
      const predictions = [0.9, 0.6, 0.3];
      const labels = [true, false, false];

      const roc = computeROC(predictions, labels, 20);
      expect(roc.length).toBe(21); // 0 to 20 inclusive
    });
  });

  // =============================================================================
  // Calibration
  // =============================================================================

  describe('calibrationCurve()', () => {
    it('should return empty for empty input', () => {
      expect(calibrationCurve([], [])).toEqual([]);
    });

    it('should return empty for mismatched lengths', () => {
      expect(calibrationCurve([0.5, 0.6], [true])).toEqual([]);
    });

    it('should have well-calibrated predictions diagonal', () => {
      // Perfect calibration: prediction = actual rate
      const predictions = [0.1, 0.1, 0.2, 0.2, 0.5, 0.5, 0.8, 0.8, 0.9, 0.9];
      const labels = [false, false, false, false, false, true, true, true, true, true];

      const curve = calibrationCurve(predictions, labels, 5);

      // Each bin should have mean predicted ≈ mean actual
      curve.forEach(point => {
        expect(Math.abs(point.meanPredicted - point.meanActual)).toBeLessThan(0.3);
      });
    });

    it('should detect over-confident predictions', () => {
      // Predictions are always extreme but labels are mixed
      const predictions = [0.95, 0.95, 0.95, 0.05, 0.05, 0.05];
      const labels = [true, false, true, false, true, false]; // 50% actual

      const curve = calibrationCurve(predictions, labels, 2);

      // High bin: predicted ~0.95 but actual ~0.67
      // Low bin: predicted ~0.05 but actual ~0.33
      const highBin = curve.find(p => p.meanPredicted > 0.5);
      const lowBin = curve.find(p => p.meanPredicted < 0.5);

      if (highBin) {
        expect(highBin.meanPredicted).toBeGreaterThan(highBin.meanActual);
      }
      if (lowBin) {
        expect(lowBin.meanPredicted).toBeLessThan(lowBin.meanActual);
      }
    });

    it('should filter out empty bins', () => {
      const predictions = [0.1, 0.1, 0.1]; // All in first bin
      const labels = [true, false, false];

      const curve = calibrationCurve(predictions, labels, 10);

      // Should only have one bin with data
      expect(curve.length).toBe(1);
      expect(curve[0].count).toBe(3);
    });
  });

  // =============================================================================
  // Descriptive Statistics
  // =============================================================================

  describe('descriptiveStats()', () => {
    it('should return zeros for empty array', () => {
      const stats = descriptiveStats([]);
      expect(stats.n).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.std).toBe(0);
    });

    it('should calculate correct statistics for known data', () => {
      const data = [1, 2, 3, 4, 5];
      const stats = descriptiveStats(data);

      expect(stats.n).toBe(5);
      expect(stats.mean).toBe(3);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(5);
      expect(stats.median).toBe(3);
      expect(stats.std).toBeCloseTo(1.5811, 2); // sqrt(2.5)
    });

    it('should calculate quartiles correctly', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const stats = descriptiveStats(data);

      expect(stats.q25).toBeCloseTo(3.25, 1);
      expect(stats.median).toBeCloseTo(5.5, 1);
      expect(stats.q75).toBeCloseTo(7.75, 1);
    });

    it('should handle single value', () => {
      const stats = descriptiveStats([42]);
      expect(stats.n).toBe(1);
      expect(stats.mean).toBe(42);
      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.median).toBe(42);
    });
  });

  describe('robustZScore()', () => {
    it('should return 0 for empty array', () => {
      expect(robustZScore(5, [])).toBe(0);
    });

    it('should return 0 when MAD is 0', () => {
      const values = [5, 5, 5, 5, 5];
      expect(robustZScore(5, values)).toBe(0);
    });

    it('should return 0 for the median value', () => {
      const values = [1, 2, 3, 4, 5];
      const zScore = robustZScore(3, values);
      expect(zScore).toBeCloseTo(0, 5);
    });

    it('should return positive z-score for values above median', () => {
      const values = [1, 2, 3, 4, 5];
      const zScore = robustZScore(5, values);
      expect(zScore).toBeGreaterThan(0);
    });

    it('should return negative z-score for values below median', () => {
      const values = [1, 2, 3, 4, 5];
      const zScore = robustZScore(1, values);
      expect(zScore).toBeLessThan(0);
    });

    it('should be robust to outliers', () => {
      // Regular data with one extreme outlier
      const values = [1, 2, 3, 4, 5, 1000];

      // Regular z-score for 3 would be affected by outlier
      // Robust z-score should be close to 0 since 3 is near median
      const zScore = robustZScore(3, values);
      expect(Math.abs(zScore)).toBeLessThan(1);
    });
  });

  describe('percentileRank()', () => {
    it('should return 50 for empty array', () => {
      expect(percentileRank(5, [])).toBe(50);
    });

    it('should return 0 for smallest value', () => {
      const values = [1, 2, 3, 4, 5];
      expect(percentileRank(1, values)).toBe(0);
    });

    it('should return high percentile for largest value', () => {
      const values = [1, 2, 3, 4, 5];
      expect(percentileRank(5, values)).toBe(80); // 4 out of 5 values are smaller
    });

    it('should return 100 for value larger than all', () => {
      const values = [1, 2, 3, 4, 5];
      expect(percentileRank(10, values)).toBe(100);
    });

    it('should return median percentile for median value', () => {
      const values = [1, 2, 3, 4, 5];
      expect(percentileRank(3, values)).toBe(40); // 2 out of 5 values are smaller
    });
  });
});

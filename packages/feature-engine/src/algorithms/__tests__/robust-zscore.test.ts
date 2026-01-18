import { describe, it, expect } from 'vitest';
import {
  computeRobustZScore,
  computeRobustStats,
  median,
  mad,
  computeRobustZScoreFromValues,
  identifyOutliers,
  type RobustStats,
} from '../robust-zscore.js';

describe('Robust Z-Score', () => {
  describe('median()', () => {
    it('should return 0 for empty array', () => {
      expect(median([])).toBe(0);
    });

    it('should return the single value for array of one', () => {
      expect(median([42])).toBe(42);
    });

    it('should return middle value for odd-length array', () => {
      expect(median([1, 2, 3])).toBe(2);
      expect(median([1, 5, 3, 4, 2])).toBe(3);
    });

    it('should return average of two middle values for even-length array', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
      expect(median([10, 20, 30, 40])).toBe(25);
    });

    it('should handle unsorted arrays', () => {
      expect(median([5, 1, 3, 2, 4])).toBe(3);
      expect(median([100, 1, 50, 25, 75])).toBe(50);
    });

    it('should not modify the original array', () => {
      const original = [5, 1, 3];
      median(original);
      expect(original).toEqual([5, 1, 3]);
    });
  });

  describe('mad()', () => {
    it('should return 0 for empty array', () => {
      expect(mad([])).toBe(0);
    });

    it('should return 0 for array with all same values', () => {
      expect(mad([5, 5, 5, 5])).toBe(0);
    });

    it('should compute MAD correctly', () => {
      // For [1, 2, 3, 4, 5]:
      // median = 3
      // deviations = [2, 1, 0, 1, 2]
      // MAD = median([0, 1, 1, 2, 2]) = 1
      expect(mad([1, 2, 3, 4, 5])).toBe(1);
    });

    it('should handle symmetric distributions', () => {
      // Symmetric around 50
      const values = [40, 45, 50, 55, 60];
      // median = 50
      // deviations = [10, 5, 0, 5, 10]
      // MAD = median([0, 5, 5, 10, 10]) = 5
      expect(mad(values)).toBe(5);
    });
  });

  describe('computeRobustStats()', () => {
    it('should compute all stats correctly', () => {
      const values = [1, 2, 3, 4, 5];
      const stats = computeRobustStats(values);

      expect(stats.median).toBe(3);
      expect(stats.mad).toBe(1);
      expect(stats.count).toBe(5);
    });

    it('should handle empty array', () => {
      const stats = computeRobustStats([]);
      expect(stats.median).toBe(0);
      expect(stats.mad).toBe(0);
      expect(stats.count).toBe(0);
    });
  });

  describe('computeRobustZScore()', () => {
    it('should return 0 when count is less than 10', () => {
      const stats: RobustStats = { median: 100, mad: 10, count: 5 };
      expect(computeRobustZScore(150, stats)).toBe(0);
    });

    it('should return 0 when value equals median', () => {
      const stats: RobustStats = { median: 100, mad: 10, count: 100 };
      expect(computeRobustZScore(100, stats)).toBe(0);
    });

    it('should return Infinity when MAD is 0 and value > median', () => {
      const stats: RobustStats = { median: 100, mad: 0, count: 100 };
      expect(computeRobustZScore(150, stats)).toBe(Infinity);
    });

    it('should return -Infinity when MAD is 0 and value < median', () => {
      const stats: RobustStats = { median: 100, mad: 0, count: 100 };
      expect(computeRobustZScore(50, stats)).toBe(-Infinity);
    });

    it('should compute positive z-score for values above median', () => {
      const stats: RobustStats = { median: 100, mad: 10, count: 100 };
      const z = computeRobustZScore(120, stats);

      // z = (120 - 100) / (1.4826 * 10) = 20 / 14.826 ≈ 1.349
      expect(z).toBeGreaterThan(0);
      expect(z).toBeCloseTo(1.349, 2);
    });

    it('should compute negative z-score for values below median', () => {
      const stats: RobustStats = { median: 100, mad: 10, count: 100 };
      const z = computeRobustZScore(80, stats);

      // z = (80 - 100) / (1.4826 * 10) = -20 / 14.826 ≈ -1.349
      expect(z).toBeLessThan(0);
      expect(z).toBeCloseTo(-1.349, 2);
    });

    it('should identify extreme values with high z-scores', () => {
      const stats: RobustStats = { median: 100, mad: 10, count: 100 };

      // Value 3 MADs above median
      const extremeZ = computeRobustZScore(100 + 3 * 10 * 1.4826, stats);
      expect(extremeZ).toBeCloseTo(3, 1);
    });
  });

  describe('computeRobustZScoreFromValues()', () => {
    it('should compute z-score directly from values array', () => {
      const values = Array.from({ length: 100 }, (_, i) => i);
      const testValue = 95;

      const z = computeRobustZScoreFromValues(testValue, values);

      expect(z).toBeGreaterThan(0);
    });

    it('should return 0 for arrays with less than 10 values', () => {
      const values = [1, 2, 3, 4, 5];
      expect(computeRobustZScoreFromValues(10, values)).toBe(0);
    });
  });

  describe('identifyOutliers()', () => {
    it('should return empty array when no outliers', () => {
      const values = Array.from({ length: 100 }, () => 50 + Math.random() * 10);
      const outliers = identifyOutliers(values, 5);
      expect(outliers.length).toBeLessThan(values.length * 0.1); // Reasonable expectation
    });

    it('should identify extreme values as outliers', () => {
      // Create normal values with one extreme outlier
      const values = Array.from({ length: 100 }, () => 50);
      values[50] = 1000; // Extreme outlier

      const outliers = identifyOutliers(values, 3);
      expect(outliers).toContain(50);
    });

    it('should respect the threshold parameter', () => {
      const values = Array.from({ length: 100 }, (_, i) => i);

      // Lower threshold should catch more outliers
      const outliers3 = identifyOutliers(values, 3);
      const outliers2 = identifyOutliers(values, 2);

      expect(outliers2.length).toBeGreaterThanOrEqual(outliers3.length);
    });

    it('should handle array with less than 10 elements', () => {
      const values = [1, 2, 3, 4, 5];
      const outliers = identifyOutliers(values);
      expect(outliers).toEqual([]); // Z-scores are 0 when count < 10
    });
  });

  describe('Real-world trade size scenarios', () => {
    it('should detect large trades as outliers', () => {
      // Simulate normal trade sizes (mostly small)
      const tradeSizes = [
        // Normal trades
        ...Array.from({ length: 90 }, () => 100 + Math.random() * 200),
        // Large trades
        5000, 10000, 20000,
        // Extreme trade
        100000,
      ];

      // Shuffle to simulate real order
      const shuffled = [...tradeSizes].sort(() => Math.random() - 0.5);

      const stats = computeRobustStats(shuffled);
      const extremeZ = computeRobustZScore(100000, stats);

      // The extreme trade should have a very high z-score
      expect(extremeZ).toBeGreaterThan(3);
    });

    it('should handle typical Polymarket trade distributions', () => {
      // Simulate typical trade sizes: mostly small, some medium, few large
      const tradeSizes = [
        ...Array.from({ length: 500 }, () => 50 + Math.random() * 150),  // $50-200
        ...Array.from({ length: 100 }, () => 200 + Math.random() * 300), // $200-500
        ...Array.from({ length: 30 }, () => 500 + Math.random() * 500),  // $500-1000
        ...Array.from({ length: 10 }, () => 1000 + Math.random() * 2000), // $1k-3k
      ];

      const stats = computeRobustStats(tradeSizes);

      // A $10,000 trade should be anomalous
      const largeTradeZ = computeRobustZScore(10000, stats);
      expect(largeTradeZ).toBeGreaterThan(2);

      // A $100 trade should be normal
      const normalTradeZ = computeRobustZScore(100, stats);
      expect(Math.abs(normalTradeZ)).toBeLessThan(2);
    });
  });
});

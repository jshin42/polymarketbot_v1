import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computeQuantiles } from '../t-digest.js';

// Note: TDigestManager requires Redis, so we test the pure functions here.
// Integration tests with Redis mocks would go in a separate file.

describe('T-Digest Utilities', () => {
  describe('computeQuantiles()', () => {
    it('should return zeros for empty array', () => {
      const result = computeQuantiles([], [25, 50, 75]);
      expect(result).toEqual([0, 0, 0]);
    });

    it('should compute median (q50) correctly', () => {
      const values = [1, 2, 3, 4, 5];
      const [median] = computeQuantiles(values, [50]);
      expect(median).toBe(3);
    });

    it('should compute quartiles correctly', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const [q25, q50, q75] = computeQuantiles(values, [25, 50, 75]);

      // For [1..10]:
      // q25 = position 2.25 → between 3 and 3 (actually interpolated)
      // q50 = position 4.5 → 5.5
      // q75 = position 6.75 → between 7 and 8
      expect(q25).toBeCloseTo(3.25, 1);
      expect(q50).toBeCloseTo(5.5, 1);
      expect(q75).toBeCloseTo(7.75, 1);
    });

    it('should compute extreme quantiles', () => {
      const values = [10, 20, 30, 40, 50];
      const [q0, q100] = computeQuantiles(values, [0, 100]);

      expect(q0).toBe(10);
      expect(q100).toBe(50);
    });

    it('should handle single element array', () => {
      const values = [42];
      const [q25, q50, q75] = computeQuantiles(values, [25, 50, 75]);

      expect(q25).toBe(42);
      expect(q50).toBe(42);
      expect(q75).toBe(42);
    });

    it('should handle two element array', () => {
      const values = [10, 20];
      const [q25, q50, q75] = computeQuantiles(values, [25, 50, 75]);

      expect(q25).toBeCloseTo(12.5, 5);
      expect(q50).toBe(15);
      expect(q75).toBeCloseTo(17.5, 5);
    });

    it('should work with unsorted input', () => {
      const values = [5, 3, 1, 4, 2];
      const sorted = computeQuantiles(values, [50]);
      const alreadySorted = computeQuantiles([1, 2, 3, 4, 5], [50]);

      expect(sorted).toEqual(alreadySorted);
    });

    it('should not modify original array', () => {
      const original = [5, 3, 1, 4, 2];
      computeQuantiles(original, [50]);
      expect(original).toEqual([5, 3, 1, 4, 2]);
    });

    it('should compute typical trade size percentiles', () => {
      // Simulate trade size distribution: mostly small, some large
      const tradeSizes = [
        // Small trades (most common)
        ...Array.from({ length: 500 }, () => 50 + Math.random() * 100),
        // Medium trades
        ...Array.from({ length: 100 }, () => 200 + Math.random() * 300),
        // Large trades (rare)
        ...Array.from({ length: 30 }, () => 500 + Math.random() * 1000),
        // Very large trades (very rare)
        ...Array.from({ length: 10 }, () => 2000 + Math.random() * 5000),
        // Extreme outliers
        10000, 15000, 20000,
      ];

      const [q95, q99, q999] = computeQuantiles(tradeSizes, [95, 99, 99.9]);

      // Most trades are small, so:
      // - q95 should catch medium-large trades
      // - q99 should catch large trades
      // - q999 should catch extreme trades
      expect(q95).toBeGreaterThan(500);
      expect(q99).toBeGreaterThan(1000);
      expect(q999).toBeGreaterThan(5000);

      // And they should be in increasing order
      expect(q95).toBeLessThan(q99);
      expect(q99).toBeLessThan(q999);
    });

    it('should handle duplicate values', () => {
      const values = [100, 100, 100, 100, 200];
      const [median] = computeQuantiles(values, [50]);
      expect(median).toBe(100);
    });
  });

  describe('Quantile-based size tail score mapping', () => {
    /**
     * Maps a value's percentile rank to a tail score:
     * - Below q95: score < 0.5
     * - At q95: score = 0.5
     * - At q99: score = 0.9
     * - At q999: score = 0.98
     */
    function computeSizeTailScore(percentileRank: number): number {
      if (percentileRank < 95) {
        // Linear 0 to 0.5 for 0-95
        return (percentileRank / 95) * 0.5;
      } else if (percentileRank < 99) {
        // 0.5 to 0.9 for 95-99
        return 0.5 + ((percentileRank - 95) / 4) * 0.4;
      } else if (percentileRank < 99.9) {
        // 0.9 to 0.98 for 99-99.9
        return 0.9 + ((percentileRank - 99) / 0.9) * 0.08;
      } else {
        // 0.98 to 1.0 for 99.9+
        return 0.98 + Math.min(0.02, (percentileRank - 99.9) / 0.1 * 0.02);
      }
    }

    it('should return 0.5 at q95', () => {
      expect(computeSizeTailScore(95)).toBeCloseTo(0.5, 5);
    });

    it('should return 0.9 at q99', () => {
      expect(computeSizeTailScore(99)).toBeCloseTo(0.9, 5);
    });

    it('should return 0.98 at q999', () => {
      expect(computeSizeTailScore(99.9)).toBeCloseTo(0.98, 5);
    });

    it('should return low scores for normal values', () => {
      expect(computeSizeTailScore(50)).toBeLessThan(0.3);
      expect(computeSizeTailScore(80)).toBeLessThan(0.5);
    });

    it('should return high scores for extreme values', () => {
      expect(computeSizeTailScore(99.5)).toBeGreaterThan(0.9);
      expect(computeSizeTailScore(99.95)).toBeGreaterThan(0.98);
    });

    it('should cap at 1.0', () => {
      expect(computeSizeTailScore(100)).toBeLessThanOrEqual(1.0);
    });
  });

  describe('Integration scenarios', () => {
    it('should identify whale trades', () => {
      // Simulate 24h of trade sizes
      const normalTrades = Array.from({ length: 1000 }, () =>
        Math.random() < 0.7
          ? 50 + Math.random() * 150    // 70% small: $50-200
          : 200 + Math.random() * 800   // 30% medium: $200-1000
      );

      const [q95, q99] = computeQuantiles(normalTrades, [95, 99]);

      // A $10,000 trade should be well above q99
      expect(10000).toBeGreaterThan(q99);

      // A $200 trade should be below q95
      expect(200).toBeLessThan(q95);
    });

    it('should adapt to market regime', () => {
      // Low volatility period: small trades ($50-100)
      const lowVolTrades = Array.from({ length: 500 }, () =>
        50 + Math.random() * 50
      );

      // High volatility period: larger trades ($300-700)
      const highVolTrades = Array.from({ length: 500 }, () =>
        300 + Math.random() * 400
      );

      const [lowVolQ99] = computeQuantiles(lowVolTrades, [99]);
      const [highVolQ99] = computeQuantiles(highVolTrades, [99]);

      // Low vol range is ~$50-100, so q99 should be close to $100
      expect(lowVolQ99).toBeLessThan(110);

      // High vol range is ~$300-700, so q99 should be close to $700
      expect(highVolQ99).toBeGreaterThan(650);

      // In low vol, $200 would be extreme (above all trades)
      expect(200).toBeGreaterThan(lowVolQ99);

      // In high vol, $600 would be normal (within distribution)
      expect(600).toBeLessThan(highVolQ99);
    });
  });
});

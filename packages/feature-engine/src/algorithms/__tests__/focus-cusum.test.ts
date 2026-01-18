import { describe, it, expect, beforeEach } from 'vitest';
import {
  FocusCusum,
  computeChangePointScore,
  detectRegimeShift,
} from '../focus-cusum.js';

describe('FOCuS CUSUM Change-Point Detection', () => {
  describe('FocusCusum', () => {
    let cusum: FocusCusum;

    beforeEach(() => {
      cusum = new FocusCusum(5.0);
    });

    describe('initialization', () => {
      it('should initialize with default values', () => {
        const state = cusum.getState();
        expect(state.n).toBe(0);
        expect(state.sumX).toBe(0);
        expect(state.sumX2).toBe(0);
        expect(state.maxStatistic).toBe(0);
        expect(state.changePointIndex).toBeNull();
        expect(state.lastValue).toBeNull();
      });

      it('should accept custom threshold', () => {
        const customCusum = new FocusCusum(10.0);
        expect(customCusum.getStatistic()).toBe(0);
      });

      it('should accept pre-change mean', () => {
        const customCusum = new FocusCusum(5.0, 100);
        expect(customCusum.getStatistic()).toBe(0);
      });
    });

    describe('update()', () => {
      it('should increment observation count', () => {
        cusum.update(100);
        expect(cusum.getState().n).toBe(1);

        cusum.update(101);
        expect(cusum.getState().n).toBe(2);
      });

      it('should track last value', () => {
        cusum.update(50);
        expect(cusum.getState().lastValue).toBe(50);

        cusum.update(75);
        expect(cusum.getState().lastValue).toBe(75);
      });

      it('should return detection result', () => {
        const result = cusum.update(100);
        expect(result).toHaveProperty('detected');
        expect(result).toHaveProperty('statistic');
        expect(result).toHaveProperty('changePointIndex');
      });

      it('should not detect change for truly stable process', () => {
        // Use higher threshold for this test to ensure stability
        const stableCusum = new FocusCusum(15.0);

        // Feed very stable constant values
        let detectedCount = 0;
        for (let i = 0; i < 100; i++) {
          const result = stableCusum.update(100); // constant value
          if (result.detected) detectedCount++;
        }

        // With constant values and high threshold, should not detect
        expect(detectedCount).toBe(0);
      });

      it('should detect change when mean shifts', () => {
        // Establish baseline around 100
        for (let i = 0; i < 50; i++) {
          cusum.update(100 + Math.random() * 2 - 1);
        }

        // Shift to 110 (significant increase)
        let detected = false;
        for (let i = 0; i < 50; i++) {
          const result = cusum.update(110 + Math.random() * 2 - 1);
          if (result.detected) {
            detected = true;
            break;
          }
        }

        expect(detected).toBe(true);
      });
    });

    describe('getStatistic()', () => {
      it('should return current statistic', () => {
        cusum.update(100);
        expect(typeof cusum.getStatistic()).toBe('number');
      });

      it('should increase when values are above mean', () => {
        // With no pre-change mean, uses running mean
        // Feed consistently high values to build up statistic
        for (let i = 0; i < 10; i++) {
          cusum.update(100);
        }
        const baseStatistic = cusum.getStatistic();

        // Add values above the established mean
        for (let i = 0; i < 10; i++) {
          cusum.update(150);
        }
        const newStatistic = cusum.getStatistic();

        expect(newStatistic).toBeGreaterThan(baseStatistic);
      });
    });

    describe('isDetected()', () => {
      it('should return false initially', () => {
        expect(cusum.isDetected()).toBe(false);
      });

      it('should return true after change point detected', () => {
        // Force detection with extreme shift
        for (let i = 0; i < 20; i++) {
          cusum.update(100);
        }
        for (let i = 0; i < 50; i++) {
          cusum.update(200);
        }

        expect(cusum.isDetected()).toBe(true);
      });
    });

    describe('reset()', () => {
      it('should reset all state', () => {
        for (let i = 0; i < 50; i++) {
          cusum.update(100 + i);
        }

        cusum.reset();

        const state = cusum.getState();
        expect(state.n).toBe(0);
        expect(state.sumX).toBe(0);
        expect(state.sumX2).toBe(0);
        expect(state.maxStatistic).toBe(0);
        expect(state.changePointIndex).toBeNull();
        expect(state.lastValue).toBeNull();
      });
    });

    describe('serialization', () => {
      it('should serialize and deserialize correctly', () => {
        for (let i = 0; i < 20; i++) {
          cusum.update(100 + Math.random() * 10);
        }

        const serialized = cusum.serialize();
        const restored = FocusCusum.deserialize(serialized, 5.0);

        expect(restored.getState()).toEqual(cusum.getState());
        expect(restored.getStatistic()).toBe(cusum.getStatistic());
      });

      it('should restore from state object', () => {
        for (let i = 0; i < 20; i++) {
          cusum.update(100);
        }

        const state = cusum.getState();
        const restored = FocusCusum.fromState(state, 5.0);

        expect(restored.getState()).toEqual(state);
      });
    });

    describe('pre-change mean parameter', () => {
      it('should use pre-change mean when provided', () => {
        const cusumWithMean = new FocusCusum(5.0, 100);

        // Values above pre-change mean should accumulate positive statistic
        for (let i = 0; i < 20; i++) {
          cusumWithMean.update(110);
        }

        expect(cusumWithMean.getStatistic()).toBeGreaterThan(0);
      });
    });
  });

  describe('computeChangePointScore()', () => {
    it('should return 0 for statistic of 0', () => {
      expect(computeChangePointScore(0, 5.0)).toBe(0);
    });

    it('should return 1 for statistic at threshold', () => {
      expect(computeChangePointScore(5.0, 5.0)).toBe(1);
    });

    it('should cap at 1 for statistic above threshold', () => {
      expect(computeChangePointScore(10.0, 5.0)).toBe(1);
    });

    it('should scale linearly between 0 and threshold', () => {
      expect(computeChangePointScore(2.5, 5.0)).toBeCloseTo(0.5, 5);
      expect(computeChangePointScore(1.0, 5.0)).toBeCloseTo(0.2, 5);
    });

    it('should clamp negative values to 0', () => {
      expect(computeChangePointScore(-1, 5.0)).toBe(0);
    });
  });

  describe('detectRegimeShift()', () => {
    it('should return none when lastValue is null', () => {
      expect(detectRegimeShift(5, null, 100)).toBe('none');
    });

    it('should return none when historicalMean is null', () => {
      expect(detectRegimeShift(5, 150, null)).toBe('none');
    });

    it('should return none when statistic is low', () => {
      expect(detectRegimeShift(1, 150, 100)).toBe('none');
    });

    it('should detect increase when value > historical mean', () => {
      expect(detectRegimeShift(5, 150, 100)).toBe('increase');
    });

    it('should detect decrease when value < historical mean', () => {
      expect(detectRegimeShift(5, 50, 100)).toBe('decrease');
    });
  });

  describe('Real-world scenarios', () => {
    it('should detect sudden volume increase in trading', () => {
      // Use pre-change mean for more predictable behavior
      const cusum = new FocusCusum(5.0, 100);

      // Sudden large trades: ~$500 per trade (5x the mean)
      let detectedAt = -1;
      for (let i = 0; i < 50; i++) {
        const result = cusum.update(500);
        if (result.detected && detectedAt === -1) {
          detectedAt = i;
        }
      }

      expect(cusum.isDetected()).toBe(true);
      // Should detect quickly when values are 5x the expected mean
      expect(detectedAt).toBeLessThan(20);
    });

    it('should handle gradual drift scenario', () => {
      const cusum = new FocusCusum(10.0); // Higher threshold

      // Gradual increase over time
      for (let i = 0; i < 200; i++) {
        cusum.update(100 + i * 0.5);
      }

      // CUSUM should eventually detect the drift
      // The algorithm is designed to detect mean shifts
      expect(cusum.getStatistic()).toBeGreaterThan(0);
    });

    it('should detect spread regime change', () => {
      // Use pre-change mean for predictable behavior
      const cusum = new FocusCusum(5.0, 0.01);

      // Spread widens: ~5% (5x the expected mean)
      let detected = false;
      for (let i = 0; i < 30; i++) {
        const result = cusum.update(0.05);
        if (result.detected) {
          detected = true;
          break;
        }
      }

      expect(detected).toBe(true);
    });
  });
});

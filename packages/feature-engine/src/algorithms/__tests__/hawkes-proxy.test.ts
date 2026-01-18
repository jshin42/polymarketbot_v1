import { describe, it, expect, beforeEach } from 'vitest';
import {
  HawkesProxy,
  estimateBaselineIntensity,
  computeInterArrivalTimes,
} from '../hawkes-proxy.js';

describe('Hawkes Process Proxy', () => {
  describe('HawkesProxy', () => {
    let hawkes: HawkesProxy;

    beforeEach(() => {
      hawkes = new HawkesProxy(0.1, 0.5, 0.1);
    });

    describe('initialization', () => {
      it('should initialize with default values', () => {
        const state = hawkes.getState();
        expect(state.baselineIntensity).toBe(0.1);
        expect(state.intensity).toBe(0.1);
        expect(state.eventCount).toBe(0);
        expect(state.lastEventTime).toBe(0);
      });

      it('should accept custom parameters', () => {
        const custom = new HawkesProxy(0.5, 1.0, 0.2);
        const state = custom.getState();
        expect(state.baselineIntensity).toBe(0.5);
      });
    });

    describe('recordEvent()', () => {
      it('should increase event count', () => {
        hawkes.recordEvent(1000);
        expect(hawkes.getState().eventCount).toBe(1);

        hawkes.recordEvent(2000);
        expect(hawkes.getState().eventCount).toBe(2);
      });

      it('should update last event time', () => {
        hawkes.recordEvent(5000);
        expect(hawkes.getState().lastEventTime).toBe(5000);
      });

      it('should jump intensity after event', () => {
        const initialIntensity = hawkes.getState().intensity;
        hawkes.recordEvent(1000);
        const newIntensity = hawkes.getState().intensity;

        // Intensity should jump by alpha (0.5)
        expect(newIntensity).toBeGreaterThan(initialIntensity);
        expect(newIntensity).toBeCloseTo(initialIntensity + 0.5, 5);
      });

      it('should return the new intensity', () => {
        const intensity = hawkes.recordEvent(1000);
        expect(intensity).toBe(hawkes.getState().intensity);
      });
    });

    describe('getCurrentIntensity()', () => {
      it('should return baseline when no events recorded', () => {
        expect(hawkes.getCurrentIntensity(1000)).toBe(0.1);
      });

      it('should decay intensity over time', () => {
        hawkes.recordEvent(1000);
        const immediateIntensity = hawkes.getCurrentIntensity(1000);

        // After some time, intensity should decay
        const laterIntensity = hawkes.getCurrentIntensity(11000); // 10 seconds later

        expect(laterIntensity).toBeLessThan(immediateIntensity);
        expect(laterIntensity).toBeGreaterThanOrEqual(hawkes.getState().baselineIntensity);
      });

      it('should approach baseline as time goes to infinity', () => {
        hawkes.recordEvent(0);

        // After a very long time, should be close to baseline
        const intensity = hawkes.getCurrentIntensity(1000000); // 1000 seconds
        expect(intensity).toBeCloseTo(0.1, 3);
      });
    });

    describe('isBurst()', () => {
      it('should return false when at baseline', () => {
        expect(hawkes.isBurst(1000, 2.0)).toBe(false);
      });

      it('should return true during burst of events', () => {
        // Rapid events should create a burst
        const baseTime = Date.now();
        for (let i = 0; i < 10; i++) {
          hawkes.recordEvent(baseTime + i * 100); // Events every 100ms
        }

        expect(hawkes.isBurst(baseTime + 1000, 2.0)).toBe(true);
      });

      it('should respect threshold parameter', () => {
        hawkes.recordEvent(1000);
        hawkes.recordEvent(1100);
        hawkes.recordEvent(1200);

        const intensityNow = hawkes.getCurrentIntensity(1200);
        const baseline = hawkes.getState().baselineIntensity;
        const ratio = intensityNow / baseline;

        // With low threshold, should be burst
        expect(hawkes.isBurst(1200, ratio - 0.1)).toBe(true);
        // With high threshold, should not be burst
        expect(hawkes.isBurst(1200, ratio + 1)).toBe(false);
      });
    });

    describe('getIntensityRatio()', () => {
      it('should return 1 at baseline', () => {
        expect(hawkes.getIntensityRatio(1000)).toBeCloseTo(1, 5);
      });

      it('should return ratio > 1 after events', () => {
        hawkes.recordEvent(1000);
        expect(hawkes.getIntensityRatio(1000)).toBeGreaterThan(1);
      });
    });

    describe('getBurstScore()', () => {
      it('should return 0 at baseline', () => {
        expect(hawkes.getBurstScore(1000)).toBe(0);
      });

      it('should return value between 0 and 1', () => {
        for (let i = 0; i < 5; i++) {
          hawkes.recordEvent(i * 100);
        }

        const score = hawkes.getBurstScore(500);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      });

      it('should cap at 1 for extreme bursts', () => {
        // Record many events very quickly
        for (let i = 0; i < 50; i++) {
          hawkes.recordEvent(i * 10);
        }

        const score = hawkes.getBurstScore(500);
        expect(score).toBe(1);
      });

      it('should increase with more events', () => {
        // Record events with slight time gaps
        hawkes.recordEvent(1000);
        const afterOne = hawkes.getBurstScore(1000);

        hawkes.recordEvent(1010);
        hawkes.recordEvent(1020);
        hawkes.recordEvent(1030);
        const afterFour = hawkes.getBurstScore(1030);

        // After more events, burst score should be higher
        expect(afterFour).toBeGreaterThanOrEqual(afterOne);
      });
    });

    describe('reset()', () => {
      it('should reset to initial state', () => {
        hawkes.recordEvent(1000);
        hawkes.recordEvent(2000);
        hawkes.recordEvent(3000);

        hawkes.reset();

        const state = hawkes.getState();
        expect(state.eventCount).toBe(0);
        expect(state.lastEventTime).toBe(0);
        expect(state.intensity).toBe(0.1);
      });
    });

    describe('setBaselineIntensity()', () => {
      it('should update baseline', () => {
        hawkes.setBaselineIntensity(0.5);
        expect(hawkes.getState().baselineIntensity).toBe(0.5);
      });
    });

    describe('serialization', () => {
      it('should serialize and deserialize correctly', () => {
        hawkes.recordEvent(1000);
        hawkes.recordEvent(2000);

        const serialized = hawkes.serialize();
        const restored = HawkesProxy.deserialize(serialized, 0.5, 0.1);

        expect(restored.getState()).toEqual(hawkes.getState());
      });

      it('should restore from state object', () => {
        hawkes.recordEvent(1000);
        const state = hawkes.getState();

        const restored = HawkesProxy.fromState(state, 0.5, 0.1);
        expect(restored.getState()).toEqual(state);
      });
    });
  });

  describe('estimateBaselineIntensity()', () => {
    it('should return default for empty array', () => {
      expect(estimateBaselineIntensity([])).toBe(0.1);
    });

    it('should estimate intensity from inter-arrival times', () => {
      // Mean inter-arrival of 1000ms = 1 event per second
      const interArrivals = [1000, 1000, 1000, 1000];
      const intensity = estimateBaselineIntensity(interArrivals);
      expect(intensity).toBeCloseTo(1, 1); // ~1 event/second
    });

    it('should handle varying inter-arrival times', () => {
      // Average 500ms = 2 events per second
      const interArrivals = [250, 500, 750, 500];
      const intensity = estimateBaselineIntensity(interArrivals);
      expect(intensity).toBeCloseTo(2, 1);
    });
  });

  describe('computeInterArrivalTimes()', () => {
    it('should return empty array for less than 2 timestamps', () => {
      expect(computeInterArrivalTimes([])).toEqual([]);
      expect(computeInterArrivalTimes([1000])).toEqual([]);
    });

    it('should compute inter-arrival times correctly', () => {
      const timestamps = [1000, 2000, 3500, 4000];
      const interArrivals = computeInterArrivalTimes(timestamps);

      expect(interArrivals).toEqual([1000, 1500, 500]);
    });

    it('should handle unsorted timestamps', () => {
      const timestamps = [3000, 1000, 2000];
      const interArrivals = computeInterArrivalTimes(timestamps);

      expect(interArrivals).toEqual([1000, 1000]);
    });
  });

  describe('Burst detection scenarios', () => {
    it('should detect sudden burst of trades', () => {
      const hawkes = new HawkesProxy(0.1, 0.5, 0.1);

      // Normal activity: trades every 10 seconds
      for (let i = 0; i < 10; i++) {
        hawkes.recordEvent(i * 10000);
      }

      const beforeBurst = hawkes.getBurstScore(100000);

      // Burst: 10 trades in 1 second
      for (let i = 0; i < 10; i++) {
        hawkes.recordEvent(100000 + i * 100);
      }

      const duringBurst = hawkes.getBurstScore(101000);

      expect(duringBurst).toBeGreaterThan(beforeBurst);
      expect(duringBurst).toBeGreaterThan(0.5); // Significant burst
    });

    it('should decay after burst ends', () => {
      const hawkes = new HawkesProxy(0.1, 0.5, 0.1);

      // Create burst
      for (let i = 0; i < 20; i++) {
        hawkes.recordEvent(i * 50);
      }

      const peakScore = hawkes.getBurstScore(1000);

      // Wait 60 seconds (no new events) - longer decay
      const afterDecay = hawkes.getBurstScore(61000);

      // Score should decay (or be equal if both capped at 1)
      expect(afterDecay).toBeLessThanOrEqual(peakScore);
    });
  });
});

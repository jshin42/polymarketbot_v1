import { describe, it, expect } from 'vitest';
import { computeExecutionScore } from '../execution-score.js';
import type { FeatureVector } from '@polymarketbot/shared';

// Helper to create a base feature vector
function createBaseFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  const base: FeatureVector = {
    tokenId: 'test_token',
    conditionId: 'test_condition',
    timestamp: Date.now(),

    timeToClose: {
      ttcSeconds: 600,
      ttcMinutes: 10,
      ttcHours: 0.167,
      inNoTradeZone: false,
      rampMultiplier: 1.0,
    },

    orderbook: {
      bidDepth: 5000,
      askDepth: 5000,
      imbalance: 0,
      imbalanceAbs: 0,
      bookImbalanceScore: 0,
      thinOppositeScore: 0,
      spreadBps: 100,
      midPrice: 0.55,
    },

    tradeSize: {
      sizeUsd: 100,
      sizeMedian: 100,
      sizeMad: 20,
      robustZScore: 0,
      percentile: 50,
      sizeTailScore: 0,
      isLargeTrade: false,
    },

    wallet: {
      walletAge: 90,
      walletNewScore: 0.3,
      walletActivityScore: 0.2,
    },

    impact: {
      impact30s: 0,
      impact60s: 0,
      impactScore: 0,
    },

    burst: {
      tradeRate: 1,
      burstIntensity: 0.1,
      burstScore: 0,
      burstDetected: false,
    },

    changePoint: {
      cusumStatistic: 0,
      changePointScore: 0,
      changePointDetected: false,
      regimeShift: null,
    },
  };

  return { ...base, ...overrides };
}

describe('Execution Score Computation', () => {
  describe('computeExecutionScore()', () => {
    describe('basic computation', () => {
      it('should return a valid ExecutionScore object', () => {
        const features = createBaseFeatures();
        const result = computeExecutionScore(features);

        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('depthScore');
        expect(result).toHaveProperty('spreadScore');
        expect(result).toHaveProperty('volatilityScore');
        expect(result).toHaveProperty('timeScore');
        expect(result).toHaveProperty('spreadPenalty');
        expect(result).toHaveProperty('slippagePenalty');
        expect(result).toHaveProperty('slippageEstimateBps');
        expect(result).toHaveProperty('fillProbability');
        expect(result).toHaveProperty('depthAtLimit');
      });

      it('should return score between 0 and 1', () => {
        const features = createBaseFeatures();
        const result = computeExecutionScore(features);

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });

      it('should return high score for good execution conditions', () => {
        // Tight spread, deep book, low volatility
        const features = createBaseFeatures({
          orderbook: {
            bidDepth: 10000,
            askDepth: 10000,
            imbalance: 0,
            imbalanceAbs: 0,
            bookImbalanceScore: 0,
            thinOppositeScore: 0,
            spreadBps: 20, // Very tight
            midPrice: 0.55,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.score).toBeGreaterThan(0.7);
      });
    });

    describe('spread penalty', () => {
      it('should have no penalty for tight spread', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            spreadBps: 10, // At or below min (10 bps)
          },
        });

        const result = computeExecutionScore(features);
        expect(result.spreadPenalty).toBe(0);
        expect(result.spreadScore).toBe(1);
      });

      it('should have max penalty for wide spread', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            spreadBps: 500, // At or above max (500 bps)
          },
        });

        const result = computeExecutionScore(features);
        expect(result.spreadPenalty).toBe(1);
        expect(result.spreadScore).toBe(0);
      });

      it('should scale linearly between min and max spread', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            spreadBps: 255, // Midpoint between 10 and 500
          },
        });

        const result = computeExecutionScore(features);
        expect(result.spreadPenalty).toBeGreaterThan(0.4);
        expect(result.spreadPenalty).toBeLessThan(0.6);
      });
    });

    describe('depth/liquidity score', () => {
      it('should score high for deep liquidity', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 10000,
            askDepth: 10000,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.depthScore).toBeGreaterThan(0.9);
      });

      it('should score low for thin liquidity', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 50,
            askDepth: 50,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.depthScore).toBeLessThan(0.5);
      });

      it('should use minimum of bid/ask depth', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 10000,
            askDepth: 100, // Thin asks
          },
        });

        const result = computeExecutionScore(features, 100);
        // Should be based on the thin ask side
        expect(result.depthAtLimit).toBe(100);
      });

      it('should consider target size in liquidity score', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 500,
            askDepth: 500,
          },
        });

        // Small target size should get better score
        const smallResult = computeExecutionScore(features, 50);
        const largeResult = computeExecutionScore(features, 500);

        expect(smallResult.depthScore).toBeGreaterThan(largeResult.depthScore);
      });
    });

    describe('volatility penalty', () => {
      it('should penalize high imbalance', () => {
        const lowImbalance = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalanceAbs: 0.1,
            spreadBps: 100,
          },
        });

        const highImbalance = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalanceAbs: 0.9,
            spreadBps: 100,
          },
        });

        const lowResult = computeExecutionScore(lowImbalance);
        const highResult = computeExecutionScore(highImbalance);

        expect(highResult.volatilityScore).toBeLessThan(lowResult.volatilityScore);
      });

      it('should factor in spread to volatility', () => {
        const tightSpread = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            spreadBps: 50,
            imbalanceAbs: 0.3,
          },
        });

        const wideSpread = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            spreadBps: 400,
            imbalanceAbs: 0.3,
          },
        });

        const tightResult = computeExecutionScore(tightSpread);
        const wideResult = computeExecutionScore(wideSpread);

        expect(wideResult.volatilityScore).toBeLessThan(tightResult.volatilityScore);
      });
    });

    describe('time score', () => {
      it('should have full time score far from close', () => {
        const features = createBaseFeatures({
          timeToClose: {
            ...createBaseFeatures().timeToClose,
            rampMultiplier: 1.0,
          },
        });

        const result = computeExecutionScore(features);
        expect(result.timeScore).toBe(1);
        expect(result.timePenalty).toBe(0);
      });

      it('should have reduced time score near close', () => {
        const features = createBaseFeatures({
          timeToClose: {
            ...createBaseFeatures().timeToClose,
            rampMultiplier: 2.0, // Higher ramp near close
          },
        });

        const result = computeExecutionScore(features);
        expect(result.timeScore).toBe(0.5); // 1 / 2.0
        expect(result.timePenalty).toBe(0.5);
      });
    });

    describe('slippage estimation', () => {
      it('should estimate low slippage for deep book', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 10000,
            askDepth: 10000,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.slippageEstimateBps).toBeLessThan(50);
      });

      it('should estimate high slippage for thin book', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 100,
            askDepth: 100,
          },
        });

        const result = computeExecutionScore(features, 500);
        expect(result.slippageEstimateBps).toBeGreaterThan(100);
      });

      it('should cap slippage at maximum', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 10,
            askDepth: 10,
          },
        });

        const result = computeExecutionScore(features, 10000);
        expect(result.slippageEstimateBps).toBeLessThanOrEqual(1000); // 10%
      });
    });

    describe('fill probability', () => {
      it('should have high fill probability for good conditions', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 10000,
            askDepth: 10000,
            spreadBps: 20,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.fillProbability).toBeGreaterThan(0.9);
      });

      it('should have low fill probability for poor conditions', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bidDepth: 50,
            askDepth: 50,
            spreadBps: 400,
          },
        });

        const result = computeExecutionScore(features, 100);
        expect(result.fillProbability).toBeLessThan(0.5);
      });
    });
  });

  describe('Real-world scenarios', () => {
    it('should score high for liquid, stable market', () => {
      const features = createBaseFeatures({
        orderbook: {
          bidDepth: 50000,
          askDepth: 48000,
          imbalance: 0.02,
          imbalanceAbs: 0.02,
          bookImbalanceScore: 0.1,
          thinOppositeScore: 0.1,
          spreadBps: 30,
          midPrice: 0.50,
        },
        timeToClose: {
          ttcSeconds: 3600,
          ttcMinutes: 60,
          ttcHours: 1,
          inNoTradeZone: false,
          rampMultiplier: 1.0,
        },
      });

      const result = computeExecutionScore(features, 1000);
      expect(result.score).toBeGreaterThan(0.75);
    });

    it('should score low for illiquid, volatile market', () => {
      const features = createBaseFeatures({
        orderbook: {
          bidDepth: 200,
          askDepth: 100,
          imbalance: 0.33,
          imbalanceAbs: 0.33,
          bookImbalanceScore: 0.5,
          thinOppositeScore: 0.6,
          spreadBps: 350,
          midPrice: 0.55,
        },
        timeToClose: {
          ttcSeconds: 180,
          ttcMinutes: 3,
          ttcHours: 0.05,
          inNoTradeZone: false,
          rampMultiplier: 1.8,
        },
      });

      const result = computeExecutionScore(features, 500);
      expect(result.score).toBeLessThan(0.5);
    });

    it('should warn about execution near market close', () => {
      const features = createBaseFeatures({
        orderbook: {
          ...createBaseFeatures().orderbook,
          spreadBps: 50,
          bidDepth: 5000,
          askDepth: 5000,
        },
        timeToClose: {
          ttcSeconds: 150,
          ttcMinutes: 2.5,
          ttcHours: 0.04,
          inNoTradeZone: false,
          rampMultiplier: 3.0, // Very high near close
        },
      });

      const result = computeExecutionScore(features);
      expect(result.timeScore).toBeLessThan(0.5);
      expect(result.timePenalty).toBeGreaterThan(0.5);
    });
  });
});

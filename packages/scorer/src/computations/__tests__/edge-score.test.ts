import { describe, it, expect } from 'vitest';
import { computeEdgeScore, determineTradeDirection } from '../edge-score.js';
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
      isNewAccount: false,
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

describe('Edge Score Computation', () => {
  describe('computeEdgeScore()', () => {
    describe('basic computation', () => {
      it('should return a valid EdgeScore object', () => {
        const features = createBaseFeatures();
        const result = computeEdgeScore(features, 0.5, 0.7, 0.55);

        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('impliedProbability');
        expect(result).toHaveProperty('estimatedProbability');
        expect(result).toHaveProperty('edge');
        expect(result).toHaveProperty('edgeAbs');
        expect(result).toHaveProperty('edgePct');
        expect(result).toHaveProperty('edgeConfidence');
        expect(result).toHaveProperty('alignedSignals');
      });

      it('should return score between 0 and 1', () => {
        const features = createBaseFeatures();
        const result = computeEdgeScore(features, 0.5, 0.7, 0.55);

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });

      it('should use current mid as implied probability', () => {
        const features = createBaseFeatures();
        const result = computeEdgeScore(features, 0.5, 0.7, 0.55);

        expect(result.impliedProbability).toBe(0.55);
      });
    });

    describe('probability adjustment', () => {
      it('should adjust probability with large trade signals', () => {
        const features = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: 0.5, // Positive imbalance = buying pressure
          },
        });

        const result = computeEdgeScore(features, 0.8, 0.7, 0.50);

        // With large trade and positive imbalance, should estimate higher probability
        expect(result.estimatedProbability).toBeGreaterThan(result.impliedProbability);
        expect(result.edge).toBeGreaterThan(0);
      });

      it('should adjust probability with order book imbalance', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: 0.5,
            imbalanceAbs: 0.5,
          },
        });

        const result = computeEdgeScore(features, 0.5, 0.7, 0.50);

        // Positive imbalance should increase estimated probability
        expect(result.estimatedProbability).toBeGreaterThan(0.50);
      });

      it('should adjust negatively with selling pressure', () => {
        const features = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: -0.5, // Negative = selling pressure
            imbalanceAbs: 0.5,
          },
        });

        const result = computeEdgeScore(features, 0.5, 0.7, 0.50);

        // Negative imbalance should decrease estimated probability
        expect(result.estimatedProbability).toBeLessThan(0.50);
        expect(result.edge).toBeLessThan(0);
      });

      it('should amplify with new wallet + large trade', () => {
        const withoutNewWallet = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          wallet: {
            walletAge: 365,
            walletNewScore: 0,
            walletActivityScore: 0.1,
            isNewAccount: false,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: 0.3,
            imbalanceAbs: 0.3,
          },
        });

        const withNewWallet = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          wallet: {
            walletAge: 2,
            walletNewScore: 1.0,
            walletActivityScore: 0.9,
            isNewAccount: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: 0.3,
            imbalanceAbs: 0.3,
          },
        });

        const oldResult = computeEdgeScore(withoutNewWallet, 0.8, 0.7, 0.50);
        const newResult = computeEdgeScore(withNewWallet, 0.8, 0.7, 0.50);

        // New wallet with large trade should have larger edge
        expect(newResult.edgeAbs).toBeGreaterThan(oldResult.edgeAbs);
      });
    });

    describe('probability bounds', () => {
      it('should bound estimated probability to 0.01-0.99', () => {
        // Extreme positive signals
        const extremePositive = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: 1.0,
            imbalanceAbs: 1.0,
          },
          wallet: {
            walletAge: 1,
            walletNewScore: 1.0,
            walletActivityScore: 1.0,
            isNewAccount: true,
          },
        });

        const result = computeEdgeScore(extremePositive, 1.0, 1.0, 0.95);

        expect(result.estimatedProbability).toBeLessThanOrEqual(0.99);
        expect(result.estimatedProbability).toBeGreaterThanOrEqual(0.01);
      });

      it('should bound probability for extreme negative signals', () => {
        const extremeNegative = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalance: -1.0,
            imbalanceAbs: 1.0,
          },
          wallet: {
            walletAge: 1,
            walletNewScore: 1.0,
            walletActivityScore: 1.0,
            isNewAccount: true,
          },
        });

        const result = computeEdgeScore(extremeNegative, 1.0, 1.0, 0.05);

        expect(result.estimatedProbability).toBeLessThanOrEqual(0.99);
        expect(result.estimatedProbability).toBeGreaterThanOrEqual(0.01);
      });
    });

    describe('edge confidence', () => {
      it('should have low confidence with no aligned signals', () => {
        const features = createBaseFeatures();
        const result = computeEdgeScore(features, 0.3, 0.7, 0.50);

        expect(result.alignedSignals).toBe(0);
        expect(result.edgeConfidence).toBe(0.2); // Base confidence
      });

      it('should increase confidence with aligned signals', () => {
        const features = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalanceAbs: 0.5,
          },
          burst: {
            ...createBaseFeatures().burst,
            burstDetected: true,
          },
          changePoint: {
            ...createBaseFeatures().changePoint,
            changePointDetected: true,
          },
          wallet: {
            walletAge: 2,
            walletNewScore: 1.0,
            walletActivityScore: 0.9,
            isNewAccount: true,
          },
        });

        const result = computeEdgeScore(features, 0.8, 0.7, 0.50);

        expect(result.alignedSignals).toBe(5); // All 5 signals
        expect(result.edgeConfidence).toBeGreaterThan(0.5);
        expect(result.edgeConfidence).toBeLessThanOrEqual(0.9); // Capped
      });

      it('should count signals correctly', () => {
        // Only large trade and burst
        const features = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          burst: {
            ...createBaseFeatures().burst,
            burstDetected: true,
          },
        });

        const result = computeEdgeScore(features, 0.6, 0.7, 0.50);
        expect(result.alignedSignals).toBe(2);
      });
    });

    describe('execution score factor', () => {
      it('should reduce edge score with poor execution', () => {
        const features = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            imbalanceAbs: 0.5,
          },
        });

        const highExecResult = computeEdgeScore(features, 0.8, 0.9, 0.50);
        const lowExecResult = computeEdgeScore(features, 0.8, 0.3, 0.50);

        expect(highExecResult.score).toBeGreaterThan(lowExecResult.score);
      });
    });
  });

  describe('determineTradeDirection()', () => {
    it('should return BUY for positive imbalance above threshold', () => {
      const features = createBaseFeatures({
        orderbook: {
          ...createBaseFeatures().orderbook,
          imbalance: 0.4, // Positive = more bids = buying pressure
          imbalanceAbs: 0.4,
        },
      });

      expect(determineTradeDirection(features)).toBe('BUY');
    });

    it('should return SELL for negative imbalance above threshold', () => {
      const features = createBaseFeatures({
        orderbook: {
          ...createBaseFeatures().orderbook,
          imbalance: -0.4, // Negative = more asks = selling pressure
          imbalanceAbs: 0.4,
        },
      });

      expect(determineTradeDirection(features)).toBe('SELL');
    });

    it('should return null when imbalance below threshold', () => {
      const features = createBaseFeatures({
        orderbook: {
          ...createBaseFeatures().orderbook,
          imbalance: 0.1,
          imbalanceAbs: 0.1, // Below 0.2 threshold
        },
      });

      expect(determineTradeDirection(features)).toBeNull();
    });

    it('should return null for balanced book', () => {
      const features = createBaseFeatures();
      expect(determineTradeDirection(features)).toBeNull();
    });
  });

  describe('Real-world scenarios', () => {
    it('should identify edge in suspected insider scenario', () => {
      // Large trade from new wallet with book imbalance
      const features = createBaseFeatures({
        tradeSize: {
          sizeUsd: 50000,
          sizeMedian: 100,
          sizeMad: 50,
          robustZScore: 5,
          percentile: 99.5,
          sizeTailScore: 0.98,
          isLargeTrade: true,
        },
        orderbook: {
          bidDepth: 3000,
          askDepth: 800,
          imbalance: 0.58,
          imbalanceAbs: 0.58,
          bookImbalanceScore: 0.8,
          thinOppositeScore: 0.85,
          spreadBps: 100,
          midPrice: 0.55,
        },
        wallet: {
          walletAge: 2,
          walletNewScore: 1.0,
          walletActivityScore: 0.95,
          isNewAccount: true,
        },
        burst: {
          tradeRate: 5,
          burstIntensity: 3,
          burstScore: 0.6,
          burstDetected: true,
        },
        changePoint: {
          cusumStatistic: 8,
          changePointScore: 0.7,
          changePointDetected: true,
          regimeShift: 'increase',
        },
      });

      const result = computeEdgeScore(features, 0.9, 0.8, 0.55);

      expect(result.alignedSignals).toBe(5);
      expect(result.edgeConfidence).toBeGreaterThan(0.7);
      expect(result.edge).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(0.3);
      expect(determineTradeDirection(features)).toBe('BUY');
    });

    it('should show minimal edge for normal retail activity', () => {
      const features = createBaseFeatures({
        tradeSize: {
          sizeUsd: 75,
          sizeMedian: 100,
          sizeMad: 30,
          robustZScore: -0.5,
          percentile: 35,
          sizeTailScore: 0.18,
          isLargeTrade: false,
        },
        orderbook: {
          bidDepth: 5000,
          askDepth: 4800,
          imbalance: 0.02,
          imbalanceAbs: 0.02,
          bookImbalanceScore: 0.1,
          thinOppositeScore: 0.1,
          spreadBps: 50,
          midPrice: 0.50,
        },
      });

      const result = computeEdgeScore(features, 0.2, 0.8, 0.50);

      expect(result.alignedSignals).toBe(0);
      expect(result.edgeConfidence).toBe(0.2);
      expect(Math.abs(result.edge)).toBeLessThan(0.03);
      expect(determineTradeDirection(features)).toBeNull();
    });

    it('should calculate edge percentage correctly', () => {
      const features = createBaseFeatures({
        tradeSize: {
          ...createBaseFeatures().tradeSize!,
          isLargeTrade: true,
        },
        orderbook: {
          ...createBaseFeatures().orderbook,
          imbalance: 0.4,
          imbalanceAbs: 0.4,
        },
      });

      const result = computeEdgeScore(features, 0.7, 0.8, 0.50);

      // edgePct = (edge / implied) * 100
      const expectedPct = (result.edge / result.impliedProbability) * 100;
      expect(result.edgePct).toBeCloseTo(expectedPct, 2);
    });
  });
});

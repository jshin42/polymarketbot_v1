import { describe, it, expect } from 'vitest';
import { computeAnomalyScore } from '../anomaly-score.js';
import type { FeatureVector } from '@polymarketbot/shared';

// Helper to create a base feature vector with all required fields
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

describe('Anomaly Score Computation', () => {
  describe('computeAnomalyScore()', () => {
    describe('basic computation', () => {
      it('should return a valid AnomalyScore object', () => {
        const features = createBaseFeatures();
        const result = computeAnomalyScore(features);

        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('components');
        expect(result).toHaveProperty('coreScore');
        expect(result).toHaveProperty('contextScore');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('triggered');
        expect(result).toHaveProperty('tripleSignal');
      });

      it('should return score between 0 and 1', () => {
        const features = createBaseFeatures();
        const result = computeAnomalyScore(features);

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      });

      it('should return low score for normal trading activity', () => {
        const features = createBaseFeatures();
        const result = computeAnomalyScore(features);

        expect(result.score).toBeLessThan(0.3);
        expect(result.triggered).toBe(false);
      });
    });

    describe('trade size component (35% weight)', () => {
      it('should increase score with high sizeTailScore', () => {
        const normalFeatures = createBaseFeatures();
        const normalResult = computeAnomalyScore(normalFeatures);

        const highSizeFeatures = createBaseFeatures({
          tradeSize: {
            ...normalFeatures.tradeSize!,
            sizeTailScore: 0.95,
            isLargeTrade: true,
          },
        });
        const highSizeResult = computeAnomalyScore(highSizeFeatures);

        expect(highSizeResult.score).toBeGreaterThan(normalResult.score);
        expect(highSizeResult.components.tradeSizeComponent).toBe(0.95);
      });

      it('should handle missing tradeSize gracefully', () => {
        const features = createBaseFeatures();
        features.tradeSize = undefined;

        const result = computeAnomalyScore(features);
        expect(result.components.tradeSizeComponent).toBe(0);
      });
    });

    describe('orderbook component (30% weight)', () => {
      it('should increase score with high book imbalance', () => {
        const normalFeatures = createBaseFeatures();
        const normalResult = computeAnomalyScore(normalFeatures);

        const imbalancedFeatures = createBaseFeatures({
          orderbook: {
            ...normalFeatures.orderbook,
            bookImbalanceScore: 0.9,
            thinOppositeScore: 0.8,
          },
        });
        const imbalancedResult = computeAnomalyScore(imbalancedFeatures);

        expect(imbalancedResult.score).toBeGreaterThan(normalResult.score);
        expect(imbalancedResult.components.orderbookComponent).toBeGreaterThan(0.5);
      });

      it('should weight imbalance (60%) more than thin opposite (40%)', () => {
        // High imbalance, low thin
        const highImbalance = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bookImbalanceScore: 1.0,
            thinOppositeScore: 0,
          },
        });

        // Low imbalance, high thin
        const highThin = createBaseFeatures({
          orderbook: {
            ...createBaseFeatures().orderbook,
            bookImbalanceScore: 0,
            thinOppositeScore: 1.0,
          },
        });

        const imbalanceResult = computeAnomalyScore(highImbalance);
        const thinResult = computeAnomalyScore(highThin);

        // Orderbook component = 0.6 * imbalance + 0.4 * thin
        expect(imbalanceResult.components.orderbookComponent).toBeCloseTo(0.6, 5);
        expect(thinResult.components.orderbookComponent).toBeCloseTo(0.4, 5);
      });
    });

    describe('wallet component (20% weight)', () => {
      it('should increase score with new wallet', () => {
        const normalFeatures = createBaseFeatures();
        const normalResult = computeAnomalyScore(normalFeatures);

        const newWalletFeatures = createBaseFeatures({
          wallet: {
            walletAge: 3,
            walletNewScore: 1.0,
            walletActivityScore: 0.9,
          },
        });
        const newWalletResult = computeAnomalyScore(newWalletFeatures);

        expect(newWalletResult.score).toBeGreaterThan(normalResult.score);
        expect(newWalletResult.components.walletComponent).toBe(1.0);
      });

      it('should handle missing wallet gracefully', () => {
        const features = createBaseFeatures();
        features.wallet = undefined;

        const result = computeAnomalyScore(features);
        expect(result.components.walletComponent).toBe(0);
      });
    });

    describe('context score (burst and change point)', () => {
      it('should include burst score in context', () => {
        const features = createBaseFeatures({
          burst: {
            tradeRate: 10,
            burstIntensity: 5,
            burstScore: 0.8,
            burstDetected: true,
          },
        });

        const result = computeAnomalyScore(features);
        expect(result.contextScore).toBeGreaterThanOrEqual(0.8);
      });

      it('should include change point score in context', () => {
        const features = createBaseFeatures({
          changePoint: {
            cusumStatistic: 10,
            changePointScore: 0.9,
            changePointDetected: true,
            regimeShift: 'increase',
          },
        });

        const result = computeAnomalyScore(features);
        expect(result.contextScore).toBeGreaterThanOrEqual(0.9);
      });

      it('should take max of burst and change point', () => {
        const features = createBaseFeatures({
          burst: {
            tradeRate: 5,
            burstIntensity: 3,
            burstScore: 0.5,
            burstDetected: false,
          },
          changePoint: {
            cusumStatistic: 8,
            changePointScore: 0.8,
            changePointDetected: true,
            regimeShift: 'increase',
          },
        });

        const result = computeAnomalyScore(features);
        expect(result.contextScore).toBe(0.8); // max(0.5, 0.8)
      });
    });

    describe('time ramp multiplier', () => {
      it('should amplify score based on time ramp', () => {
        const baseFeatures = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            sizeTailScore: 0.5,
          },
          timeToClose: {
            ...createBaseFeatures().timeToClose,
            rampMultiplier: 1.0,
          },
        });

        const rampedFeatures = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            sizeTailScore: 0.5,
          },
          timeToClose: {
            ...createBaseFeatures().timeToClose,
            rampMultiplier: 2.0,
          },
        });

        const baseResult = computeAnomalyScore(baseFeatures);
        const rampedResult = computeAnomalyScore(rampedFeatures);

        // Ramped score should be higher but capped at 1
        expect(rampedResult.score).toBeGreaterThanOrEqual(baseResult.score);
      });
    });

    describe('triggered flag', () => {
      it('should trigger when score >= 0.65', () => {
        // Create high-signal features
        const features = createBaseFeatures({
          tradeSize: {
            ...createBaseFeatures().tradeSize!,
            sizeTailScore: 0.95,
            isLargeTrade: true,
          },
          orderbook: {
            ...createBaseFeatures().orderbook,
            bookImbalanceScore: 0.9,
            thinOppositeScore: 0.8,
          },
          wallet: {
            walletAge: 3,
            walletNewScore: 1.0,
            walletActivityScore: 0.9,
          },
          timeToClose: {
            ...createBaseFeatures().timeToClose,
            rampMultiplier: 1.5,
          },
        });

        const result = computeAnomalyScore(features);

        if (result.score >= 0.65) {
          expect(result.triggered).toBe(true);
        } else {
          expect(result.triggered).toBe(false);
        }
      });

      it('should not trigger when score < 0.65', () => {
        const features = createBaseFeatures();
        const result = computeAnomalyScore(features);

        expect(result.score).toBeLessThan(0.65);
        expect(result.triggered).toBe(false);
      });
    });

    describe('confidence calculation', () => {
      it('should have full confidence with all data', () => {
        const features = createBaseFeatures();
        const result = computeAnomalyScore(features);

        // With tradeSize, wallet, impact, orderbook, burst = 5/5
        expect(result.confidence).toBe(1);
      });

      it('should have reduced confidence with missing data', () => {
        const features = createBaseFeatures();
        features.tradeSize = undefined;
        features.wallet = undefined;
        features.impact = undefined;

        const result = computeAnomalyScore(features);

        // Only orderbook + burst = 2/5 = 0.4
        expect(result.confidence).toBe(0.4);
      });
    });
  });

  describe('Triple Signal Detection', () => {
    it('should detect triple signal when all thresholds met', () => {
      const features = createBaseFeatures({
        tradeSize: {
          ...createBaseFeatures().tradeSize!,
          sizeTailScore: 0.95, // >= 0.90
          isLargeTrade: true,
        },
        orderbook: {
          ...createBaseFeatures().orderbook,
          bookImbalanceScore: 0.75, // >= 0.70
          thinOppositeScore: 0.75, // >= 0.70
        },
        wallet: {
          walletAge: 3,
          walletNewScore: 0.85, // >= 0.80
          walletActivityScore: 0.9,
        },
      });

      const result = computeAnomalyScore(features);
      expect(result.tripleSignal).toBe(true);
    });

    it('should not detect triple signal when size below threshold', () => {
      const features = createBaseFeatures({
        tradeSize: {
          ...createBaseFeatures().tradeSize!,
          sizeTailScore: 0.85, // < 0.90
          isLargeTrade: true,
        },
        orderbook: {
          ...createBaseFeatures().orderbook,
          bookImbalanceScore: 0.75,
          thinOppositeScore: 0.75,
        },
        wallet: {
          walletAge: 3,
          walletNewScore: 0.85,
          walletActivityScore: 0.9,
        },
      });

      const result = computeAnomalyScore(features);
      expect(result.tripleSignal).toBe(false);
    });

    it('should not detect triple signal when book imbalance below threshold', () => {
      const features = createBaseFeatures({
        tradeSize: {
          ...createBaseFeatures().tradeSize!,
          sizeTailScore: 0.95,
          isLargeTrade: true,
        },
        orderbook: {
          ...createBaseFeatures().orderbook,
          bookImbalanceScore: 0.65, // < 0.70
          thinOppositeScore: 0.75,
        },
        wallet: {
          walletAge: 3,
          walletNewScore: 0.85,
          walletActivityScore: 0.9,
        },
      });

      const result = computeAnomalyScore(features);
      expect(result.tripleSignal).toBe(false);
    });

    it('should detect triple signal with high wallet activity instead of wallet age', () => {
      const features = createBaseFeatures({
        tradeSize: {
          ...createBaseFeatures().tradeSize!,
          sizeTailScore: 0.95,
          isLargeTrade: true,
        },
        orderbook: {
          ...createBaseFeatures().orderbook,
          bookImbalanceScore: 0.75,
          thinOppositeScore: 0.75,
        },
        wallet: {
          walletAge: 365,
          walletNewScore: 0.0, // Old wallet
          walletActivityScore: 0.75, // >= 0.70 (high activity for this test)
        },
      });

      const result = computeAnomalyScore(features);
      expect(result.tripleSignal).toBe(true);
    });
  });

  describe('Real-world scenarios', () => {
    it('should score high for suspected insider trade', () => {
      // Scenario: New wallet makes large trade with imbalanced book
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
          bidDepth: 2000,
          askDepth: 500, // Thin asks
          imbalance: 0.6,
          imbalanceAbs: 0.6,
          bookImbalanceScore: 0.85,
          thinOppositeScore: 0.9,
          spreadBps: 150,
          midPrice: 0.55,
        },
        wallet: {
          walletAge: 2,
          walletNewScore: 1.0,
          walletActivityScore: 0.95,
        },
        burst: {
          tradeRate: 5,
          burstIntensity: 3,
          burstScore: 0.6,
          burstDetected: true,
        },
        timeToClose: {
          ttcSeconds: 300,
          ttcMinutes: 5,
          ttcHours: 0.083,
          inNoTradeZone: false,
          rampMultiplier: 1.5,
        },
      });

      const result = computeAnomalyScore(features);

      expect(result.score).toBeGreaterThan(0.5);
      expect(result.tripleSignal).toBe(true);
    });

    it('should score low for normal retail activity', () => {
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
        wallet: {
          walletAge: 200,
          walletNewScore: 0.0,
          walletActivityScore: 0.1,
        },
        burst: {
          tradeRate: 1,
          burstIntensity: 0.5,
          burstScore: 0.1,
          burstDetected: false,
        },
      });

      const result = computeAnomalyScore(features);

      expect(result.score).toBeLessThan(0.3);
      expect(result.triggered).toBe(false);
      expect(result.tripleSignal).toBe(false);
    });
  });
});

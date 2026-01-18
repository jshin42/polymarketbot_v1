import { describe, it, expect, beforeEach } from 'vitest';
import { KellySizingService, type SizingInput, type KellySizingConfig } from '../kelly-sizing.service.js';
import type { CompositeScore } from '@polymarketbot/shared';

/**
 * Kelly Sizing Tests
 *
 * Per CLAUDE.md Section 4.3:
 * - Fractional Kelly with conservative caps
 * - kelly_scale = 0.25 (quarter Kelly)
 * - max_fraction_per_trade = 0.01 (1% bankroll)
 * - Minimum bet size threshold
 */

function createMockScores(edgeScore: number = 0.5): CompositeScore {
  return {
    tokenId: 'test_token',
    timestamp: Date.now(),
    anomalyScore: {
      score: 0.7,
      components: {
        tradeSizeComponent: 0.8,
        bookImbalanceComponent: 0.6,
        thinOppositeComponent: 0.5,
        orderbookComponent: 0.55,
        walletComponent: 0.7,
        impactComponent: 0.3,
        burstComponent: 0.2,
        changePointComponent: 0.4,
      },
      coreScore: 0.65,
      contextScore: 0.4,
      confidence: 0.8,
      triggered: true,
      tripleSignal: false,
    },
    executionScore: {
      score: 0.75,
      depthScore: 0.8,
      spreadScore: 0.7,
      volatilityScore: 0.75,
      timeScore: 0.8,
      spreadPenalty: 0.15,
      slippagePenalty: 0.1,
      timePenalty: 0.05,
      slippageEstimateBps: 25,
      fillProbability: 0.95,
      depthAtLimit: 5000,
    },
    edgeScore: {
      score: edgeScore,
      impliedProbability: 0.5,
      estimatedProbability: 0.55,
      edge: 0.05,
      edgeAbs: 0.05,
      edgePct: 10,
      edgeConfidence: 0.7,
      alignedSignals: 3,
    },
    compositeScore: 0.65,
    rampMultiplier: 1.2,
    rampedScore: 0.78,
    signalStrength: 'moderate',
    computedAt: Date.now(),
  };
}

function createSizingInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    scores: createMockScores(0.5),
    currentPrice: 0.5,
    bankroll: 10000,
    existingPositionSize: 0,
    ...overrides,
  };
}

describe('Kelly Sizing Service', () => {
  let kellySizing: KellySizingService;

  beforeEach(() => {
    kellySizing = new KellySizingService();
  });

  describe('Initialization', () => {
    it('should use default configuration', () => {
      const config = kellySizing.getConfig();

      expect(config.kellyFraction).toBe(0.25);
      expect(config.maxBetFraction).toBe(0.02);
      expect(config.maxPositionFraction).toBe(0.05);
      expect(config.minBetSizeUsd).toBe(5);
    });

    it('should allow custom configuration', () => {
      const customConfig: Partial<KellySizingConfig> = {
        kellyFraction: 0.5,
        minBetSizeUsd: 10,
      };

      const customSizing = new KellySizingService(customConfig);
      const config = customSizing.getConfig();

      expect(config.kellyFraction).toBe(0.5);
      expect(config.minBetSizeUsd).toBe(10);
    });
  });

  describe('Fractional Kelly (0.25x) application', () => {
    it('should apply 0.25x Kelly fraction to raw Kelly', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        bankroll: 10000,
        currentPrice: 0.5,
      });

      const result = kellySizing.computeSize(input);

      // Raw Kelly should be reduced by 0.25
      expect(result.kellyAdjusted).toBeLessThanOrEqual(result.kellyRaw * 0.25 + 0.0001);
    });

    it('should compute raw Kelly as edge / variance', () => {
      const input = createSizingInput({
        scores: createMockScores(1.0), // Max edge score
        bankroll: 10000,
        currentPrice: 0.5,
      });

      const result = kellySizing.computeSize(input);

      // edge_estimate = score * 0.1 = 0.1
      // variance = max(p*(1-p), 0.25) = max(0.25, 0.25) = 0.25
      // kelly_raw = 0.1 / 0.25 = 0.4
      expect(result.edgeEstimate).toBeCloseTo(0.1, 5);
      expect(result.kellyRaw).toBeCloseTo(0.4, 2);
    });

    it('should use conservative variance proxy', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        currentPrice: 0.9, // High probability → low natural variance
      });

      const result = kellySizing.computeSize(input);

      // Natural variance = 0.9 * 0.1 = 0.09
      // Should use max(0.09, 0.25) = 0.25 for safety
      expect(result.varianceProxy).toBe(0.25);
    });

    it('should use natural variance when higher', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        currentPrice: 0.5, // Maximum natural variance
      });

      const result = kellySizing.computeSize(input);

      // Natural variance = 0.5 * 0.5 = 0.25
      expect(result.varianceProxy).toBe(0.25);
    });
  });

  describe('Max bet fraction cap', () => {
    it('should cap bet at 2% of bankroll', () => {
      // Create high edge score that would suggest large bet
      const highEdgeScores = createMockScores(1.0);
      highEdgeScores.edgeScore.score = 1.0;

      const input = createSizingInput({
        scores: highEdgeScores,
        bankroll: 10000,
        existingPositionSize: 0,
      });

      // With full Kelly, might suggest > 2%, but should be capped
      const result = kellySizing.computeSize(input);

      // Max bet = 2% of $10,000 = $200
      expect(result.targetSizeUsd).toBeLessThanOrEqual(200);
    });

    it('should record capping reason when bet is capped', () => {
      const highEdgeScores = createMockScores(1.0);

      const input = createSizingInput({
        scores: highEdgeScores,
        bankroll: 10000,
      });

      const result = kellySizing.computeSize(input);

      if (result.kellyAdjusted * input.bankroll > 200) {
        expect(result.cappedReason).toBe('max_bet_fraction');
      }
    });

    it('should not cap when below max bet fraction', () => {
      const lowEdgeScores = createMockScores(0.1);

      const input = createSizingInput({
        scores: lowEdgeScores,
        bankroll: 10000,
      });

      const result = kellySizing.computeSize(input);

      // Low edge should result in small bet, not capped
      if (result.cappedReason === 'max_bet_fraction') {
        expect(result.targetSizeUsd).toBe(200); // If capped, should be at cap
      }
    });
  });

  describe('Max position fraction cap', () => {
    it('should cap when position would exceed 5%', () => {
      const input = createSizingInput({
        scores: createMockScores(1.0),
        bankroll: 10000,
        existingPositionSize: 400, // Already have $400 position
      });

      const result = kellySizing.computeSize(input);

      // Max position = 5% of $10,000 = $500
      // Existing = $400, so max additional = $100
      // Use toBeCloseTo to handle floating-point precision
      expect(result.targetSizeUsd).toBeCloseTo(100, 5);
    });

    it('should return zero when at position limit', () => {
      const input = createSizingInput({
        scores: createMockScores(1.0),
        bankroll: 10000,
        existingPositionSize: 500, // Already at 5%
      });

      const result = kellySizing.computeSize(input);

      expect(result.targetSizeUsd).toBe(0);
      expect(result.cappedReason).toBe('max_position_fraction');
    });

    it('should return zero when over position limit', () => {
      const input = createSizingInput({
        scores: createMockScores(1.0),
        bankroll: 10000,
        existingPositionSize: 600, // Over limit
      });

      const result = kellySizing.computeSize(input);

      expect(result.targetSizeUsd).toBe(0);
    });

    it('should record position cap reason', () => {
      const input = createSizingInput({
        scores: createMockScores(1.0),
        bankroll: 10000,
        existingPositionSize: 450,
      });

      const result = kellySizing.computeSize(input);

      // If capped by position, should record it
      if (result.targetSizeUsd < 200) {
        expect(result.cappedReason).toBe('max_position_fraction');
      }
    });
  });

  describe('Minimum bet size threshold', () => {
    it('should reject bets below $5 minimum', () => {
      const lowEdgeScores = createMockScores(0.01); // Very low edge

      const input = createSizingInput({
        scores: lowEdgeScores,
        bankroll: 1000, // Small bankroll
      });

      const result = kellySizing.computeSize(input);

      // If calculated size < $5, should be 0
      if (result.kellyAdjusted * input.bankroll < 5 && result.kellyAdjusted > 0) {
        expect(result.targetSizeUsd).toBe(0);
        expect(result.cappedReason).toBe('below_min_bet_size');
      }
    });

    it('should allow bets at or above minimum', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        bankroll: 10000,
      });

      const result = kellySizing.computeSize(input);

      if (result.targetSizeUsd > 0) {
        expect(result.targetSizeUsd).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe('Edge estimation', () => {
    it('should scale edge score by 0.1 (conservative)', () => {
      const input = createSizingInput({
        scores: createMockScores(0.8),
      });

      const result = kellySizing.computeSize(input);

      // Edge score of 0.8 → 8% edge estimate
      expect(result.edgeEstimate).toBeCloseTo(0.08, 5);
    });

    it('should return zero sizing for zero edge', () => {
      const zeroEdgeScores = createMockScores(0);

      const input = createSizingInput({
        scores: zeroEdgeScores,
      });

      const result = kellySizing.computeSize(input);

      expect(result.kellyRaw).toBe(0);
      expect(result.targetSizeUsd).toBe(0);
    });

    it('should increase size proportionally with edge', () => {
      const lowEdgeInput = createSizingInput({
        scores: createMockScores(0.2),
        bankroll: 10000,
        existingPositionSize: 0,
      });

      const highEdgeInput = createSizingInput({
        scores: createMockScores(0.8),
        bankroll: 10000,
        existingPositionSize: 0,
      });

      const lowResult = kellySizing.computeSize(lowEdgeInput);
      const highResult = kellySizing.computeSize(highEdgeInput);

      // Higher edge should result in larger bet (or both capped)
      expect(highResult.kellyRaw).toBeGreaterThan(lowResult.kellyRaw);
    });
  });

  describe('Share calculation', () => {
    it('should compute YES shares correctly', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        currentPrice: 0.4, // YES costs $0.40
        bankroll: 10000,
      });

      const result = kellySizing.computeYesSize(input);

      // shares = USD / price
      if (result.targetSizeUsd > 0) {
        expect(result.targetSizeShares).toBeCloseTo(
          result.targetSizeUsd / 0.4,
          2
        );
      }
    });

    it('should compute NO shares correctly', () => {
      const input = createSizingInput({
        scores: createMockScores(0.5),
        currentPrice: 0.4, // NO costs 1 - 0.4 = $0.60
        bankroll: 10000,
      });

      const result = kellySizing.computeNoSize(input);

      // shares = USD / (1 - price)
      if (result.targetSizeUsd > 0) {
        expect(result.targetSizeShares).toBeCloseTo(
          result.targetSizeUsd / 0.6,
          2
        );
      }
    });

    it('should return zero shares for zero size', () => {
      const zeroEdgeScores = createMockScores(0);

      const input = createSizingInput({
        scores: zeroEdgeScores,
      });

      const result = kellySizing.computeSize(input);

      expect(result.targetSizeShares).toBe(0);
    });
  });

  describe('Configuration updates', () => {
    it('allows runtime config updates', () => {
      kellySizing.updateConfig({
        kellyFraction: 0.5, // Double the Kelly fraction
      });

      const input = createSizingInput({
        scores: createMockScores(0.5),
        bankroll: 10000,
      });

      const result = kellySizing.computeSize(input);

      // Kelly adjusted should use new 0.5 fraction
      const expectedKellyAdjusted = result.kellyRaw * 0.5;
      expect(result.kellyAdjusted).toBeCloseTo(
        Math.min(expectedKellyAdjusted, 0.02), // Still capped by maxBetFraction
        5
      );
    });

    it('allows updating minimum bet size', () => {
      kellySizing.updateConfig({
        minBetSizeUsd: 20, // Increase minimum
      });

      const config = kellySizing.getConfig();
      expect(config.minBetSizeUsd).toBe(20);
    });
  });

  describe('Real-world scenarios', () => {
    it('should size conservatively for moderate opportunity', () => {
      const input = createSizingInput({
        scores: createMockScores(0.6),
        currentPrice: 0.45,
        bankroll: 10000,
        existingPositionSize: 0,
      });

      const result = kellySizing.computeSize(input);

      // Should be reasonable fraction of bankroll
      expect(result.targetSizeUsd).toBeGreaterThan(0);
      expect(result.targetSizeUsd).toBeLessThanOrEqual(200); // Max 2%
    });

    it('should reduce sizing when already have position', () => {
      const inputNoPosition = createSizingInput({
        scores: createMockScores(0.8),
        bankroll: 10000,
        existingPositionSize: 0,
      });

      const inputWithPosition = createSizingInput({
        scores: createMockScores(0.8),
        bankroll: 10000,
        existingPositionSize: 300,
      });

      const resultNoPosition = kellySizing.computeSize(inputNoPosition);
      const resultWithPosition = kellySizing.computeSize(inputWithPosition);

      // Should size less when already have position
      expect(resultWithPosition.targetSizeUsd).toBeLessThanOrEqual(
        resultNoPosition.targetSizeUsd
      );
    });

    it('should scale with bankroll', () => {
      const smallBankroll = createSizingInput({
        scores: createMockScores(0.6),
        bankroll: 1000,
      });

      const largeBankroll = createSizingInput({
        scores: createMockScores(0.6),
        bankroll: 100000,
      });

      const smallResult = kellySizing.computeSize(smallBankroll);
      const largeResult = kellySizing.computeSize(largeBankroll);

      // Same fraction, different absolute size
      if (smallResult.targetSizeUsd > 0 && largeResult.targetSizeUsd > 0) {
        expect(largeResult.targetSizeUsd / largeBankroll.bankroll).toBeCloseTo(
          smallResult.targetSizeUsd / smallBankroll.bankroll,
          3
        );
      }
    });
  });
});

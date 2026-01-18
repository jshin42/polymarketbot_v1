import { describe, it, expect } from 'vitest';
import { checkTripleSignal, classifySignalStrength } from '@polymarketbot/shared';

/**
 * Triple Signal Detection Tests
 *
 * Per CLAUDE.md Section 3.1, a high-confidence "triple-signal" event requires:
 * - size_tail_score >= 0.90 AND
 * - book_imbalance_score >= 0.70 AND thin_opposite_score >= 0.70 AND
 * - wallet_new_score >= 0.80 (new) OR wallet_activity_score >= 0.70
 */
describe('Triple Signal Detection', () => {
  // Default thresholds from the implementation
  const thresholds = {
    size: 0.90,
    bookImbalance: 0.70,
    thinOpposite: 0.70,
    walletNew: 0.80,
    walletActivity: 0.70,
  };

  describe('Core triple signal conditions', () => {
    it('triggers when size_tail >= 0.90 AND book_imbalance >= 0.70 AND thin_opposite >= 0.70 AND wallet_new >= 0.80', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.75, // bookImbalanceScore >= 0.70 ✓
        0.72, // thinOppositeScore >= 0.70 ✓
        0.85, // walletNewScore >= 0.80 ✓
        0.50, // walletActivityScore (not needed since wallet_new is high)
        thresholds
      );

      expect(result).toBe(true);
    });

    it('triggers when wallet_activity replaces wallet_new', () => {
      const result = checkTripleSignal(
        0.92, // sizeTailScore >= 0.90 ✓
        0.80, // bookImbalanceScore >= 0.70 ✓
        0.75, // thinOppositeScore >= 0.70 ✓
        0.30, // walletNewScore < 0.80 ✗
        0.75, // walletActivityScore >= 0.70 ✓ (replaces wallet_new)
        thresholds
      );

      expect(result).toBe(true);
    });

    it('triggers at exactly threshold values', () => {
      const result = checkTripleSignal(
        0.90, // sizeTailScore == 0.90 ✓
        0.70, // bookImbalanceScore == 0.70 ✓
        0.70, // thinOppositeScore == 0.70 ✓
        0.80, // walletNewScore == 0.80 ✓
        0.00, // walletActivityScore
        thresholds
      );

      expect(result).toBe(true);
    });
  });

  describe('Size tail rejections', () => {
    it('rejects when size_tail below threshold', () => {
      const result = checkTripleSignal(
        0.89, // sizeTailScore < 0.90 ✗
        0.85, // bookImbalanceScore >= 0.70 ✓
        0.80, // thinOppositeScore >= 0.70 ✓
        0.90, // walletNewScore >= 0.80 ✓
        0.80, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects when size_tail is zero', () => {
      const result = checkTripleSignal(
        0.00, // sizeTailScore = 0 ✗
        0.90, // bookImbalanceScore
        0.90, // thinOppositeScore
        0.95, // walletNewScore
        0.95, // walletActivityScore
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects when size_tail is just below threshold', () => {
      const result = checkTripleSignal(
        0.899, // sizeTailScore just below 0.90 ✗
        0.75, // bookImbalanceScore
        0.75, // thinOppositeScore
        0.85, // walletNewScore
        0.75, // walletActivityScore
        thresholds
      );

      expect(result).toBe(false);
    });
  });

  describe('Book imbalance rejections', () => {
    it('rejects when book_imbalance below threshold', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.69, // bookImbalanceScore < 0.70 ✗
        0.80, // thinOppositeScore >= 0.70 ✓
        0.85, // walletNewScore >= 0.80 ✓
        0.75, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects when thin_opposite below threshold', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.80, // bookImbalanceScore >= 0.70 ✓
        0.69, // thinOppositeScore < 0.70 ✗
        0.85, // walletNewScore >= 0.80 ✓
        0.75, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects when both book metrics are below threshold', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.50, // bookImbalanceScore < 0.70 ✗
        0.50, // thinOppositeScore < 0.70 ✗
        0.90, // walletNewScore >= 0.80 ✓
        0.80, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(false);
    });

    it('requires BOTH book metrics to be high', () => {
      // Even if one is very high, the other must also meet threshold
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.99, // bookImbalanceScore very high ✓
        0.65, // thinOppositeScore < 0.70 ✗
        0.85, // walletNewScore >= 0.80 ✓
        0.00, // walletActivityScore
        thresholds
      );

      expect(result).toBe(false);
    });
  });

  describe('Wallet condition rejections', () => {
    it('rejects when neither wallet_new nor wallet_activity meets threshold', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore >= 0.90 ✓
        0.80, // bookImbalanceScore >= 0.70 ✓
        0.75, // thinOppositeScore >= 0.70 ✓
        0.79, // walletNewScore < 0.80 ✗
        0.69, // walletActivityScore < 0.70 ✗
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects when wallet scores are zero', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore
        0.80, // bookImbalanceScore
        0.80, // thinOppositeScore
        0.00, // walletNewScore = 0 ✗
        0.00, // walletActivityScore = 0 ✗
        thresholds
      );

      expect(result).toBe(false);
    });
  });

  describe('Wallet condition alternatives', () => {
    it('accepts high wallet_activity instead of wallet_new', () => {
      const result = checkTripleSignal(
        0.92, // sizeTailScore >= 0.90 ✓
        0.75, // bookImbalanceScore >= 0.70 ✓
        0.72, // thinOppositeScore >= 0.70 ✓
        0.00, // walletNewScore = 0 (old wallet) ✗
        0.85, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(true);
    });

    it('accepts when both wallet conditions are met', () => {
      const result = checkTripleSignal(
        0.92, // sizeTailScore >= 0.90 ✓
        0.75, // bookImbalanceScore >= 0.70 ✓
        0.72, // thinOppositeScore >= 0.70 ✓
        0.90, // walletNewScore >= 0.80 ✓
        0.90, // walletActivityScore >= 0.70 ✓
        thresholds
      );

      expect(result).toBe(true);
    });

    it('wallet_activity exactly at threshold triggers', () => {
      const result = checkTripleSignal(
        0.95, // sizeTailScore
        0.75, // bookImbalanceScore
        0.75, // thinOppositeScore
        0.10, // walletNewScore below threshold
        0.70, // walletActivityScore == 0.70 ✓
        thresholds
      );

      expect(result).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('rejects when all scores are zero', () => {
      const result = checkTripleSignal(0, 0, 0, 0, 0, thresholds);
      expect(result).toBe(false);
    });

    it('rejects when only size is high', () => {
      const result = checkTripleSignal(1.0, 0, 0, 0, 0, thresholds);
      expect(result).toBe(false);
    });

    it('rejects when only book is high', () => {
      const result = checkTripleSignal(0, 1.0, 1.0, 0, 0, thresholds);
      expect(result).toBe(false);
    });

    it('rejects when only wallet is high', () => {
      const result = checkTripleSignal(0, 0, 0, 1.0, 1.0, thresholds);
      expect(result).toBe(false);
    });

    it('triggers when all scores are maximum', () => {
      const result = checkTripleSignal(1.0, 1.0, 1.0, 1.0, 1.0, thresholds);
      expect(result).toBe(true);
    });
  });

  describe('Custom thresholds', () => {
    it('respects custom lower thresholds', () => {
      const customThresholds = {
        size: 0.50,
        bookImbalance: 0.40,
        thinOpposite: 0.40,
        walletNew: 0.50,
        walletActivity: 0.40,
      };

      const result = checkTripleSignal(
        0.55, // Would fail default threshold
        0.45, // Would fail default threshold
        0.45, // Would fail default threshold
        0.55, // Would fail default threshold
        0.00,
        customThresholds
      );

      expect(result).toBe(true);
    });

    it('respects custom higher thresholds', () => {
      const customThresholds = {
        size: 0.99,
        bookImbalance: 0.95,
        thinOpposite: 0.95,
        walletNew: 0.95,
        walletActivity: 0.95,
      };

      const result = checkTripleSignal(
        0.95, // Would pass default threshold
        0.80, // Would pass default threshold
        0.80, // Would pass default threshold
        0.85, // Would pass default threshold
        0.80,
        customThresholds
      );

      expect(result).toBe(false);
    });
  });

  describe('Real-world scenarios', () => {
    it('detects suspected insider trade: large new wallet + imbalanced book', () => {
      // Scenario: New wallet makes $50k trade on thin ask side
      const result = checkTripleSignal(
        0.98, // $50k trade is q999 (extreme)
        0.85, // Strong bid-side imbalance
        0.90, // Ask side very thin
        1.00, // 2-day old wallet
        0.95, // Very low activity (first big trade)
        thresholds
      );

      expect(result).toBe(true);
    });

    it('detects coordinated activity: multiple new wallets', () => {
      // Scenario: Pattern suggests coordinated buying
      const result = checkTripleSignal(
        0.92, // Above q99 but not extreme
        0.78, // Moderate imbalance
        0.75, // Moderate thin opposite
        0.90, // New wallet
        0.80, // Low activity
        thresholds
      );

      expect(result).toBe(true);
    });

    it('rejects normal whale activity from established wallet', () => {
      // Scenario: Known whale makes large trade
      const result = checkTripleSignal(
        0.95, // Large trade
        0.75, // Book imbalance
        0.72, // Thin opposite
        0.10, // Old wallet (180+ days)
        0.20, // High activity (not suspicious)
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects medium trade from new wallet on balanced book', () => {
      // Scenario: New user makes normal trade
      const result = checkTripleSignal(
        0.60, // Medium trade (q80)
        0.40, // Balanced book
        0.35, // Balanced book
        0.95, // Very new wallet
        0.90, // Low activity
        thresholds
      );

      expect(result).toBe(false);
    });

    it('rejects large trade on balanced book from old wallet', () => {
      // Scenario: Experienced trader makes large trade on liquid market
      const result = checkTripleSignal(
        0.95, // Large trade
        0.30, // Balanced book
        0.25, // Deep liquidity on both sides
        0.05, // Very old wallet
        0.10, // High activity history
        thresholds
      );

      expect(result).toBe(false);
    });
  });

  describe('Signal strength classification integration', () => {
    it('triple signal events should typically have strong/extreme signal strength', () => {
      // When triple signal triggers, composite score should be high
      // This tests that our thresholds align with signal strength

      // All high scores should produce extreme classification
      expect(classifySignalStrength(0.90)).toBe('extreme');
      expect(classifySignalStrength(0.85)).toBe('extreme');

      // Strong signals
      expect(classifySignalStrength(0.80)).toBe('strong');
      expect(classifySignalStrength(0.75)).toBe('strong');

      // Moderate signals
      expect(classifySignalStrength(0.65)).toBe('moderate');
      expect(classifySignalStrength(0.55)).toBe('moderate');

      // Weak signals
      expect(classifySignalStrength(0.45)).toBe('weak');
      expect(classifySignalStrength(0.35)).toBe('weak');

      // No signal
      expect(classifySignalStrength(0.25)).toBe('none');
      expect(classifySignalStrength(0.10)).toBe('none');
    });
  });

  describe('Boundary value analysis', () => {
    // Test values exactly at, just above, and just below thresholds

    it('size at 0.90 triggers, at 0.8999 does not', () => {
      const baseScores = { book: 0.75, thin: 0.75, walletNew: 0.85, walletActivity: 0.75 };

      expect(checkTripleSignal(0.90, baseScores.book, baseScores.thin, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(true);
      expect(checkTripleSignal(0.8999, baseScores.book, baseScores.thin, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(false);
    });

    it('book_imbalance at 0.70 triggers, at 0.6999 does not', () => {
      const baseScores = { size: 0.95, thin: 0.75, walletNew: 0.85, walletActivity: 0.75 };

      expect(checkTripleSignal(baseScores.size, 0.70, baseScores.thin, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(true);
      expect(checkTripleSignal(baseScores.size, 0.6999, baseScores.thin, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(false);
    });

    it('thin_opposite at 0.70 triggers, at 0.6999 does not', () => {
      const baseScores = { size: 0.95, book: 0.75, walletNew: 0.85, walletActivity: 0.75 };

      expect(checkTripleSignal(baseScores.size, baseScores.book, 0.70, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(true);
      expect(checkTripleSignal(baseScores.size, baseScores.book, 0.6999, baseScores.walletNew, baseScores.walletActivity, thresholds)).toBe(false);
    });

    it('wallet_new at 0.80 triggers, at 0.7999 needs wallet_activity', () => {
      const baseScores = { size: 0.95, book: 0.75, thin: 0.75 };

      // wallet_new at threshold, no activity fallback
      expect(checkTripleSignal(baseScores.size, baseScores.book, baseScores.thin, 0.80, 0.50, thresholds)).toBe(true);

      // wallet_new just below, activity also below
      expect(checkTripleSignal(baseScores.size, baseScores.book, baseScores.thin, 0.7999, 0.50, thresholds)).toBe(false);

      // wallet_new just below, but activity saves it
      expect(checkTripleSignal(baseScores.size, baseScores.book, baseScores.thin, 0.7999, 0.70, thresholds)).toBe(true);
    });

    it('wallet_activity at 0.70 triggers when wallet_new below threshold', () => {
      const baseScores = { size: 0.95, book: 0.75, thin: 0.75 };

      expect(checkTripleSignal(baseScores.size, baseScores.book, baseScores.thin, 0.50, 0.70, thresholds)).toBe(true);
      expect(checkTripleSignal(baseScores.size, baseScores.book, baseScores.thin, 0.50, 0.6999, thresholds)).toBe(false);
    });
  });
});

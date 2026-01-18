import { createLogger, type CompositeScore } from '@polymarketbot/shared';

// =============================================================================
// Kelly Sizing Service
// =============================================================================
//
// This service implements the Kelly Criterion for position sizing as specified
// in CLAUDE.md Section 4.3. The Kelly formula determines the optimal fraction
// of bankroll to bet given an estimated edge and variance.
//
// **Key Principles:**
// 1. **Fractional Kelly**: Use 0.25x Kelly for conservative sizing
// 2. **Edge Estimation**: Convert edge score to estimated edge percentage
// 3. **Variance Proxy**: Use max(p*(1-p), 0.25) for safety
// 4. **Multiple Caps**: Single bet, position, and exposure limits
//
// **Formula:**
// ```
// f_raw = edge / variance
// f_adjusted = kelly_fraction * f_raw
// f_final = min(f_adjusted, max_bet_fraction)
// size_usd = f_final * bankroll
// ```
//
// **Default Parameters (from CLAUDE.md):**
// - kelly_fraction = 0.25 (quarter Kelly)
// - max_bet_fraction = 0.02 (2% per trade)
// - max_position_fraction = 0.05 (5% per market)
// - min_bet_size = $5
// =============================================================================

const logger = createLogger('kelly-sizing-service');

export interface KellySizingConfig {
  /** Fractional Kelly multiplier (0.25 = quarter Kelly) */
  kellyFraction: number;
  /** Maximum fraction of bankroll per trade */
  maxBetFraction: number;
  /** Maximum fraction of bankroll per position */
  maxPositionFraction: number;
  /** Minimum bet size in USD */
  minBetSizeUsd: number;
  /** Default variance proxy for edge calculation */
  defaultVarianceProxy: number;
}

export interface SizingInput {
  scores: CompositeScore;
  currentPrice: number;
  bankroll: number;
  existingPositionSize: number;
}

export interface SizingResult {
  targetSizeUsd: number;
  targetSizeShares: number;
  kellyRaw: number;
  kellyAdjusted: number;
  cappedReason: string | null;
  edgeEstimate: number;
  varianceProxy: number;
}

const DEFAULT_CONFIG: KellySizingConfig = {
  kellyFraction: 0.25,
  maxBetFraction: 0.02,
  maxPositionFraction: 0.05,
  minBetSizeUsd: 5,
  defaultVarianceProxy: 0.25,
};

export class KellySizingService {
  private config: KellySizingConfig;

  constructor(config: Partial<KellySizingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compute position size using fractional Kelly criterion.
   *
   * Kelly formula: f* = edge / variance
   * We use fractional Kelly (e.g., 0.25 * f*) for safety.
   *
   * Since we don't have a calibrated probability model, we use:
   * edge_proxy = k * edge_score where k is small
   */
  computeSize(input: SizingInput): SizingResult {
    const { scores, currentPrice, bankroll, existingPositionSize } = input;

    // Estimate edge from scores
    // Without a calibrated model, use edge_score as a proxy
    // Scale down significantly since this is not true edge
    const edgeScaleFactor = 0.1; // Conservative: edge_score of 1.0 → 10% edge estimate
    const edgeEstimate = scores.edgeScore.score * edgeScaleFactor;

    // Variance proxy based on price (binary option variance = p * (1-p))
    // Use max variance proxy at p=0.5 for safety
    const priceVariance = currentPrice * (1 - currentPrice);
    const varianceProxy = Math.max(priceVariance, this.config.defaultVarianceProxy);

    // Raw Kelly fraction
    const kellyRaw = edgeEstimate > 0 ? edgeEstimate / varianceProxy : 0;

    // Apply fractional Kelly
    let kellyAdjusted = kellyRaw * this.config.kellyFraction;

    // Track capping reason
    let cappedReason: string | null = null;

    // Cap at max bet fraction
    if (kellyAdjusted > this.config.maxBetFraction) {
      kellyAdjusted = this.config.maxBetFraction;
      cappedReason = 'max_bet_fraction';
    }

    // Check position limit
    const existingPositionFraction = existingPositionSize / bankroll;
    const remainingPositionRoom =
      this.config.maxPositionFraction - existingPositionFraction;

    if (kellyAdjusted > remainingPositionRoom) {
      kellyAdjusted = Math.max(0, remainingPositionRoom);
      cappedReason = 'max_position_fraction';
    }

    // Compute target size in USD
    let targetSizeUsd = kellyAdjusted * bankroll;

    // Enforce minimum bet size
    if (targetSizeUsd > 0 && targetSizeUsd < this.config.minBetSizeUsd) {
      targetSizeUsd = 0;
      cappedReason = 'below_min_bet_size';
    }

    // Compute shares (for binary options, shares = USD / price for YES side)
    // This is simplified; actual calculation depends on order side
    const targetSizeShares = targetSizeUsd > 0 ? targetSizeUsd / currentPrice : 0;

    const result: SizingResult = {
      targetSizeUsd,
      targetSizeShares,
      kellyRaw,
      kellyAdjusted,
      cappedReason,
      edgeEstimate,
      varianceProxy,
    };

    logger.debug(result, 'Kelly sizing computed');

    return result;
  }

  /**
   * Compute size for a YES position (betting price will go up).
   */
  computeYesSize(input: SizingInput): SizingResult {
    const result = this.computeSize(input);
    // For YES, shares = USD / price
    result.targetSizeShares =
      result.targetSizeUsd > 0 ? result.targetSizeUsd / input.currentPrice : 0;
    return result;
  }

  /**
   * Compute size for a NO position (betting price will go down).
   */
  computeNoSize(input: SizingInput): SizingResult {
    const result = this.computeSize(input);
    // For NO, we're buying the opposite outcome
    // Effective price for NO = 1 - YES price
    const noPrice = 1 - input.currentPrice;
    result.targetSizeShares =
      result.targetSizeUsd > 0 ? result.targetSizeUsd / noPrice : 0;
    return result;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<KellySizingConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Kelly sizing config updated');
  }

  /**
   * Get current configuration.
   */
  getConfig(): KellySizingConfig {
    return { ...this.config };
  }
}

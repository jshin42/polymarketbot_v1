import {
  type FeatureVector,
  type ExecutionScore,
  DEFAULT_EXECUTION_WEIGHTS,
  SPREAD_DEFAULTS,
  DEPTH_DEFAULTS,
} from '@polymarketbot/shared';

// =============================================================================
// Execution Score Computation
// =============================================================================
//
// This module implements the execution quality scoring system as specified in
// CLAUDE.md Section 3.3. The execution score measures how likely we are to
// achieve a good fill on a proposed trade, considering:
//
// 1. Market liquidity (depth available at top of book)
// 2. Spread tightness (narrower = better execution)
// 3. Market volatility (stability of the order book)
// 4. Time proximity to market close (execution risk increases near close)
//
// A high execution score indicates favorable conditions for trade execution,
// while a low score suggests unfavorable conditions (wide spreads, thin books).
// =============================================================================

/**
 * Computes the execution score assessing fillability and slippage risk.
 *
 * This function evaluates whether current market conditions are favorable for
 * executing a trade. It combines multiple factors into a single score between
 * 0 and 1, where higher scores indicate better execution conditions.
 *
 * **Formula (from CLAUDE.md Section 3.3):**
 * ```
 * execution_score = 0.40*depth_score + 0.25*(1-spread_penalty) +
 *                   0.25*(1-vol_penalty) + 0.10*time_score
 * ```
 *
 * **Score Components:**
 * - `depthScore` (40%): Liquidity available relative to order size
 * - `spreadScore` (25%): Inverse of spread penalty (tight = good)
 * - `volatilityScore` (25%): Inverse of volatility proxy (stable = good)
 * - `timeScore` (10%): Penalty for proximity to market close
 *
 * **Additional Outputs:**
 * - `slippageEstimateBps`: Estimated slippage in basis points
 * - `fillProbability`: Estimated likelihood of fill at limit price
 * - `depthAtLimit`: Available depth at the limit price
 *
 * @param features - The computed feature vector for the current market state
 * @param targetSizeUsd - The proposed trade size in USD (default: 100)
 * @returns Complete ExecutionScore object with score breakdown
 *
 * @example
 * ```ts
 * const features = await featureComputer.computeFeatures(tokenId, conditionId, timestamp);
 * const executionScore = computeExecutionScore(features, 150);
 *
 * if (executionScore.score >= 0.55) {
 *   console.log('Favorable execution conditions');
 * }
 * if (executionScore.slippageEstimateBps > 100) {
 *   console.log('Warning: High slippage expected');
 * }
 * ```
 */
export function computeExecutionScore(
  features: FeatureVector,
  targetSizeUsd: number = 100
): ExecutionScore {
  const weights = DEFAULT_EXECUTION_WEIGHTS;
  const { orderbook, timeToClose } = features;

  // Spread penalty: higher spread = worse execution
  const spreadPenalty = computeSpreadPenalty(orderbook.spreadBps);

  // Depth/liquidity score
  const depthScore = computeLiquidityScore(orderbook.bidDepth, orderbook.askDepth, targetSizeUsd);

  // Volatility penalty (proxy from spread and imbalance)
  const volPenalty = computeVolatilityPenalty(orderbook.spreadBps, orderbook.imbalanceAbs);

  // Time component (penalize near close but not as much as for anomaly)
  const timeScore = Math.min(1, 1 / timeToClose.rampMultiplier);
  const timePenalty = 1 - timeScore;

  // Compute weighted score
  const score =
    weights.depth * depthScore +
    weights.spread * (1 - spreadPenalty) +
    weights.volatility * (1 - volPenalty) +
    weights.time * timeScore;

  // Spread score (inverse of penalty)
  const spreadScore = 1 - spreadPenalty;

  // Volatility score (inverse of penalty)
  const volatilityScore = 1 - volPenalty;

  // Estimate slippage based on depth and target size (in bps)
  const slippageEstimateBps = estimateSlippage(orderbook.bidDepth, orderbook.askDepth, targetSizeUsd) * 10000;
  const slippagePenalty = Math.min(1, slippageEstimateBps / 500); // Normalize to 0-1

  // Fill probability based on liquidity and spread
  const fillProbability = computeFillProbability(depthScore, spreadPenalty);

  // Depth available at limit price (use minimum of bid/ask)
  const depthAtLimit = Math.min(orderbook.bidDepth, orderbook.askDepth);

  return {
    score: Math.min(1, Math.max(0, score)),
    depthScore,
    spreadScore,
    volatilityScore,
    timeScore,
    spreadPenalty,
    slippagePenalty,
    timePenalty,
    slippageEstimateBps,
    fillProbability,
    depthAtLimit,
  };
}

/**
 * Compute spread penalty (0 = tight spread, 1 = wide spread)
 */
function computeSpreadPenalty(spreadBps: number): number {
  const { minAcceptableBps, maxAcceptableBps } = SPREAD_DEFAULTS;

  if (spreadBps <= minAcceptableBps) return 0;
  if (spreadBps >= maxAcceptableBps) return 1;

  return (spreadBps - minAcceptableBps) / (maxAcceptableBps - minAcceptableBps);
}

/**
 * Compute liquidity score based on available depth
 */
function computeLiquidityScore(
  bidDepth: number,
  askDepth: number,
  targetSizeUsd: number
): number {
  const { minDepthUsd, targetDepthUsd } = DEPTH_DEFAULTS;

  // Use minimum of bid/ask depth (worst case)
  const availableDepth = Math.min(bidDepth, askDepth);

  // Ratio of available depth to target
  const depthRatio = availableDepth / Math.max(targetSizeUsd * 2, minDepthUsd);

  // Score with saturation at 2x needed depth
  return Math.min(1, depthRatio);
}

/**
 * Compute volatility penalty as proxy from spread and imbalance
 */
function computeVolatilityPenalty(spreadBps: number, imbalanceAbs: number): number {
  // Wide spreads often indicate volatile/uncertain markets
  const spreadFactor = Math.min(1, spreadBps / 500);

  // High imbalance indicates directional pressure (uncertainty)
  const imbalanceFactor = imbalanceAbs;

  // Combine factors
  return 0.6 * spreadFactor + 0.4 * imbalanceFactor;
}

/**
 * Estimate slippage as percentage of mid price
 */
function estimateSlippage(
  bidDepth: number,
  askDepth: number,
  targetSizeUsd: number
): number {
  const availableDepth = Math.min(bidDepth, askDepth);

  if (availableDepth <= 0) return 0.1; // 10% max slippage estimate

  // Simple linear model: slippage increases with size relative to depth
  const depthRatio = targetSizeUsd / availableDepth;

  // Base slippage of 0.1% + linear increase
  const slippage = 0.001 + 0.02 * depthRatio;

  return Math.min(0.1, slippage); // Cap at 10%
}

/**
 * Estimate probability of getting filled at target price
 */
function computeFillProbability(liquidityScore: number, spreadPenalty: number): number {
  // High liquidity and tight spread = high fill probability
  return liquidityScore * (1 - 0.3 * spreadPenalty);
}

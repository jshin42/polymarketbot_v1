import {
  type FeatureVector,
  type EdgeScore,
} from '@polymarketbot/shared';

// =============================================================================
// Edge Score Computation
// =============================================================================
//
// This module implements the edge estimation scoring system as specified in
// CLAUDE.md Section 3.4. The edge score estimates the potential profit from
// taking a position based on detected anomaly signals.
//
// **Key Concepts:**
// - `impliedProbability`: Current market price as a probability
// - `estimatedProbability`: Our estimate of true probability based on signals
// - `edge`: Difference between estimated and implied probability
//
// For paper mode (without a calibrated probability model), we use:
//   edge_score = anomaly_score * execution_score
//
// The edge score helps prioritize opportunities when multiple signals fire,
// ranking them by expected profitability and execution feasibility.
// =============================================================================

/**
 * Computes the edge score estimating potential profit from a trade opportunity.
 *
 * This function estimates how profitable a trade might be based on detected
 * anomaly signals. Without a calibrated probability model, it uses a proxy
 * approach that combines signal strength with market observables.
 *
 * **Estimation Approach:**
 * 1. Start with implied probability from market price
 * 2. Adjust based on directional signals:
 *    - Large trades in one direction suggest smart money positioning
 *    - Order book imbalance indicates directional pressure
 *    - New accounts with large trades amplify the signal
 * 3. Compute edge as the difference between estimated and implied probability
 *
 * **Signal Alignment:**
 * The function tracks how many signals point in the same direction:
 * - Large trade detected
 * - Book imbalance > 0.3
 * - Burst detected
 * - Change point detected
 * - New account involved
 *
 * Higher alignment increases confidence in the edge estimate.
 *
 * **Formula (from CLAUDE.md Section 3.4):**
 * ```
 * edge_score = edge_magnitude * 5 * confidence * execution_score
 * ```
 *
 * @param features - The computed feature vector for the current market state
 * @param anomalyScore - The computed anomaly score (0-1)
 * @param executionScore - The computed execution score (0-1)
 * @param currentMid - The current mid price of the market
 * @returns Complete EdgeScore object with edge estimate and confidence
 *
 * @example
 * ```ts
 * const edgeScore = computeEdgeScore(features, 0.75, 0.60, 0.45);
 *
 * if (edgeScore.edge > 0) {
 *   console.log('Signal suggests YES is underpriced');
 * } else {
 *   console.log('Signal suggests NO is underpriced');
 * }
 * console.log(`Edge confidence: ${edgeScore.edgeConfidence}`);
 * console.log(`Aligned signals: ${edgeScore.alignedSignals}/5`);
 * ```
 */
export function computeEdgeScore(
  features: FeatureVector,
  anomalyScore: number,
  executionScore: number,
  currentMid: number
): EdgeScore {
  // Implied probability from market price
  const impliedProbability = currentMid;

  // Estimate true probability based on anomaly signals
  // If anomaly score is high, we believe true probability differs from implied
  let probabilityAdjustment = 0;

  // Large trade in one direction suggests smart money
  if (features.tradeSize?.isLargeTrade) {
    // Assume the trade direction indicates the "correct" side
    // Adjust probability up if buying (someone thinks YES is underpriced)
    // For now, we don't know direction from features alone, so use imbalance
    const direction = features.orderbook.imbalance > 0 ? 1 : -1;
    const magnitude = Math.min(0.15, anomalyScore * 0.1);
    probabilityAdjustment = direction * magnitude;
  }

  // Order book imbalance suggests directional pressure
  if (features.orderbook.imbalanceAbs > 0.3) {
    const direction = features.orderbook.imbalance > 0 ? 1 : -1;
    probabilityAdjustment += direction * features.orderbook.imbalanceAbs * 0.05;
  }

  // Wallet signals (new accounts with big trades)
  if (features.wallet?.isNewAccount && features.tradeSize?.isLargeTrade) {
    probabilityAdjustment *= 1.2; // Amplify signal
  }

  // Bound the estimated probability to valid range
  const estimatedTrueProbability = Math.max(
    0.01,
    Math.min(0.99, impliedProbability + probabilityAdjustment)
  );

  // Edge = difference between estimated and implied
  const edge = estimatedTrueProbability - impliedProbability;
  const edgeMagnitude = Math.abs(edge);

  // Confidence in edge estimate based on signal alignment
  let alignedSignals = 0;
  if (features.tradeSize?.isLargeTrade) alignedSignals++;
  if (features.orderbook.imbalanceAbs > 0.3) alignedSignals++;
  if (features.burst.burstDetected) alignedSignals++;
  if (features.changePoint.changePointDetected) alignedSignals++;
  if (features.wallet?.isNewAccount) alignedSignals++;

  const edgeConfidence = Math.min(0.9, 0.2 + alignedSignals * 0.14);

  // Final score: combination of edge magnitude and confidence
  // Also factor in execution score (can we actually capture the edge?)
  const rawScore = edgeMagnitude * 5 * edgeConfidence * executionScore;
  const score = Math.min(1, Math.max(0, rawScore));

  return {
    score,
    impliedProbability,
    estimatedProbability: estimatedTrueProbability,
    edge,
    edgeAbs: edgeMagnitude,
    edgePct: impliedProbability > 0 ? (edge / impliedProbability) * 100 : 0,
    edgeConfidence,
    alignedSignals,
  };
}

/**
 * Determine trade direction from features
 * Returns 'BUY' for YES or 'SELL' for NO
 */
export function determineTradeDirection(features: FeatureVector): 'BUY' | 'SELL' | null {
  // Use book imbalance as primary signal
  // Positive imbalance (more bids) suggests buying pressure on YES
  if (features.orderbook.imbalanceAbs > 0.2) {
    return features.orderbook.imbalance > 0 ? 'BUY' : 'SELL';
  }

  // If we have recent trade data, use the trade side
  // (This would require tracking the side of the triggering trade)

  return null; // Not confident enough to recommend direction
}

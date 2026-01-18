import {
  RedisKeys,
  RedisTTL,
  type FeatureVector,
  type CompositeScore,
  classifySignalStrength,
  DEFAULT_COMPOSITE_WEIGHTS,
  DASHBOARD_DEFAULTS,
  createLogger,
  Redis,
} from '@polymarketbot/shared';
import { computeAnomalyScore, identifyTriggeringTrades, getHighestTrade } from '../computations/anomaly-score.js';
import { computeExecutionScore } from '../computations/execution-score.js';
import { computeEdgeScore, determineTradeDirection } from '../computations/edge-score.js';

// =============================================================================
// Scoring Service
// =============================================================================

const logger = createLogger('scoring-service');

export class ScoringService {
  constructor(private readonly redis: Redis) {}

  /**
   * Compute all scores for a feature vector
   */
  async computeScores(
    tokenId: string,
    conditionId: string,
    timestamp: number,
    features: FeatureVector,
    targetSizeUsd: number = 100
  ): Promise<CompositeScore> {
    // Compute individual scores
    const anomalyScore = computeAnomalyScore(features);

    const executionScore = computeExecutionScore(features, targetSizeUsd);

    // Get current mid price from orderbook or default
    const orderbook = await this.getOrderbookState(tokenId);
    const currentMid = orderbook?.orderbook?.midPrice ?? 0.5;

    const edgeScore = computeEdgeScore(
      features,
      anomalyScore.score,
      executionScore.score,
      currentMid
    );

    // Compute composite score
    const weights = DEFAULT_COMPOSITE_WEIGHTS;
    const compositeScore =
      weights.anomaly * anomalyScore.score +
      weights.execution * executionScore.score +
      weights.edge * edgeScore.score;

    // Apply time ramp for final composite
    const rampedComposite = Math.min(1, compositeScore * features.timeToClose.rampMultiplier);

    // Classify signal strength
    const signalStrength = classifySignalStrength(rampedComposite);

    // Determine recommended direction (not stored in schema, used for logging)
    const recommendedDirection = determineTradeDirection(features);

    // Get highest trade for signal display with minimum display threshold
    // This filters out small trades (e.g., $12) that aren't meaningful signals
    const highestTrade1h = await getHighestTrade(
      tokenId,
      60,
      features,
      this.redis,
      DASHBOARD_DEFAULTS.MIN_TRIGGER_DISPLAY_USD
    );

    // Identify triggering trades when anomaly score is significant (>= 0.5)
    // These are high-confidence signals that meet stricter criteria ($5k + q95)
    let triggeringTrades: Awaited<ReturnType<typeof identifyTriggeringTrades>> | undefined;
    if (anomalyScore.score >= 0.5) {
      triggeringTrades = await identifyTriggeringTrades(tokenId, features, this.redis);
      if (triggeringTrades.length === 0) {
        triggeringTrades = undefined;
      }
    }

    const result: CompositeScore = {
      tokenId,
      timestamp,
      anomalyScore,
      executionScore,
      edgeScore,
      compositeScore: rampedComposite,
      rampMultiplier: features.timeToClose.rampMultiplier,
      rampedScore: rampedComposite,
      signalStrength,
      triggeringTrades,
      highestTrade1h,
      computedAt: Date.now(),
    };

    // Cache the score
    await this.redis.set(
      RedisKeys.scoreCache(tokenId),
      JSON.stringify(result),
      'EX',
      RedisTTL.scoreCache
    );

    // Log significant scores
    if (result.signalStrength !== 'none') {
      logger.info(
        {
          tokenId,
          signalStrength: result.signalStrength,
          compositeScore: rampedComposite.toFixed(3),
          anomaly: anomalyScore.score.toFixed(3),
          execution: executionScore.score.toFixed(3),
          edge: edgeScore.score.toFixed(3),
          tripleSignal: anomalyScore.tripleSignal,
        },
        'Significant signal detected'
      );
    }

    return result;
  }

  /**
   * Get cached score for a token
   */
  async getScore(tokenId: string): Promise<CompositeScore | null> {
    const scoreStr = await this.redis.get(RedisKeys.scoreCache(tokenId));
    return scoreStr ? JSON.parse(scoreStr) : null;
  }

  /**
   * Get orderbook state from cache
   */
  private async getOrderbookState(tokenId: string): Promise<{
    orderbook: { midPrice: number } | null;
  } | null> {
    const stateStr = await this.redis.get(RedisKeys.orderbookState(tokenId));
    return stateStr ? JSON.parse(stateStr) : null;
  }
}

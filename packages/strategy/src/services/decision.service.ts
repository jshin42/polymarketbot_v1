import {
  RedisKeys,
  createLogger,
  Redis,
  type CompositeScore,
  type FeatureVector,
  type Decision,
  type RejectionReason,
} from '@polymarketbot/shared';
import { KellySizingService, type SizingResult } from './kelly-sizing.service.js';
import { RiskGuards, type RiskCheckResult } from '../guards/risk-guards.js';
import { StalenessGuards } from '../guards/staleness-guards.js';

// =============================================================================
// Decision Service
// =============================================================================
//
// This service is the central decision-making component as specified in
// CLAUDE.md Section 4. It orchestrates the full decision pipeline:
//
// 1. **Data Freshness Check**: Reject if data is stale (Section 1.1)
// 2. **Score Thresholds**: Apply minimum score gates (Section 4.2)
// 3. **Direction Determination**: Decide YES or NO based on signals
// 4. **Kelly Sizing**: Compute optimal position size (Section 4.3)
// 5. **Risk Guards**: Apply all risk limits and circuit breakers (Section 5)
//
// **Output:**
// - Approved decisions include side, size, limit price, and reasoning
// - Rejected decisions include rejection reason and reasoning trail
//
// **Modes:**
// - Paper mode (default): Produces decisions for simulated execution
// - Live mode (disabled by default): Would route to real executor
// =============================================================================

const logger = createLogger('decision-service');

export interface DecisionConfig {
  /** Minimum anomaly score to consider trading */
  minAnomalyScore: number;
  /** Minimum execution score to consider trading */
  minExecutionScore: number;
  /** Minimum edge score to consider trading */
  minEdgeScore: number;
  /** Paper mode flag */
  paperMode: boolean;
}

export interface DecisionInput {
  tokenId: string;
  conditionId: string;
  marketCloseTime: number;
  currentMid: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  topOfBookDepth: number;
  scores: CompositeScore;
  features: FeatureVector;
}

export interface DecisionResult {
  decision: Decision;
  sizing: SizingResult | null;
  riskCheck: RiskCheckResult | null;
  reasoning: string[];
}

const DEFAULT_CONFIG: DecisionConfig = {
  minAnomalyScore: parseFloat(process.env.MIN_ANOMALY_SCORE ?? '0.65'),
  minExecutionScore: parseFloat(process.env.MIN_EXECUTION_SCORE ?? '0.55'),
  // Lower edge threshold for orderbook-only signals (no trade data available without API auth)
  minEdgeScore: parseFloat(process.env.MIN_EDGE_SCORE ?? '0.05'),
  paperMode: process.env.PAPER_MODE !== 'false',
};

export class DecisionService {
  private config: DecisionConfig;
  private redis: Redis;
  private kellySizing: KellySizingService;
  private riskGuards: RiskGuards;
  private stalenessGuards: StalenessGuards;

  constructor(
    redis: Redis,
    kellySizing: KellySizingService,
    riskGuards: RiskGuards,
    stalenessGuards: StalenessGuards,
    config: Partial<DecisionConfig> = {}
  ) {
    this.redis = redis;
    this.kellySizing = kellySizing;
    this.riskGuards = riskGuards;
    this.stalenessGuards = stalenessGuards;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Make a trading decision based on scores and features.
   */
  async makeDecision(input: DecisionInput): Promise<DecisionResult> {
    const reasoning: string[] = [];
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Base decision structure
    const decision: Partial<Decision> & {
      tokenId: string;
      conditionId: string;
      timestamp: number;
      action: 'NO_TRADE' | 'HOLD' | 'BUY' | 'SELL';
      currentMid: number;
      paperMode: boolean;
    } = {
      id: crypto.randomUUID(),
      tokenId: input.tokenId,
      conditionId: input.conditionId,
      timestamp: now,
      action: 'NO_TRADE',
      side: null,
      direction: null,
      targetPrice: null,
      limitPrice: null,
      currentMid: input.currentMid,
      sizing: null,
      targetSizeUsd: null,
      targetSizeShares: null,
      scores: input.scores,
      signalStrength: input.scores.signalStrength,
      features: input.features,
      approved: false,
      rejectionReason: null,
      riskChecksPassed: false,
      createdAt: nowIso,
      expiresAt: new Date(now + 30000).toISOString(), // 30 second expiry
      paperMode: this.config.paperMode,
    };

    // 1. Check data freshness
    const freshness = await this.stalenessGuards.checkFreshness(input.tokenId);
    if (!freshness.allFresh) {
      decision.rejectionReason = 'STALE_DATA' as RejectionReason;
      reasoning.push(`Data staleness detected: ${freshness.staleComponents.join(', ')}`);
      return { decision: decision as Decision, sizing: null, riskCheck: null, reasoning };
    }
    reasoning.push('Data freshness check passed');

    // 2. Check minimum score thresholds
    const anomalyScoreValue = input.scores.anomalyScore.score;
    const executionScoreValue = input.scores.executionScore.score;
    const edgeScoreValue = input.scores.edgeScore.score;

    if (anomalyScoreValue < this.config.minAnomalyScore) {
      decision.rejectionReason = 'BELOW_ANOMALY_THRESHOLD' as RejectionReason;
      reasoning.push(
        `Anomaly score ${anomalyScoreValue.toFixed(3)} below threshold ${this.config.minAnomalyScore}`
      );
      return { decision: decision as Decision, sizing: null, riskCheck: null, reasoning };
    }
    reasoning.push(
      `Anomaly score ${anomalyScoreValue.toFixed(3)} >= ${this.config.minAnomalyScore}`
    );

    if (executionScoreValue < this.config.minExecutionScore) {
      decision.rejectionReason = 'BELOW_EXECUTION_THRESHOLD' as RejectionReason;
      reasoning.push(
        `Execution score ${executionScoreValue.toFixed(3)} below threshold ${this.config.minExecutionScore}`
      );
      return { decision: decision as Decision, sizing: null, riskCheck: null, reasoning };
    }
    reasoning.push(
      `Execution score ${executionScoreValue.toFixed(3)} >= ${this.config.minExecutionScore}`
    );

    if (edgeScoreValue < this.config.minEdgeScore) {
      decision.rejectionReason = 'BELOW_EDGE_THRESHOLD' as RejectionReason;
      reasoning.push(
        `Edge score ${edgeScoreValue.toFixed(3)} below threshold ${this.config.minEdgeScore}`
      );
      return { decision: decision as Decision, sizing: null, riskCheck: null, reasoning };
    }
    reasoning.push(
      `Edge score ${edgeScoreValue.toFixed(3)} >= ${this.config.minEdgeScore}`
    );

    // 3. Determine trade direction based on signals
    const tradeDirection = this.determineDirection(input);
    if (!tradeDirection) {
      decision.rejectionReason = 'RISK_CHECK_FAILED' as RejectionReason;
      reasoning.push('Could not determine clear trade direction from signals');
      return { decision: decision as Decision, sizing: null, riskCheck: null, reasoning };
    }
    reasoning.push(`Determined trade direction: ${tradeDirection}`);

    // 4. Get portfolio state for sizing
    const portfolioState = await this.getPortfolioState(input.tokenId);

    // 5. Compute Kelly sizing
    const sizing = this.kellySizing.computeSize({
      scores: input.scores,
      currentPrice: input.currentMid,
      bankroll: portfolioState.bankroll,
      existingPositionSize: portfolioState.existingPositionSize,
    });
    reasoning.push(
      `Kelly sizing: raw=${sizing.kellyRaw.toFixed(4)}, adjusted=${sizing.kellyAdjusted.toFixed(4)}, size=$${sizing.targetSizeUsd.toFixed(2)}`
    );

    if (sizing.targetSizeUsd <= 0) {
      decision.rejectionReason = 'INSUFFICIENT_LIQUIDITY' as RejectionReason;
      reasoning.push(`Size is zero: ${sizing.cappedReason}`);
      return { decision: decision as Decision, sizing, riskCheck: null, reasoning };
    }

    // 6. Run risk checks
    const riskCheck = await this.riskGuards.checkRisk({
      tokenId: input.tokenId,
      conditionId: input.conditionId,
      marketCloseTime: input.marketCloseTime,
      currentTime: now,
      proposedSizeUsd: sizing.targetSizeUsd,
      bankroll: portfolioState.bankroll,
      totalExposure: portfolioState.totalExposure,
      existingPositionSize: portfolioState.existingPositionSize,
      dailyPnl: portfolioState.dailyPnl,
      drawdownPct: portfolioState.drawdownPct,
      consecutiveLosses: portfolioState.consecutiveLosses,
      spread: input.spread,
      topOfBookDepth: input.topOfBookDepth,
      lastBookUpdateMs: freshness.bookAgeMs ? now - freshness.bookAgeMs : 0,
      lastTradeUpdateMs: freshness.tradeAgeMs ? now - freshness.tradeAgeMs : 0,
    });

    if (!riskCheck.approved) {
      decision.rejectionReason = 'RISK_CHECK_FAILED' as RejectionReason;
      reasoning.push(`Risk check failed: ${riskCheck.rejectionReasons.join(', ')}`);
      return { decision: decision as Decision, sizing, riskCheck, reasoning };
    }
    reasoning.push('Risk check passed');

    // 7. Build approved decision
    decision.action = tradeDirection === 'YES' ? 'BUY' : 'SELL';
    decision.side = tradeDirection;
    decision.direction = tradeDirection === 'YES' ? 'BUY' : 'SELL';
    decision.targetPrice = tradeDirection === 'YES' ? input.bestAsk : input.bestBid;
    decision.limitPrice = this.computeLimitPrice(
      tradeDirection,
      input.bestBid,
      input.bestAsk,
      input.spread
    );
    decision.currentMid = input.currentMid;
    decision.targetSizeUsd = riskCheck.adjustedSizeUsd;
    decision.targetSizeShares = riskCheck.adjustedSizeUsd / (decision.targetPrice ?? 1);
    decision.approved = true;
    decision.riskChecksPassed = true;
    decision.expiresAt = new Date(now + 30000).toISOString(); // 30 second expiry

    reasoning.push(
      `Decision: ${decision.action} ${decision.side} $${decision.targetSizeUsd.toFixed(2)} @ ${decision.limitPrice?.toFixed(4)}`
    );

    // Cache decision
    await this.cacheDecision(decision as Decision);

    logger.info(
      {
        tokenId: input.tokenId,
        action: decision.action,
        side: decision.side,
        size: decision.targetSizeUsd,
        compositeScore: decision.scores?.compositeScore,
      },
      'Decision made'
    );

    return { decision: decision as Decision, sizing, riskCheck, reasoning };
  }

  /**
   * Determine trade direction based on book imbalance and other signals.
   */
  private determineDirection(input: DecisionInput): 'YES' | 'NO' | null {
    // Primary signal: book imbalance
    // Positive imbalance (more bids) suggests price going up → buy YES
    // Negative imbalance (more asks) suggests price going down → buy NO
    const imbalance = input.features.orderbook.bookImbalanceScore;
    const thinOpposite = input.features.orderbook.thinOppositeScore;

    // Need clear directional signal
    if (Math.abs(imbalance) < 0.2) {
      return null; // No clear direction
    }

    // Imbalance > 0 means bid depth > ask depth → expect price increase → buy YES
    // Imbalance < 0 means ask depth > bid depth → expect price decrease → buy NO
    if (imbalance > 0 && thinOpposite > 0.5) {
      return 'YES';
    } else if (imbalance < 0 && thinOpposite > 0.5) {
      return 'NO';
    }

    // Fallback: use raw imbalance sign
    return imbalance > 0 ? 'YES' : 'NO';
  }

  /**
   * Compute limit price with buffer.
   */
  private computeLimitPrice(
    direction: 'YES' | 'NO',
    bestBid: number,
    bestAsk: number,
    spreadBps: number
  ): number {
    // Add a small buffer (half spread) to improve fill probability
    const buffer = (spreadBps / 10000) * 0.5;

    if (direction === 'YES') {
      // Buying YES: willing to pay slightly above best ask
      return Math.min(bestAsk + buffer, 0.99);
    } else {
      // Buying NO (selling YES): willing to accept slightly below best bid
      return Math.max(bestBid - buffer, 0.01);
    }
  }

  /**
   * Get portfolio state from Redis.
   */
  private async getPortfolioState(tokenId: string): Promise<{
    bankroll: number;
    totalExposure: number;
    existingPositionSize: number;
    dailyPnl: number;
    drawdownPct: number;
    consecutiveLosses: number;
  }> {
    const [bankrollStr, exposureStr, positionStr, pnlStr, drawdownStr, lossesStr] =
      await Promise.all([
        this.redis.get(RedisKeys.paperBankroll()),
        this.redis.get(RedisKeys.totalExposure()),
        this.redis.hget(RedisKeys.positionSize(), tokenId),
        this.redis.get(RedisKeys.dailyPnl()),
        this.redis.get(RedisKeys.drawdownPct()),
        this.redis.get(RedisKeys.consecutiveLosses()),
      ]);

    return {
      bankroll: bankrollStr ? parseFloat(bankrollStr) : 10000,
      totalExposure: exposureStr ? parseFloat(exposureStr) : 0,
      existingPositionSize: positionStr ? parseFloat(positionStr) : 0,
      dailyPnl: pnlStr ? parseFloat(pnlStr) : 0,
      drawdownPct: drawdownStr ? parseFloat(drawdownStr) : 0,
      consecutiveLosses: lossesStr ? parseInt(lossesStr, 10) : 0,
    };
  }

  /**
   * Cache decision in Redis.
   */
  private async cacheDecision(decision: Decision): Promise<void> {
    const key = RedisKeys.decisionCache(decision.tokenId);
    await this.redis.set(key, JSON.stringify(decision), 'EX', 60);
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<DecisionConfig>): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'Decision config updated');
  }

  /**
   * Get current configuration.
   */
  getConfig(): DecisionConfig {
    return { ...this.config };
  }
}

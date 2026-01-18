import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';

// =============================================================================
// Risk Guards
// =============================================================================
//
// This module implements the non-negotiable risk guardrails as specified in
// CLAUDE.md Section 5. These guards are the last line of defense before any
// trade is executed (paper or live).
//
// **Risk Limits (Section 5.1 - Bankroll):**
// - Max single bet: 2% of bankroll
// - Max position per market: 5% of bankroll
// - Max total exposure: 10% of bankroll
//
// **Circuit Breakers (Section 5.1):**
// - Daily loss limit: 5% → halt all trading
// - Max drawdown: 15% → halt all trading
// - Consecutive losses: 5 → halt all trading
//
// **Execution Limits (Section 5.2):**
// - Max spread threshold: 500 bps (5%)
// - Min depth threshold: $100
// - Data staleness: 10 seconds
// - No-trade zone: 120 seconds before close
//
// **Safety Philosophy:**
// All guards apply conservatively - if in doubt, reject the trade. Risk checks
// are logged for audit trail. Circuit breakers require manual reset.
// =============================================================================

const logger = createLogger('risk-guards');

export interface RiskGuardConfig {
  /** Maximum total exposure as fraction of bankroll */
  maxExposurePct: number;
  /** Maximum single bet as fraction of bankroll */
  maxSingleBetPct: number;
  /** Maximum single position as fraction of bankroll */
  maxPositionPct: number;
  /** Daily loss limit as fraction of bankroll (circuit breaker) */
  dailyLossLimitPct: number;
  /** Maximum drawdown as fraction (circuit breaker) */
  maxDrawdownPct: number;
  /** Consecutive loss limit (circuit breaker) */
  consecutiveLossLimit: number;
  /** No-trade zone before market close in seconds */
  noTradeZoneSeconds: number;
  /** Data staleness threshold in milliseconds */
  stalenessThresholdMs: number;
  /** Minimum spread threshold (reject if spread > threshold) */
  maxSpreadBps: number;
  /** Minimum depth threshold in USD */
  minDepthUsd: number;
}

export interface RiskCheckInput {
  tokenId: string;
  conditionId: string;
  marketCloseTime: number;
  currentTime: number;
  proposedSizeUsd: number;
  bankroll: number;
  totalExposure: number;
  existingPositionSize: number;
  dailyPnl: number;
  drawdownPct: number;
  consecutiveLosses: number;
  spread: number;
  topOfBookDepth: number;
  lastBookUpdateMs: number;
  lastTradeUpdateMs: number;
}

export interface RiskCheckResult {
  approved: boolean;
  rejectionReasons: string[];
  warnings: string[];
  adjustedSizeUsd: number;
  checksPerformed: string[];
}

const DEFAULT_CONFIG: RiskGuardConfig = {
  maxExposurePct: 0.10,
  maxSingleBetPct: 0.02,
  maxPositionPct: 0.05,
  dailyLossLimitPct: 0.05,
  maxDrawdownPct: 0.15,
  consecutiveLossLimit: 5,
  noTradeZoneSeconds: 120,
  stalenessThresholdMs: 10000,
  maxSpreadBps: 500, // 5%
  minDepthUsd: 100,
};

export class RiskGuards {
  private config: RiskGuardConfig;
  private redis: Redis;
  private circuitBreakerActive: boolean = false;

  constructor(redis: Redis, config: Partial<RiskGuardConfig> = {}) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Perform all risk checks on a proposed trade.
   */
  async checkRisk(input: RiskCheckInput): Promise<RiskCheckResult> {
    const rejectionReasons: string[] = [];
    const warnings: string[] = [];
    const checksPerformed: string[] = [];
    let adjustedSizeUsd = input.proposedSizeUsd;

    // 1. Circuit breaker check
    checksPerformed.push('circuit_breaker');
    if (this.circuitBreakerActive) {
      rejectionReasons.push('circuit_breaker_active');
    }

    // Check if circuit breaker should be activated
    await this.checkCircuitBreakers(input, rejectionReasons, warnings);

    // 2. No-trade zone check
    checksPerformed.push('no_trade_zone');
    const timeToClose = (input.marketCloseTime - input.currentTime) / 1000;
    if (timeToClose <= this.config.noTradeZoneSeconds) {
      rejectionReasons.push(
        `no_trade_zone: ${timeToClose.toFixed(0)}s to close (limit: ${this.config.noTradeZoneSeconds}s)`
      );
    }

    // 3. Data staleness check
    checksPerformed.push('data_staleness');
    const bookAge = input.currentTime - input.lastBookUpdateMs;
    const tradeAge = input.currentTime - input.lastTradeUpdateMs;

    if (bookAge > this.config.stalenessThresholdMs) {
      rejectionReasons.push(
        `stale_book_data: ${bookAge}ms old (limit: ${this.config.stalenessThresholdMs}ms)`
      );
    }
    if (tradeAge > this.config.stalenessThresholdMs) {
      warnings.push(
        `stale_trade_data: ${tradeAge}ms old (limit: ${this.config.stalenessThresholdMs}ms)`
      );
    }

    // 4. Spread check
    checksPerformed.push('spread_limit');
    if (input.spread > this.config.maxSpreadBps) {
      rejectionReasons.push(
        `spread_too_wide: ${input.spread}bps (limit: ${this.config.maxSpreadBps}bps)`
      );
    }

    // 5. Depth check
    checksPerformed.push('depth_limit');
    if (input.topOfBookDepth < this.config.minDepthUsd) {
      rejectionReasons.push(
        `insufficient_depth: $${input.topOfBookDepth.toFixed(2)} (limit: $${this.config.minDepthUsd})`
      );
    }

    // 6. Single bet size limit
    checksPerformed.push('single_bet_limit');
    const maxSingleBet = input.bankroll * this.config.maxSingleBetPct;
    if (adjustedSizeUsd > maxSingleBet) {
      adjustedSizeUsd = maxSingleBet;
      warnings.push(
        `size_capped_single_bet: ${input.proposedSizeUsd.toFixed(2)} → ${maxSingleBet.toFixed(2)}`
      );
    }

    // 7. Position limit check
    checksPerformed.push('position_limit');
    const maxPosition = input.bankroll * this.config.maxPositionPct;
    const proposedTotalPosition = input.existingPositionSize + adjustedSizeUsd;
    if (proposedTotalPosition > maxPosition) {
      const allowedSize = maxPosition - input.existingPositionSize;
      if (allowedSize <= 0) {
        rejectionReasons.push(
          `position_limit_exceeded: existing $${input.existingPositionSize.toFixed(2)} >= limit $${maxPosition.toFixed(2)}`
        );
        adjustedSizeUsd = 0;
      } else {
        adjustedSizeUsd = allowedSize;
        warnings.push(
          `size_capped_position: ${input.proposedSizeUsd.toFixed(2)} → ${allowedSize.toFixed(2)}`
        );
      }
    }

    // 8. Total exposure limit
    checksPerformed.push('exposure_limit');
    const maxExposure = input.bankroll * this.config.maxExposurePct;
    const proposedTotalExposure = input.totalExposure + adjustedSizeUsd;
    if (proposedTotalExposure > maxExposure) {
      const allowedSize = maxExposure - input.totalExposure;
      if (allowedSize <= 0) {
        rejectionReasons.push(
          `exposure_limit_exceeded: total $${input.totalExposure.toFixed(2)} >= limit $${maxExposure.toFixed(2)}`
        );
        adjustedSizeUsd = 0;
      } else if (allowedSize < adjustedSizeUsd) {
        adjustedSizeUsd = allowedSize;
        warnings.push(
          `size_capped_exposure: → ${allowedSize.toFixed(2)}`
        );
      }
    }

    const approved = rejectionReasons.length === 0 && adjustedSizeUsd > 0;

    const result: RiskCheckResult = {
      approved,
      rejectionReasons,
      warnings,
      adjustedSizeUsd,
      checksPerformed,
    };

    logger.info(
      {
        tokenId: input.tokenId,
        approved,
        rejectionReasons,
        warnings,
        proposedSize: input.proposedSizeUsd,
        adjustedSize: adjustedSizeUsd,
      },
      'Risk check completed'
    );

    return result;
  }

  /**
   * Check and potentially activate circuit breakers.
   */
  private async checkCircuitBreakers(
    input: RiskCheckInput,
    rejectionReasons: string[],
    warnings: string[]
  ): Promise<void> {
    // Daily loss limit
    const dailyLossLimit = input.bankroll * this.config.dailyLossLimitPct;
    if (input.dailyPnl < -dailyLossLimit) {
      this.circuitBreakerActive = true;
      rejectionReasons.push(
        `daily_loss_circuit_breaker: $${(-input.dailyPnl).toFixed(2)} loss > $${dailyLossLimit.toFixed(2)} limit`
      );
      await this.recordCircuitBreaker('daily_loss');
    } else if (input.dailyPnl < -dailyLossLimit * 0.8) {
      warnings.push(
        `approaching_daily_loss_limit: $${(-input.dailyPnl).toFixed(2)} / $${dailyLossLimit.toFixed(2)}`
      );
    }

    // Drawdown limit
    if (input.drawdownPct > this.config.maxDrawdownPct) {
      this.circuitBreakerActive = true;
      rejectionReasons.push(
        `drawdown_circuit_breaker: ${(input.drawdownPct * 100).toFixed(1)}% > ${(this.config.maxDrawdownPct * 100).toFixed(1)}% limit`
      );
      await this.recordCircuitBreaker('max_drawdown');
    } else if (input.drawdownPct > this.config.maxDrawdownPct * 0.8) {
      warnings.push(
        `approaching_drawdown_limit: ${(input.drawdownPct * 100).toFixed(1)}% / ${(this.config.maxDrawdownPct * 100).toFixed(1)}%`
      );
    }

    // Consecutive losses
    if (input.consecutiveLosses >= this.config.consecutiveLossLimit) {
      this.circuitBreakerActive = true;
      rejectionReasons.push(
        `consecutive_loss_circuit_breaker: ${input.consecutiveLosses} >= ${this.config.consecutiveLossLimit} limit`
      );
      await this.recordCircuitBreaker('consecutive_losses');
    } else if (input.consecutiveLosses >= this.config.consecutiveLossLimit - 1) {
      warnings.push(
        `approaching_consecutive_loss_limit: ${input.consecutiveLosses} / ${this.config.consecutiveLossLimit}`
      );
    }
  }

  /**
   * Record circuit breaker activation in Redis.
   */
  private async recordCircuitBreaker(reason: string): Promise<void> {
    const key = RedisKeys.circuitBreaker();
    await this.redis.hset(key, {
      active: 'true',
      reason,
      activatedAt: Date.now().toString(),
    });
    await this.redis.expire(key, 86400); // 24 hour TTL

    logger.warn({ reason }, 'Circuit breaker activated');
  }

  /**
   * Manually reset circuit breaker (requires admin action).
   */
  async resetCircuitBreaker(): Promise<void> {
    this.circuitBreakerActive = false;
    const key = RedisKeys.circuitBreaker();
    await this.redis.del(key);
    logger.info('Circuit breaker reset');
  }

  /**
   * Check if circuit breaker is currently active.
   */
  async isCircuitBreakerActive(): Promise<boolean> {
    const key = RedisKeys.circuitBreaker();
    const active = await this.redis.hget(key, 'active');
    this.circuitBreakerActive = active === 'true';
    return this.circuitBreakerActive;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<RiskGuardConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Risk guard config updated');
  }

  /**
   * Get current configuration.
   */
  getConfig(): RiskGuardConfig {
    return { ...this.config };
  }
}

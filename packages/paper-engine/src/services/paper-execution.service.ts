import { createLogger, type Decision, type OrderbookSnapshot } from '@polymarketbot/shared';

// =============================================================================
// Paper Execution Service
// =============================================================================
//
// This service simulates order execution for paper trading mode. It provides
// realistic fill simulation by:
//
// 1. **Order Book Walking**: Consume liquidity level by level
// 2. **Slippage Modeling**: Base slippage + size-dependent market impact
// 3. **Fill Constraints**: Minimum fill rate, maximum slippage
//
// **Execution Model:**
// For a BUY order (buying YES tokens):
// - Walk the ASK side of the book (sellers of YES)
// - Consume liquidity until target size filled or limit hit
// - Calculate volume-weighted average price (VWAP)
// - Apply simulated market impact
//
// For a SELL order (buying NO / selling YES):
// - Walk the BID side of the book (buyers of YES)
// - Same process but in opposite direction
//
// **Market Impact Model:**
// ```
// impact_bps = base_slippage + size_factor * log(1 + size/1000)
// ```
//
// This simulates the reality that larger orders have proportionally larger
// market impact due to information leakage and liquidity consumption.
// =============================================================================

const logger = createLogger('paper-execution-service');

export interface ExecutionConfig {
  /** Base slippage in basis points */
  baseSlippageBps: number;
  /** Size impact factor for slippage calculation */
  sizeImpactFactor: number;
  /** Maximum slippage allowed in basis points */
  maxSlippageBps: number;
  /** Minimum fill rate (0-1) */
  minFillRate: number;
}

export interface FillResult {
  filled: boolean;
  fillPrice: number;
  fillSize: number;
  fillSizeUsd: number;
  slippageBps: number;
  unfilled: number;
  unfilledReason: string | null;
  executionTimestamp: number;
}

const DEFAULT_CONFIG: ExecutionConfig = {
  baseSlippageBps: 10,
  sizeImpactFactor: 0.5,
  maxSlippageBps: 200,
  minFillRate: 0.5,
};

export class PaperExecutionService {
  private config: ExecutionConfig;

  constructor(config: Partial<ExecutionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Simulate order execution by walking the order book.
   *
   * For a BUY order (buying YES tokens):
   * - We consume ask levels (sellers of YES)
   * - Fill price increases as we consume more liquidity
   *
   * For a SELL order (selling YES tokens / buying NO):
   * - We consume bid levels (buyers of YES)
   * - Fill price decreases as we consume more liquidity
   */
  simulateFill(
    decision: Decision,
    orderbook: OrderbookSnapshot
  ): FillResult {
    const timestamp = Date.now();

    // Validate decision has required fields
    if (!decision.targetSizeUsd || !decision.limitPrice) {
      return {
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fillSizeUsd: 0,
        slippageBps: 0,
        unfilled: decision.targetSizeUsd ?? 0,
        unfilledReason: 'missing_decision_fields',
        executionTimestamp: timestamp,
      };
    }

    const targetSizeUsd = decision.targetSizeUsd;
    const limitPrice = decision.limitPrice;
    const isBuy = decision.action === 'BUY';

    // Select appropriate side of the book
    const levels = isBuy ? orderbook.asks : orderbook.bids;

    if (!levels || levels.length === 0) {
      return {
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fillSizeUsd: 0,
        slippageBps: 0,
        unfilled: targetSizeUsd,
        unfilledReason: 'no_liquidity',
        executionTimestamp: timestamp,
      };
    }

    // Walk the book and simulate fills
    let remainingUsd = targetSizeUsd;
    let totalShares = 0;
    let weightedPriceSum = 0;

    for (const level of levels) {
      const levelPrice = level.price;

      // Check limit price constraint
      if (isBuy && levelPrice > limitPrice) {
        break; // Price too high for buy
      }
      if (!isBuy && levelPrice < limitPrice) {
        break; // Price too low for sell
      }

      // Calculate how much we can fill at this level
      const levelLiquidityUsd = level.size * levelPrice;
      const fillUsdAtLevel = Math.min(remainingUsd, levelLiquidityUsd);
      const fillSharesAtLevel = fillUsdAtLevel / levelPrice;

      totalShares += fillSharesAtLevel;
      weightedPriceSum += levelPrice * fillSharesAtLevel;
      remainingUsd -= fillUsdAtLevel;

      if (remainingUsd <= 0) {
        break;
      }
    }

    // Calculate average fill price
    const avgFillPrice = totalShares > 0 ? weightedPriceSum / totalShares : 0;
    const filledUsd = targetSizeUsd - remainingUsd;

    // Calculate slippage
    const referencePriceForSlippage = isBuy ? orderbook.bestAsk : orderbook.bestBid;
    const slippageBps = referencePriceForSlippage
      ? Math.abs(avgFillPrice - referencePriceForSlippage) / referencePriceForSlippage * 10000
      : 0;

    // Apply additional simulated slippage (market impact)
    const additionalSlippageBps = this.calculateMarketImpact(targetSizeUsd);
    const totalSlippageBps = Math.min(
      slippageBps + additionalSlippageBps,
      this.config.maxSlippageBps
    );

    // Adjust fill price for market impact
    const impactMultiplier = isBuy
      ? 1 + (additionalSlippageBps / 10000)
      : 1 - (additionalSlippageBps / 10000);
    const adjustedFillPrice = avgFillPrice * impactMultiplier;

    // Check minimum fill rate
    const fillRate = filledUsd / targetSizeUsd;
    if (fillRate < this.config.minFillRate) {
      return {
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fillSizeUsd: 0,
        slippageBps: totalSlippageBps,
        unfilled: targetSizeUsd,
        unfilledReason: `insufficient_fill_rate: ${(fillRate * 100).toFixed(1)}% < ${(this.config.minFillRate * 100).toFixed(0)}%`,
        executionTimestamp: timestamp,
      };
    }

    // Check if slippage is acceptable
    if (totalSlippageBps > this.config.maxSlippageBps) {
      return {
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        fillSizeUsd: 0,
        slippageBps: totalSlippageBps,
        unfilled: targetSizeUsd,
        unfilledReason: `slippage_too_high: ${totalSlippageBps.toFixed(0)}bps > ${this.config.maxSlippageBps}bps`,
        executionTimestamp: timestamp,
      };
    }

    const result: FillResult = {
      filled: true,
      fillPrice: adjustedFillPrice,
      fillSize: totalShares,
      fillSizeUsd: filledUsd,
      slippageBps: totalSlippageBps,
      unfilled: remainingUsd,
      unfilledReason: remainingUsd > 0 ? 'partial_fill' : null,
      executionTimestamp: timestamp,
    };

    logger.info(
      {
        tokenId: decision.tokenId,
        action: decision.action,
        targetSize: targetSizeUsd,
        fillSize: filledUsd,
        fillPrice: adjustedFillPrice,
        slippageBps: totalSlippageBps,
      },
      'Paper execution simulated'
    );

    return result;
  }

  /**
   * Calculate market impact based on order size.
   * Uses a log model: impact = baseSlippage + sizeImpactFactor * log(1 + size/1000)
   */
  private calculateMarketImpact(sizeUsd: number): number {
    const logImpact = Math.log(1 + sizeUsd / 1000);
    const impact = this.config.baseSlippageBps + this.config.sizeImpactFactor * logImpact * 10;
    return Math.round(impact);
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<ExecutionConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Paper execution config updated');
  }

  /**
   * Get current configuration.
   */
  getConfig(): ExecutionConfig {
    return { ...this.config };
  }
}

import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import type { PaperPosition } from './position-tracker.service.js';

// =============================================================================
// P&L Calculator Service
// =============================================================================

const logger = createLogger('pnl-calculator-service');

export interface PnlSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
  dailyPnl: number;
  weeklyPnl: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  currentDrawdown: number;
  sharpeRatio: number | null;
}

export interface PositionPnl {
  tokenId: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  currentPrice: number;
  size: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export class PnlCalculatorService {
  private redis: Redis;
  private initialBankroll: number;

  constructor(redis: Redis, initialBankroll: number = 10000) {
    this.redis = redis;
    this.initialBankroll = initialBankroll;
  }

  /**
   * Calculate unrealized P&L for a position.
   */
  calculatePositionPnl(position: PaperPosition, currentPrice: number): PositionPnl {
    const priceChange = currentPrice - position.entryPrice;
    const direction = position.direction === 'LONG' ? 1 : -1;
    const unrealizedPnl = priceChange * position.size * direction;
    const unrealizedPnlPct = (unrealizedPnl / position.sizeUsd) * 100;

    return {
      tokenId: position.tokenId,
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice,
      size: position.size,
      unrealizedPnl,
      unrealizedPnlPct,
    };
  }

  /**
   * Calculate P&L for market resolution.
   *
   * For binary markets:
   * - If outcome is YES and we hold YES: payout = size * 1.0
   * - If outcome is NO and we hold YES: payout = 0
   * - If outcome is YES and we hold NO: payout = 0
   * - If outcome is NO and we hold NO: payout = size * 1.0
   */
  calculateResolutionPnl(
    position: PaperPosition,
    resolvedOutcome: 'YES' | 'NO'
  ): { exitPrice: number; realizedPnl: number; realizedPnlPct: number } {
    // Exit price is 1.0 if position wins, 0.0 if it loses
    const positionWins =
      (position.side === 'YES' && resolvedOutcome === 'YES') ||
      (position.side === 'NO' && resolvedOutcome === 'NO');

    const exitPrice = positionWins ? 1.0 : 0.0;

    // Calculate realized P&L
    // Profit = (exitPrice - entryPrice) * size
    const realizedPnl = (exitPrice - position.entryPrice) * position.size;
    const realizedPnlPct = (realizedPnl / position.sizeUsd) * 100;

    return {
      exitPrice,
      realizedPnl,
      realizedPnlPct,
    };
  }

  /**
   * Get comprehensive P&L summary.
   */
  async getPnlSummary(closedPositions: PaperPosition[]): Promise<PnlSummary> {
    // Get current state from Redis
    const [bankrollStr, dailyPnlStr, drawdownStr] = await Promise.all([
      this.redis.get(RedisKeys.paperBankroll()),
      this.redis.get(RedisKeys.dailyPnl()),
      this.redis.get(RedisKeys.drawdownPct()),
    ]);

    const currentBankroll = parseFloat(bankrollStr ?? this.initialBankroll.toString());
    const dailyPnl = parseFloat(dailyPnlStr ?? '0');
    const currentDrawdown = parseFloat(drawdownStr ?? '0');

    // Calculate realized P&L from closed positions
    let totalRealizedPnl = 0;
    let winCount = 0;
    let lossCount = 0;
    let totalWins = 0;
    let totalLosses = 0;
    const returns: number[] = [];

    for (const position of closedPositions) {
      if (position.realizedPnl !== null) {
        totalRealizedPnl += position.realizedPnl;

        if (position.realizedPnl > 0) {
          winCount++;
          totalWins += position.realizedPnl;
        } else if (position.realizedPnl < 0) {
          lossCount++;
          totalLosses += Math.abs(position.realizedPnl);
        }

        // Track returns for Sharpe calculation
        if (position.realizedPnlPct !== null) {
          returns.push(position.realizedPnlPct / 100);
        }
      }
    }

    // Calculate metrics
    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? winCount / totalTrades : 0;
    const avgWin = winCount > 0 ? totalWins / winCount : 0;
    const avgLoss = lossCount > 0 ? totalLosses / lossCount : 0;
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    // Calculate total unrealized P&L (would need open positions)
    const totalUnrealizedPnl = 0; // Caller should provide this

    // Calculate total P&L
    const totalPnl = totalRealizedPnl + totalUnrealizedPnl;

    // Calculate max drawdown (simplified - tracking peak)
    const peakBankroll = await this.redis.get('paper:peak_bankroll');
    const peak = parseFloat(peakBankroll ?? this.initialBankroll.toString());
    const maxDrawdown = peak > 0 ? (peak - currentBankroll) / peak : 0;

    // Update peak if current bankroll is higher
    if (currentBankroll > peak) {
      await this.redis.set('paper:peak_bankroll', currentBankroll.toString());
    }

    // Update current drawdown
    const newDrawdown = peak > 0 ? Math.max(0, (peak - currentBankroll) / peak) : 0;
    await this.redis.set(RedisKeys.drawdownPct(), newDrawdown.toString());

    // Calculate Sharpe ratio (annualized, assuming daily returns)
    let sharpeRatio: number | null = null;
    if (returns.length >= 5) {
      const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        // Annualize: multiply by sqrt(252) for daily returns
        sharpeRatio = (meanReturn / stdDev) * Math.sqrt(252);
      }
    }

    // Calculate weekly P&L (simplified - sum of last 7 days)
    const weeklyPnl = dailyPnl; // Would need historical tracking

    const summary: PnlSummary = {
      totalRealizedPnl,
      totalUnrealizedPnl,
      totalPnl,
      dailyPnl,
      weeklyPnl,
      winCount,
      lossCount,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      maxDrawdown,
      currentDrawdown: newDrawdown,
      sharpeRatio,
    };

    logger.debug(summary, 'P&L summary calculated');

    return summary;
  }

  /**
   * Reset daily P&L (call at midnight).
   */
  async resetDailyPnl(): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const currentDailyPnl = await this.redis.get(RedisKeys.dailyPnl());

    // Archive yesterday's P&L
    if (currentDailyPnl) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      await this.redis.set(RedisKeys.dailyPnlByDate(yesterday), currentDailyPnl);
    }

    // Reset current daily P&L
    await this.redis.set(RedisKeys.dailyPnl(), '0');

    logger.info({ date: today }, 'Daily P&L reset');
  }

  /**
   * Get historical daily P&L for a date range.
   */
  async getHistoricalPnl(startDate: string, endDate: string): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const pnl = await this.redis.get(RedisKeys.dailyPnlByDate(dateStr));
      if (pnl) {
        results.set(dateStr, parseFloat(pnl));
      }
    }

    return results;
  }
}

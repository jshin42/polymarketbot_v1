import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';
import type { FillResult } from './paper-execution.service.js';

// =============================================================================
// Position Tracker Service
// =============================================================================
//
// This service manages paper trading positions and P&L tracking. It maintains
// the complete lifecycle of a paper position:
//
// **Position Lifecycle:**
// 1. **Open**: Created when a paper trade fills
// 2. **Update**: Mark-to-market updates as prices change
// 3. **Close**: Resolved when market settles or manually closed
//
// **P&L Calculation:**
// - Unrealized P&L: (currentPrice - entryPrice) * size * direction
// - Realized P&L: Computed at close based on exit price
//
// **Portfolio State (stored in Redis):**
// - Open positions set: tokens with active positions
// - Position size hash: USD exposure per token
// - Total exposure: Sum of all position sizes
// - Daily P&L: Running total for circuit breaker checks
// - Consecutive losses: Counter for risk monitoring
// - Paper bankroll: Virtual capital tracking
//
// **Close Reasons:**
// - `market_resolution`: Binary option resolved to YES or NO
// - `manual`: User-initiated close
// - `stop_loss`: Automatic close on loss threshold
// - `expired`: Position expired without resolution
// =============================================================================

const logger = createLogger('position-tracker-service');

export interface PaperPosition {
  id: string;
  tokenId: string;
  conditionId: string;
  side: 'YES' | 'NO';
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  size: number;
  sizeUsd: number;
  entryTime: number;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  status: 'open' | 'closed' | 'expired';
  closeReason: string | null;
  exitPrice: number | null;
  exitTime: number | null;
  realizedPnl: number | null;
  realizedPnlPct: number | null;
}

export interface PositionUpdate {
  tokenId: string;
  currentPrice: number;
}

export class PositionTrackerService {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Create a new paper position from a fill result.
   */
  async openPosition(
    tokenId: string,
    conditionId: string,
    side: 'YES' | 'NO',
    direction: 'LONG' | 'SHORT',
    fill: FillResult
  ): Promise<PaperPosition> {
    const positionId = `paper-${tokenId}-${fill.executionTimestamp}`;

    const position: PaperPosition = {
      id: positionId,
      tokenId,
      conditionId,
      side,
      direction,
      entryPrice: fill.fillPrice,
      size: fill.fillSize,
      sizeUsd: fill.fillSizeUsd,
      entryTime: fill.executionTimestamp,
      currentPrice: fill.fillPrice,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      status: 'open',
      closeReason: null,
      exitPrice: null,
      exitTime: null,
      realizedPnl: null,
      realizedPnlPct: null,
    };

    // Store position in Redis
    const positionKey = RedisKeys.position(tokenId);
    await this.redis.hset(positionKey, {
      ...position,
      currentPrice: position.currentPrice?.toString() ?? '',
      unrealizedPnl: position.unrealizedPnl?.toString() ?? '',
      unrealizedPnlPct: position.unrealizedPnlPct?.toString() ?? '',
    });
    await this.redis.expire(positionKey, 86400 * 30); // 30 day TTL

    // Add to open positions set
    await this.redis.sadd(RedisKeys.openPositions(), tokenId);

    // Update position size hash
    const existingSize = await this.redis.hget(RedisKeys.positionSize(), tokenId);
    const newSize = (parseFloat(existingSize ?? '0') + fill.fillSizeUsd);
    await this.redis.hset(RedisKeys.positionSize(), tokenId, newSize.toString());

    // Update total exposure
    const totalExposure = await this.redis.get(RedisKeys.totalExposure());
    const newExposure = (parseFloat(totalExposure ?? '0') + fill.fillSizeUsd);
    await this.redis.set(RedisKeys.totalExposure(), newExposure.toString());

    logger.info(
      {
        positionId,
        tokenId,
        side,
        entryPrice: fill.fillPrice,
        size: fill.fillSizeUsd,
      },
      'Paper position opened'
    );

    return position;
  }

  /**
   * Update position with current market price.
   */
  async updatePosition(update: PositionUpdate): Promise<PaperPosition | null> {
    const { tokenId, currentPrice } = update;

    const positionKey = RedisKeys.position(tokenId);
    const positionData = await this.redis.hgetall(positionKey);

    if (!positionData || !positionData.id) {
      return null;
    }

    const position = this.deserializePosition(positionData);
    if (position.status !== 'open') {
      return position;
    }

    // Calculate unrealized P&L
    // For LONG YES: profit if price goes up
    // For SHORT (LONG NO): profit if price goes down
    const priceChange = currentPrice - position.entryPrice;
    const direction = position.direction === 'LONG' ? 1 : -1;
    const unrealizedPnl = priceChange * position.size * direction;
    const unrealizedPnlPct = (unrealizedPnl / position.sizeUsd) * 100;

    position.currentPrice = currentPrice;
    position.unrealizedPnl = unrealizedPnl;
    position.unrealizedPnlPct = unrealizedPnlPct;

    // Update in Redis
    await this.redis.hset(positionKey, {
      currentPrice: currentPrice.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      unrealizedPnlPct: unrealizedPnlPct.toString(),
    });

    return position;
  }

  /**
   * Close a position (on market resolution or manual close).
   */
  async closePosition(
    tokenId: string,
    exitPrice: number,
    closeReason: 'market_resolution' | 'manual' | 'stop_loss' | 'expired'
  ): Promise<PaperPosition | null> {
    const positionKey = RedisKeys.position(tokenId);
    const positionData = await this.redis.hgetall(positionKey);

    if (!positionData || !positionData.id) {
      return null;
    }

    const position = this.deserializePosition(positionData);
    if (position.status !== 'open') {
      return position;
    }

    const exitTime = Date.now();

    // Calculate realized P&L
    const priceChange = exitPrice - position.entryPrice;
    const direction = position.direction === 'LONG' ? 1 : -1;
    const realizedPnl = priceChange * position.size * direction;
    const realizedPnlPct = (realizedPnl / position.sizeUsd) * 100;

    position.status = 'closed';
    position.closeReason = closeReason;
    position.exitPrice = exitPrice;
    position.exitTime = exitTime;
    position.realizedPnl = realizedPnl;
    position.realizedPnlPct = realizedPnlPct;
    position.currentPrice = exitPrice;
    position.unrealizedPnl = 0;
    position.unrealizedPnlPct = 0;

    // Update in Redis
    await this.redis.hset(positionKey, {
      status: 'closed',
      closeReason,
      exitPrice: exitPrice.toString(),
      exitTime: exitTime.toString(),
      realizedPnl: realizedPnl.toString(),
      realizedPnlPct: realizedPnlPct.toString(),
      currentPrice: exitPrice.toString(),
      unrealizedPnl: '0',
      unrealizedPnlPct: '0',
    });

    // Remove from open positions
    await this.redis.srem(RedisKeys.openPositions(), tokenId);

    // Update position size hash
    await this.redis.hdel(RedisKeys.positionSize(), tokenId);

    // Update total exposure
    const totalExposure = await this.redis.get(RedisKeys.totalExposure());
    const newExposure = Math.max(0, parseFloat(totalExposure ?? '0') - position.sizeUsd);
    await this.redis.set(RedisKeys.totalExposure(), newExposure.toString());

    // Update daily P&L
    const dailyPnl = await this.redis.get(RedisKeys.dailyPnl());
    const newDailyPnl = parseFloat(dailyPnl ?? '0') + realizedPnl;
    await this.redis.set(RedisKeys.dailyPnl(), newDailyPnl.toString());

    // Update bankroll
    const bankroll = await this.redis.get(RedisKeys.paperBankroll());
    const newBankroll = parseFloat(bankroll ?? '10000') + realizedPnl;
    await this.redis.set(RedisKeys.paperBankroll(), newBankroll.toString());

    // Update consecutive losses/wins
    if (realizedPnl < 0) {
      await this.redis.incr(RedisKeys.consecutiveLosses());
    } else {
      await this.redis.set(RedisKeys.consecutiveLosses(), '0');
    }

    logger.info(
      {
        positionId: position.id,
        tokenId,
        exitPrice,
        realizedPnl,
        realizedPnlPct,
        closeReason,
      },
      'Paper position closed'
    );

    return position;
  }

  /**
   * Get all open positions.
   */
  async getOpenPositions(): Promise<PaperPosition[]> {
    const tokenIds = await this.redis.smembers(RedisKeys.openPositions());
    const positions: PaperPosition[] = [];

    for (const tokenId of tokenIds) {
      const positionKey = RedisKeys.position(tokenId);
      const positionData = await this.redis.hgetall(positionKey);
      if (positionData && positionData.id) {
        positions.push(this.deserializePosition(positionData));
      }
    }

    return positions;
  }

  /**
   * Get position for a specific token.
   */
  async getPosition(tokenId: string): Promise<PaperPosition | null> {
    const positionKey = RedisKeys.position(tokenId);
    const positionData = await this.redis.hgetall(positionKey);

    if (!positionData || !positionData.id) {
      return null;
    }

    return this.deserializePosition(positionData);
  }

  /**
   * Deserialize position from Redis hash.
   */
  private deserializePosition(data: Record<string, string>): PaperPosition {
    return {
      id: data.id,
      tokenId: data.tokenId,
      conditionId: data.conditionId,
      side: data.side as 'YES' | 'NO',
      direction: data.direction as 'LONG' | 'SHORT',
      entryPrice: parseFloat(data.entryPrice),
      size: parseFloat(data.size),
      sizeUsd: parseFloat(data.sizeUsd),
      entryTime: parseInt(data.entryTime, 10),
      currentPrice: data.currentPrice ? parseFloat(data.currentPrice) : null,
      unrealizedPnl: data.unrealizedPnl ? parseFloat(data.unrealizedPnl) : null,
      unrealizedPnlPct: data.unrealizedPnlPct ? parseFloat(data.unrealizedPnlPct) : null,
      status: data.status as 'open' | 'closed' | 'expired',
      closeReason: data.closeReason || null,
      exitPrice: data.exitPrice ? parseFloat(data.exitPrice) : null,
      exitTime: data.exitTime ? parseInt(data.exitTime, 10) : null,
      realizedPnl: data.realizedPnl ? parseFloat(data.realizedPnl) : null,
      realizedPnlPct: data.realizedPnlPct ? parseFloat(data.realizedPnlPct) : null,
    };
  }
}

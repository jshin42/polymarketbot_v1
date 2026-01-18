import { RedisKeys, createLogger, Redis } from '@polymarketbot/shared';

// =============================================================================
// Staleness Guards
// =============================================================================

const logger = createLogger('staleness-guards');

export interface StalenessConfig {
  /** Maximum age for orderbook data in milliseconds */
  maxBookAgeMs: number;
  /** Maximum age for trade data in milliseconds */
  maxTradeAgeMs: number;
  /** Maximum age for market metadata in milliseconds */
  maxMarketAgeMs: number;
  /** Maximum age for wallet data in milliseconds */
  maxWalletAgeMs: number;
}

export interface DataFreshness {
  bookAgeMs: number | null;
  tradeAgeMs: number | null;
  marketAgeMs: number | null;
  walletAgeMs: number | null;
  allFresh: boolean;
  staleComponents: string[];
}

const DEFAULT_CONFIG: StalenessConfig = {
  maxBookAgeMs: 10000,
  maxTradeAgeMs: 15000,
  maxMarketAgeMs: 300000, // 5 minutes
  maxWalletAgeMs: 3600000, // 1 hour
};

export class StalenessGuards {
  private config: StalenessConfig;
  private redis: Redis;

  constructor(redis: Redis, config: Partial<StalenessConfig> = {}) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check data freshness for a token.
   */
  async checkFreshness(tokenId: string): Promise<DataFreshness> {
    const now = Date.now();
    const staleComponents: string[] = [];

    // Get condition ID for market lookup
    const conditionId = await this.redis.get(RedisKeys.tokenToCondition(tokenId));

    // Get last update timestamps
    // Note: Collector writes to 'orderbook' not 'book', and market metadata is cached separately
    const [bookTs, tradeTs, marketMetadata] = await Promise.all([
      this.redis.get(RedisKeys.lastUpdate('orderbook', tokenId)),
      this.redis.get(RedisKeys.lastUpdate('trade', tokenId)),
      conditionId ? this.redis.get(RedisKeys.marketMetadata(conditionId)) : null,
    ]);

    // Calculate ages
    const bookAgeMs = bookTs ? now - parseInt(bookTs, 10) : null;
    const tradeAgeMs = tradeTs ? now - parseInt(tradeTs, 10) : null;
    // Market metadata exists if we have it cached (TTL is 5 minutes)
    const marketAgeMs = marketMetadata ? 0 : null; // If exists, consider fresh (has its own TTL)

    // Check staleness - only require orderbook data to be fresh
    // Trade data is nice-to-have but not required (market might be quiet)
    if (bookAgeMs === null || bookAgeMs > this.config.maxBookAgeMs) {
      staleComponents.push('orderbook');
    }
    // Make trades optional - don't block if no trades, just if stale
    if (tradeAgeMs !== null && tradeAgeMs > this.config.maxTradeAgeMs) {
      staleComponents.push('trades');
    }
    // Market metadata is required
    if (marketAgeMs === null) {
      staleComponents.push('market');
    }

    const result: DataFreshness = {
      bookAgeMs,
      tradeAgeMs,
      marketAgeMs,
      walletAgeMs: null, // Checked separately per wallet
      allFresh: staleComponents.length === 0,
      staleComponents,
    };

    if (!result.allFresh) {
      logger.warn(
        { tokenId, staleComponents, bookAgeMs, tradeAgeMs, marketAgeMs },
        'Stale data detected'
      );
    }

    return result;
  }

  /**
   * Check if wallet data is fresh.
   */
  async checkWalletFreshness(walletAddress: string): Promise<{
    fresh: boolean;
    ageMs: number | null;
  }> {
    const now = Date.now();
    const walletTs = await this.redis.get(
      RedisKeys.lastUpdate('wallet', walletAddress)
    );

    if (!walletTs) {
      return { fresh: false, ageMs: null };
    }

    const ageMs = now - parseInt(walletTs, 10);
    const fresh = ageMs <= this.config.maxWalletAgeMs;

    return { fresh, ageMs };
  }

  /**
   * Record a data update timestamp.
   */
  async recordUpdate(
    dataType: 'book' | 'trade' | 'market' | 'wallet',
    entityId: string
  ): Promise<void> {
    const key = RedisKeys.lastUpdate(dataType, entityId);
    await this.redis.set(key, Date.now().toString(), 'EX', 3600);
  }

  /**
   * Check if any critical data is stale across all tracked tokens.
   */
  async checkSystemHealth(): Promise<{
    healthy: boolean;
    tokensWithStaleData: string[];
    summary: Record<string, string[]>;
  }> {
    const trackedTokens = await this.redis.smembers(RedisKeys.trackedTokens());
    const tokensWithStaleData: string[] = [];
    const summary: Record<string, string[]> = {};

    for (const tokenId of trackedTokens) {
      const freshness = await this.checkFreshness(tokenId);
      if (!freshness.allFresh) {
        tokensWithStaleData.push(tokenId);
        summary[tokenId] = freshness.staleComponents;
      }
    }

    const healthy = tokensWithStaleData.length === 0;

    if (!healthy) {
      logger.warn(
        { tokensWithStaleData: tokensWithStaleData.length, summary },
        'System health check failed - stale data detected'
      );
    }

    return {
      healthy,
      tokensWithStaleData,
      summary,
    };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<StalenessConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Staleness config updated');
  }

  /**
   * Get current configuration.
   */
  getConfig(): StalenessConfig {
    return { ...this.config };
  }
}

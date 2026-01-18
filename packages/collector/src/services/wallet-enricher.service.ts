import { RedisKeys, RedisTTL, createLogger, type Redis } from '@polymarketbot/shared';
import { PolygonscanClient } from '../clients/polygonscan.client.js';

// =============================================================================
// Wallet Enricher Service
// =============================================================================
//
// This service provides real wallet age and activity data from Polygonscan,
// with Redis caching to minimize API calls. Wallet data is cached for 30 days
// since wallet first-seen timestamps don't change.
//
// Key features:
// - Fetches real on-chain first-seen timestamps from Polygonscan
// - Caches results in Redis to avoid repeated API calls
// - Provides transaction count for activity scoring
// - Graceful fallback when Polygonscan API is unavailable
// =============================================================================

const logger = createLogger('wallet-enricher');

export interface WalletEnrichment {
  /** Wallet address (lowercase) */
  address: string;
  /** First transaction timestamp (ms since epoch), null if never transacted */
  firstSeenTimestamp: number | null;
  /** First transaction block number */
  firstSeenBlockNumber: number | null;
  /** Total transaction count (outgoing) */
  transactionCount: number;
  /** When this data was fetched (ms since epoch) */
  enrichedAt: number;
  /** Source of the data: 'polygonscan' if fetched, 'cache' if from Redis, 'fallback' if API failed */
  source: 'polygonscan' | 'cache' | 'fallback';
}

export interface WalletEnricherConfig {
  /** Polygonscan API key */
  polygonscanApiKey: string;
  /** Cache TTL in seconds (default: 30 days) */
  cacheTtlSeconds?: number;
  /** Request timeout in ms (default: 30s) */
  timeoutMs?: number;
}

export class WalletEnricherService {
  private readonly polygonscanClient: PolygonscanClient;
  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    config: WalletEnricherConfig
  ) {
    this.polygonscanClient = new PolygonscanClient({
      apiKey: config.polygonscanApiKey,
      timeout: config.timeoutMs ?? 30000,
    });
    this.cacheTtlSeconds = config.cacheTtlSeconds ?? RedisTTL.walletCache;
  }

  /**
   * Enrich a wallet address with on-chain data.
   *
   * First checks Redis cache, then falls back to Polygonscan API.
   * Results are cached for 30 days by default.
   *
   * @param address - Ethereum wallet address (0x-prefixed)
   * @returns WalletEnrichment with first-seen timestamp and transaction count
   */
  async enrichWallet(address: string): Promise<WalletEnrichment> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = RedisKeys.walletCache(normalizedAddress);

    // Check cache first
    const cached = await this.redis.hgetall(cacheKey);
    if (cached && cached.enrichedAt) {
      logger.debug({ address: normalizedAddress }, 'Wallet data found in cache');
      return this.parseCache(normalizedAddress, cached);
    }

    // Fetch from Polygonscan
    logger.info({ address: normalizedAddress }, 'Fetching wallet data from Polygonscan');

    try {
      const result = await this.polygonscanClient.getWalletFirstSeen(normalizedAddress);
      const now = Date.now();

      const enrichment: WalletEnrichment = {
        address: normalizedAddress,
        firstSeenTimestamp: result.firstSeenTimestamp,
        firstSeenBlockNumber: result.firstSeenBlockNumber,
        transactionCount: result.transactionCount,
        enrichedAt: now,
        source: 'polygonscan',
      };

      // Cache the result
      await this.cacheEnrichment(cacheKey, enrichment);

      // Also update the legacy walletFirstSeen key for backwards compatibility
      if (result.firstSeenTimestamp !== null) {
        await this.redis.set(
          RedisKeys.walletFirstSeen(normalizedAddress),
          result.firstSeenTimestamp.toString()
        );
      }

      logger.info(
        {
          address: normalizedAddress,
          firstSeenTimestamp: result.firstSeenTimestamp,
          transactionCount: result.transactionCount,
        },
        'Wallet enriched from Polygonscan'
      );

      return enrichment;
    } catch (error) {
      logger.error({ error, address: normalizedAddress }, 'Failed to enrich wallet from Polygonscan');

      // Return fallback enrichment (no data available)
      return {
        address: normalizedAddress,
        firstSeenTimestamp: null,
        firstSeenBlockNumber: null,
        transactionCount: 0,
        enrichedAt: Date.now(),
        source: 'fallback',
      };
    }
  }

  /**
   * Batch enrich multiple wallet addresses.
   *
   * Processes wallets sequentially to respect Polygonscan rate limits.
   * Uses cached data when available.
   *
   * @param addresses - Array of wallet addresses
   * @returns Map of address -> WalletEnrichment
   */
  async enrichWallets(addresses: string[]): Promise<Map<string, WalletEnrichment>> {
    const results = new Map<string, WalletEnrichment>();
    const uniqueAddresses = [...new Set(addresses.map(a => a.toLowerCase()))];

    for (const address of uniqueAddresses) {
      const enrichment = await this.enrichWallet(address);
      results.set(address, enrichment);

      // Small delay between API calls to respect rate limits (5 calls/sec for free tier)
      await this.delay(250);
    }

    return results;
  }

  /**
   * Get cached wallet enrichment without making API calls.
   *
   * @param address - Wallet address
   * @returns WalletEnrichment if cached, null otherwise
   */
  async getCached(address: string): Promise<WalletEnrichment | null> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = RedisKeys.walletCache(normalizedAddress);

    const cached = await this.redis.hgetall(cacheKey);
    if (!cached || !cached.enrichedAt) {
      return null;
    }

    return this.parseCache(normalizedAddress, cached);
  }

  /**
   * Compute wallet age in days from first-seen timestamp.
   *
   * @param enrichment - Wallet enrichment data
   * @returns Age in days, or null if first-seen is unknown
   */
  computeWalletAgeDays(enrichment: WalletEnrichment): number | null {
    if (enrichment.firstSeenTimestamp === null) {
      return null;
    }

    const now = Date.now();
    const ageMs = now - enrichment.firstSeenTimestamp;
    return ageMs / (1000 * 60 * 60 * 24);
  }

  /**
   * Compute wallet activity score based on transaction count.
   *
   * Lower activity = higher score (more suspicious for anomaly detection)
   * - < 10 txs: 0.9 (very suspicious)
   * - < 50 txs: 0.6 (somewhat suspicious)
   * - < 100 txs: 0.3 (moderate)
   * - >= 100 txs: 0.1 (normal activity)
   *
   * @param enrichment - Wallet enrichment data
   * @returns Activity score between 0 and 1
   */
  computeActivityScore(enrichment: WalletEnrichment): number {
    const txCount = enrichment.transactionCount;

    if (txCount < 10) return 0.9;
    if (txCount < 50) return 0.6;
    if (txCount < 100) return 0.3;
    return 0.1;
  }

  /**
   * Invalidate cached enrichment for a wallet.
   *
   * @param address - Wallet address
   */
  async invalidateCache(address: string): Promise<void> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = RedisKeys.walletCache(normalizedAddress);
    await this.redis.del(cacheKey);
    logger.debug({ address: normalizedAddress }, 'Wallet cache invalidated');
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private parseCache(address: string, cached: Record<string, string>): WalletEnrichment {
    return {
      address,
      firstSeenTimestamp: cached.firstSeenTimestamp ? parseInt(cached.firstSeenTimestamp, 10) : null,
      firstSeenBlockNumber: cached.firstSeenBlockNumber ? parseInt(cached.firstSeenBlockNumber, 10) : null,
      transactionCount: parseInt(cached.transactionCount || '0', 10),
      enrichedAt: parseInt(cached.enrichedAt, 10),
      source: 'cache',
    };
  }

  private async cacheEnrichment(cacheKey: string, enrichment: WalletEnrichment): Promise<void> {
    const data: Record<string, string> = {
      firstSeenTimestamp: enrichment.firstSeenTimestamp?.toString() ?? '',
      firstSeenBlockNumber: enrichment.firstSeenBlockNumber?.toString() ?? '',
      transactionCount: enrichment.transactionCount.toString(),
      enrichedAt: enrichment.enrichedAt.toString(),
      source: enrichment.source,
    };

    await this.redis.hset(cacheKey, data);
    await this.redis.expire(cacheKey, this.cacheTtlSeconds);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

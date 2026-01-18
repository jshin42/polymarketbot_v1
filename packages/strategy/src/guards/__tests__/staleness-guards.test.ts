import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StalenessGuards, type StalenessConfig } from '../staleness-guards.js';

/**
 * Staleness Guards Tests
 *
 * Per CLAUDE.md Section 1.1, staleness rules require:
 * - If any stream is stale beyond threshold (e.g., 10s), system enters NO-TRADE
 * - Book snapshots: 1-5s cadence
 * - Trades: streaming or 1s poll
 */

// Mock Redis client
// Key format from RedisKeys.lastUpdate: `staleness:${service}:${tokenId}:last_update`
const createMockRedis = () => {
  const store: Record<string, string> = {};
  const sets: Record<string, Set<string>> = {};

  return {
    get: vi.fn((key: string) => Promise.resolve(store[key] || null)),
    set: vi.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve('OK');
    }),
    smembers: vi.fn((key: string) => {
      return Promise.resolve(Array.from(sets[key] || []));
    }),
    sadd: vi.fn((key: string, ...members: string[]) => {
      if (!sets[key]) sets[key] = new Set();
      members.forEach((m) => sets[key].add(m));
      return Promise.resolve(members.length);
    }),
    // Helper to set staleness data with correct key format
    _setStalenessData: (dataType: string, entityId: string, timestamp: number) => {
      const key = `staleness:${dataType}:${entityId}:last_update`;
      store[key] = timestamp.toString();
    },
    _setMembers: (key: string, members: string[]) => {
      sets[key] = new Set(members);
    },
  };
};

describe('Staleness Guards', () => {
  let stalenessGuards: StalenessGuards;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    stalenessGuards = new StalenessGuards(mockRedis as any);
  });

  describe('Initialization', () => {
    it('should use default configuration', () => {
      const config = stalenessGuards.getConfig();

      expect(config.maxBookAgeMs).toBe(10000);
      expect(config.maxTradeAgeMs).toBe(15000);
      expect(config.maxMarketAgeMs).toBe(300000);
      expect(config.maxWalletAgeMs).toBe(3600000);
    });

    it('should allow custom configuration', () => {
      const customConfig: Partial<StalenessConfig> = {
        maxBookAgeMs: 5000,
        maxTradeAgeMs: 5000,
      };

      const customGuards = new StalenessGuards(mockRedis as any, customConfig);
      const config = customGuards.getConfig();

      expect(config.maxBookAgeMs).toBe(5000);
      expect(config.maxTradeAgeMs).toBe(5000);
    });
  });

  describe('checkFreshness()', () => {
    it('should return allFresh=true when all data is fresh', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Set up fresh data using correct key format
      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 10000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(true);
      expect(result.staleComponents).toEqual([]);
    });

    it('should detect stale orderbook data', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Book data is 15 seconds old (> 10s threshold)
      mockRedis._setStalenessData('book', tokenId, now - 15000);
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('orderbook');
    });

    it('should detect stale trade data', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Trade data is 20 seconds old (> 15s threshold)
      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 20000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('trades');
    });

    it('should detect stale market data', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Market data is 10 minutes old (> 5 min threshold)
      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 600000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('market');
    });

    it('should detect missing book data as stale', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Only trade and market data exist
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('orderbook');
      expect(result.bookAgeMs).toBeNull();
    });

    it('should detect missing trade data as stale', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Only book and market data exist
      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('trades');
      expect(result.tradeAgeMs).toBeNull();
    });

    it('should detect multiple stale components', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // All data is stale
      mockRedis._setStalenessData('book', tokenId, now - 20000);
      mockRedis._setStalenessData('trade', tokenId, now - 30000);
      mockRedis._setStalenessData('market', tokenId, now - 600000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.allFresh).toBe(false);
      expect(result.staleComponents).toContain('orderbook');
      expect(result.staleComponents).toContain('trades');
      expect(result.staleComponents).toContain('market');
      expect(result.staleComponents.length).toBe(3);
    });

    it('should calculate correct ages', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 8000);
      mockRedis._setStalenessData('market', tokenId, now - 120000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      // Ages should be approximately correct (allowing for execution time)
      expect(result.bookAgeMs).not.toBeNull();
      expect(result.bookAgeMs!).toBeGreaterThanOrEqual(5000);
      expect(result.bookAgeMs!).toBeLessThan(6000);
      expect(result.tradeAgeMs).not.toBeNull();
      expect(result.tradeAgeMs!).toBeGreaterThanOrEqual(8000);
      expect(result.tradeAgeMs!).toBeLessThan(9000);
    });
  });

  describe('checkWalletFreshness()', () => {
    it('should return fresh for recent wallet data', async () => {
      const now = Date.now();
      const wallet = '0x123';

      // Wallet updated 30 minutes ago
      mockRedis._setStalenessData('wallet', wallet, now - 1800000);

      const result = await stalenessGuards.checkWalletFreshness(wallet);

      expect(result.fresh).toBe(true);
      expect(result.ageMs).not.toBeNull();
      expect(result.ageMs!).toBeGreaterThanOrEqual(1800000);
    });

    it('should return stale for old wallet data', async () => {
      const now = Date.now();
      const wallet = '0x123';

      // Wallet updated 2 hours ago (> 1 hour threshold)
      mockRedis._setStalenessData('wallet', wallet, now - 7200000);

      const result = await stalenessGuards.checkWalletFreshness(wallet);

      expect(result.fresh).toBe(false);
      expect(result.ageMs).not.toBeNull();
      expect(result.ageMs!).toBeGreaterThanOrEqual(7200000);
    });

    it('should return stale for missing wallet data', async () => {
      const wallet = '0xunknown';

      const result = await stalenessGuards.checkWalletFreshness(wallet);

      expect(result.fresh).toBe(false);
      expect(result.ageMs).toBeNull();
    });

    it('should return fresh at exactly threshold', async () => {
      const now = Date.now();
      const wallet = '0x123';

      // Wallet updated exactly 1 hour ago
      mockRedis._setStalenessData('wallet', wallet, now - 3600000);

      const result = await stalenessGuards.checkWalletFreshness(wallet);

      expect(result.fresh).toBe(true);
    });
  });

  describe('recordUpdate()', () => {
    it('should record book update timestamp', async () => {
      const tokenId = 'test_token';

      await stalenessGuards.recordUpdate('book', tokenId);

      // Key format: staleness:book:test_token:last_update
      expect(mockRedis.set).toHaveBeenCalledWith(
        `staleness:book:${tokenId}:last_update`,
        expect.any(String),
        'EX',
        3600
      );
    });

    it('should record trade update timestamp', async () => {
      const tokenId = 'test_token';

      await stalenessGuards.recordUpdate('trade', tokenId);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `staleness:trade:${tokenId}:last_update`,
        expect.any(String),
        'EX',
        3600
      );
    });

    it('should record wallet update timestamp', async () => {
      const wallet = '0x123';

      await stalenessGuards.recordUpdate('wallet', wallet);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `staleness:wallet:${wallet}:last_update`,
        expect.any(String),
        'EX',
        3600
      );
    });
  });

  describe('checkSystemHealth()', () => {
    // Key format from RedisKeys.trackedTokens(): 'config:tracked_tokens'
    const TRACKED_TOKENS_KEY = 'config:tracked_tokens';

    it('should return healthy when no tracked tokens', async () => {
      mockRedis._setMembers(TRACKED_TOKENS_KEY, []);

      const result = await stalenessGuards.checkSystemHealth();

      expect(result.healthy).toBe(true);
      expect(result.tokensWithStaleData).toEqual([]);
    });

    it('should return healthy when all tokens have fresh data', async () => {
      const now = Date.now();
      const tokens = ['token1', 'token2'];
      mockRedis._setMembers(TRACKED_TOKENS_KEY, tokens);

      for (const token of tokens) {
        mockRedis._setStalenessData('book', token, now - 5000);
        mockRedis._setStalenessData('trade', token, now - 5000);
        mockRedis._setStalenessData('market', token, now - 60000);
      }

      const result = await stalenessGuards.checkSystemHealth();

      expect(result.healthy).toBe(true);
      expect(result.tokensWithStaleData).toEqual([]);
    });

    it('should return unhealthy when some tokens have stale data', async () => {
      const now = Date.now();
      const tokens = ['token1', 'token2'];
      mockRedis._setMembers(TRACKED_TOKENS_KEY, tokens);

      // token1 is fresh
      mockRedis._setStalenessData('book', 'token1', now - 5000);
      mockRedis._setStalenessData('trade', 'token1', now - 5000);
      mockRedis._setStalenessData('market', 'token1', now - 60000);

      // token2 has stale book data
      mockRedis._setStalenessData('book', 'token2', now - 20000);
      mockRedis._setStalenessData('trade', 'token2', now - 5000);
      mockRedis._setStalenessData('market', 'token2', now - 60000);

      const result = await stalenessGuards.checkSystemHealth();

      expect(result.healthy).toBe(false);
      expect(result.tokensWithStaleData).toContain('token2');
      expect(result.summary['token2']).toContain('orderbook');
    });

    it('should report all stale tokens', async () => {
      const now = Date.now();
      const tokens = ['token1', 'token2', 'token3'];
      mockRedis._setMembers(TRACKED_TOKENS_KEY, tokens);

      // All tokens have stale data
      for (const token of tokens) {
        mockRedis._setStalenessData('book', token, now - 20000);
        // Trade and market are missing = stale
      }

      const result = await stalenessGuards.checkSystemHealth();

      expect(result.healthy).toBe(false);
      expect(result.tokensWithStaleData.length).toBe(3);
    });
  });

  describe('Configuration updates', () => {
    it('allows runtime config updates', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Book data is 12 seconds old
      mockRedis._setStalenessData('book', tokenId, now - 12000);
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      // With default config (10s), this should be stale
      let result = await stalenessGuards.checkFreshness(tokenId);
      expect(result.staleComponents).toContain('orderbook');

      // Update config to allow 15s staleness
      stalenessGuards.updateConfig({ maxBookAgeMs: 15000 });

      // Now it should be fresh
      result = await stalenessGuards.checkFreshness(tokenId);
      expect(result.staleComponents).not.toContain('orderbook');
    });
  });

  describe('Boundary conditions', () => {
    it('should handle exact threshold values for book', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      // Exactly at threshold
      mockRedis._setStalenessData('book', tokenId, now - 10000);
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      // At exactly threshold should still be fresh (using <=)
      expect(result.staleComponents).not.toContain('orderbook');
    });

    it('should handle exact threshold values for trades', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 15000); // Exactly at 15s
      mockRedis._setStalenessData('market', tokenId, now - 60000);

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.staleComponents).not.toContain('trades');
    });

    it('should handle exact threshold values for market', async () => {
      const now = Date.now();
      const tokenId = 'test_token';

      mockRedis._setStalenessData('book', tokenId, now - 5000);
      mockRedis._setStalenessData('trade', tokenId, now - 5000);
      mockRedis._setStalenessData('market', tokenId, now - 300000); // Exactly at 5 min

      const result = await stalenessGuards.checkFreshness(tokenId);

      expect(result.staleComponents).not.toContain('market');
    });
  });
});

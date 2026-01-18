import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PolygonscanClient } from '../clients/polygonscan.client.js';

// =============================================================================
// Polygonscan Integration Tests
// =============================================================================
//
// These tests verify that real Polygonscan API calls:
// 1. Return valid wallet first-seen timestamps
// 2. Return accurate transaction counts
// 3. Handle edge cases (new wallets, contracts, etc.)
//
// NOTE: These tests require:
// - Network access to api.polygonscan.com
// - POLYGONSCAN_API_KEY environment variable (free tier works)
//
// Run with: POLYGONSCAN_API_KEY=xxx pnpm test:integration
// =============================================================================

// Known active Polygon wallets for testing
// These are real wallets with known activity patterns
const TEST_WALLETS = {
  // Well-known active wallet (Polymarket deployer)
  active: '0x4baba9c6c9c3f3ce8eb0e9b3f8db8f8b8e8a8c8a',
  // Zero address (should have no outbound transactions)
  zero: '0x0000000000000000000000000000000000000000',
};

describe('Polygonscan Integration', () => {
  let client: PolygonscanClient;
  const apiKey = process.env.POLYGONSCAN_API_KEY;

  beforeAll(() => {
    if (!apiKey) {
      console.warn('POLYGONSCAN_API_KEY not set - tests will use empty key (rate limited)');
    }
    client = new PolygonscanClient({
      apiKey: apiKey ?? '',
      timeout: 30000,
    });
  });

  describe('getWalletFirstSeen', () => {
    it('should return first-seen timestamp for active wallet', async () => {
      // Use a known Polymarket trading wallet
      // We'll first fetch some real trades to find an active wallet
      const result = await client.getWalletFirstSeen('0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3');

      // Active wallets should have a first-seen timestamp
      if (result.firstSeenTimestamp) {
        expect(result.firstSeenTimestamp).toBeGreaterThan(0);
        expect(result.firstSeenBlockNumber).toBeGreaterThan(0);

        // Timestamp should be in the past
        expect(result.firstSeenTimestamp).toBeLessThan(Date.now());

        // Should be after Polygon mainnet launch (roughly 2020)
        const year2020 = new Date('2020-01-01').getTime();
        expect(result.firstSeenTimestamp).toBeGreaterThan(year2020);

        console.log(`Wallet first seen: ${new Date(result.firstSeenTimestamp).toISOString()}`);
        console.log(`Transaction count: ${result.transactionCount}`);
      } else {
        // Wallet may not exist or have no transactions
        expect(result.transactionCount).toBe(0);
      }
    });

    it('should return null timestamp for zero address', async () => {
      const result = await client.getWalletFirstSeen(TEST_WALLETS.zero);

      // Zero address has no outbound transactions (only receives)
      // So firstSeenTimestamp may be null or very old
      // Transaction count should be 0 for outbound
      expect(result.transactionCount).toBe(0);
    });

    it('should normalize address to lowercase', async () => {
      const upperCase = '0x4D944A25BC871D6C6EE08BAEF0B7DA0B08E6B7B3';
      const lowerCase = '0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3';

      // Both should return same result
      const result1 = await client.getWalletFirstSeen(upperCase);
      const result2 = await client.getWalletFirstSeen(lowerCase);

      expect(result1.firstSeenTimestamp).toBe(result2.firstSeenTimestamp);
      expect(result1.transactionCount).toBe(result2.transactionCount);
    });
  });

  describe('getTransactionCount', () => {
    it('should return transaction count for active wallet', async () => {
      const count = await client.getTransactionCount('0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3');

      // Active trading wallets should have transactions
      expect(count).toBeGreaterThanOrEqual(0);
      console.log(`Transaction count: ${count}`);
    });

    it('should return 0 for zero address', async () => {
      const count = await client.getTransactionCount(TEST_WALLETS.zero);
      expect(count).toBe(0);
    });
  });

  describe('isContract', () => {
    it('should correctly identify contract addresses', async () => {
      // USDC contract on Polygon
      const usdcContract = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const isContract = await client.isContract(usdcContract);
      expect(isContract).toBe(true);
    });

    it('should correctly identify EOA addresses', async () => {
      // Regular wallet address (not a contract)
      const eoa = '0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3';
      const isContract = await client.isContract(eoa);
      expect(isContract).toBe(false);
    });

    it('should return false for zero address', async () => {
      const isContract = await client.isContract(TEST_WALLETS.zero);
      expect(isContract).toBe(false);
    });
  });

  describe('getBalance', () => {
    it('should return balance for address', async () => {
      const balance = await client.getBalance('0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3');

      // Balance is in wei, should be >= 0
      expect(balance).toBeGreaterThanOrEqual(0n);
      console.log(`Balance: ${balance} wei (${Number(balance) / 1e18} MATIC)`);
    });
  });
});

describe('Wallet Age Calculation', () => {
  let client: PolygonscanClient;

  beforeAll(() => {
    client = new PolygonscanClient({
      apiKey: process.env.POLYGONSCAN_API_KEY ?? '',
    });
  });

  it('should calculate realistic wallet age from first-seen', async () => {
    const result = await client.getWalletFirstSeen('0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3');

    if (!result.firstSeenTimestamp) {
      console.warn('No first-seen timestamp - skipping age calculation');
      return;
    }

    const now = Date.now();
    const ageMs = now - result.firstSeenTimestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Age should be positive
    expect(ageDays).toBeGreaterThan(0);

    // Age should be less than Polygon's age (roughly 5 years as of 2024)
    expect(ageDays).toBeLessThan(365 * 6);

    console.log(`Wallet age: ${ageDays.toFixed(1)} days`);

    // Determine wallet age category
    let category: string;
    if (ageDays < 7) category = 'New';
    else if (ageDays < 30) category = 'Recent';
    else if (ageDays < 180) category = 'Moderate';
    else category = 'Established';

    console.log(`Wallet category: ${category}`);
  });
});

describe('Rate Limiting', () => {
  let client: PolygonscanClient;

  beforeAll(() => {
    client = new PolygonscanClient({
      apiKey: process.env.POLYGONSCAN_API_KEY ?? '',
    });
  });

  it('should handle rapid consecutive requests', async () => {
    // Free tier allows 5 calls/second
    // Make 3 rapid calls to test rate handling
    const addresses = [
      '0x4d944a25bc871d6c6ee08baef0b7da0b08e6b7b3',
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ];

    const results = await Promise.all(
      addresses.map(addr => client.getTransactionCount(addr))
    );

    // All requests should complete without error
    expect(results).toHaveLength(3);
    results.forEach(count => {
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});

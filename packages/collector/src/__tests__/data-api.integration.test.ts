import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataApiClient } from '../clients/data-api.client.js';
import { transformDataApiTrade } from '@polymarketbot/shared';

// =============================================================================
// Data API Integration Tests
// =============================================================================
//
// These tests verify that real Polymarket Data API responses:
// 1. Contain valid transaction hashes in the expected format
// 2. Can be correctly transformed to canonical Trade format
// 3. Preserve transaction hashes through the transformation pipeline
//
// NOTE: These tests require network access and may be flaky due to
// network conditions or API rate limits. They should be run with:
// POLYGONSCAN_API_KEY=xxx pnpm test:integration
// =============================================================================

describe('Data API Integration', () => {
  let client: DataApiClient;

  beforeAll(() => {
    client = new DataApiClient();
  });

  describe('getTrades', () => {
    it('should return trades with transaction hashes', async () => {
      // Fetch recent trades from the Data API
      const trades = await client.getTrades({
        limit: 50,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      });

      // Verify we got some trades
      expect(trades.length).toBeGreaterThan(0);

      // Find trades with transaction hashes
      const tradesWithHash = trades.filter(t => t.transactionHash);

      // Most trades should have transaction hashes
      console.log(`Found ${tradesWithHash.length}/${trades.length} trades with transaction hashes`);

      // At least some trades should have hashes (may not be 100% due to API inconsistencies)
      expect(tradesWithHash.length).toBeGreaterThan(0);

      // Verify hash format for trades that have them
      tradesWithHash.forEach(trade => {
        expect(trade.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      });
    });

    it('should return trades with all required fields', async () => {
      const trades = await client.getTrades({ limit: 10 });

      expect(trades.length).toBeGreaterThan(0);

      trades.forEach(trade => {
        // Required fields
        expect(trade.proxyWallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(['BUY', 'SELL']).toContain(trade.side);
        expect(trade.asset).toBeTruthy();
        expect(trade.conditionId).toBeTruthy();
        expect(trade.size).toBeGreaterThan(0);
        expect(trade.price).toBeGreaterThanOrEqual(0);
        expect(trade.price).toBeLessThanOrEqual(1);
        expect(trade.timestamp).toBeGreaterThan(0);
      });
    });

    it('should transform Data API response and preserve transaction hash', async () => {
      const rawTrades = await client.getTrades({ limit: 20 });

      // Find a trade with a transaction hash
      const rawTradeWithHash = rawTrades.find(t => t.transactionHash);

      if (!rawTradeWithHash) {
        console.warn('No trades with transaction hashes found in this batch - skipping');
        return;
      }

      // Transform to canonical format
      const trade = transformDataApiTrade(rawTradeWithHash);

      // Verify transaction hash is preserved
      expect(trade.transactionHash).toBe(rawTradeWithHash.transactionHash);

      // Verify tradeId uses transaction hash
      expect(trade.tradeId).toBe(rawTradeWithHash.transactionHash);

      // Verify other fields are correctly transformed
      expect(trade.tokenId).toBe(rawTradeWithHash.asset);
      expect(trade.side).toBe(rawTradeWithHash.side);
      expect(trade.price).toBe(rawTradeWithHash.price);
      expect(trade.size).toBe(rawTradeWithHash.size);

      // Timestamp should be converted from seconds to milliseconds
      expect(trade.timestamp).toBe(rawTradeWithHash.timestamp * 1000);

      // Taker address should be lowercased proxy wallet
      expect(trade.takerAddress).toBe(rawTradeWithHash.proxyWallet.toLowerCase());
    });
  });

  describe('getTokenTrades', () => {
    it('should return token-specific trades with transaction hashes', async () => {
      // First get any recent trade to find a valid conditionId/tokenId
      const allTrades = await client.getTrades({ limit: 5 });

      if (allTrades.length === 0) {
        console.warn('No trades available - skipping');
        return;
      }

      const { conditionId, asset: tokenId } = allTrades[0]!;

      // Fetch trades for this specific token
      const tokenTrades = await client.getTokenTrades(conditionId, tokenId, {
        limit: 20,
        sortDirection: 'DESC',
      });

      // May not have many token-specific trades, but should have at least one
      if (tokenTrades.length > 0) {
        const tradesWithHash = tokenTrades.filter(t => t.transactionHash);
        console.log(`Token ${tokenId}: ${tradesWithHash.length}/${tokenTrades.length} trades with hashes`);

        tradesWithHash.forEach(trade => {
          expect(trade.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        });
      }
    });
  });
});

describe('Transaction Hash Pipeline', () => {
  let client: DataApiClient;

  beforeAll(() => {
    client = new DataApiClient();
  });

  it('should maintain transaction hash integrity through transformation', async () => {
    // This test verifies the full pipeline from API response to stored trade
    const rawTrades = await client.getTrades({ limit: 50 });

    const tradesWithHash = rawTrades.filter(t => t.transactionHash);

    if (tradesWithHash.length === 0) {
      console.warn('No trades with transaction hashes available - skipping');
      return;
    }

    // Transform each trade and verify hash preservation
    for (const rawTrade of tradesWithHash.slice(0, 10)) {
      const transformed = transformDataApiTrade(rawTrade);

      // Transaction hash should be identical
      expect(transformed.transactionHash).toBe(rawTrade.transactionHash);

      // Trade ID should be the transaction hash when available
      expect(transformed.tradeId).toBe(rawTrade.transactionHash);

      // Build expected Polygonscan URL
      const expectedUrl = `https://polygonscan.com/tx/${rawTrade.transactionHash}`;

      console.log(`Trade ${rawTrade.transactionHash?.slice(0, 10)}... -> Polygonscan: ${expectedUrl}`);
    }
  });
});

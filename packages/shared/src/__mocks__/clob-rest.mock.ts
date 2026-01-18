// =============================================================================
// Mock CLOB REST Client
// =============================================================================
//
// Mock implementation of the CLOB REST client for testing purposes.
// Returns configurable fixture data without making actual API calls.

import type { ClobOrderbookResponse, ClobTradeResponse } from '../schemas/index.js';

// Default mock data
const DEFAULT_ORDERBOOK: ClobOrderbookResponse = {
  market: 'test-market',
  asset_id: 'test-token',
  bids: [
    { price: '0.55', size: '1000' },
    { price: '0.54', size: '2000' },
    { price: '0.53', size: '3000' },
  ],
  asks: [
    { price: '0.56', size: '1000' },
    { price: '0.57', size: '2000' },
    { price: '0.58', size: '3000' },
  ],
  hash: 'mock-hash-123',
  timestamp: new Date().toISOString(),
};

const DEFAULT_TRADES: ClobTradeResponse[] = [
  {
    id: 'trade_1',
    market: 'test-market',
    asset_id: 'test-token',
    side: 'BUY',
    price: '0.55',
    size: '100',
    timestamp: new Date().toISOString(),
    maker_address: '0x' + 'a'.repeat(40),
    taker_address: '0x' + 'b'.repeat(40),
    fee_rate_bps: '100',
    match_time: new Date().toISOString(),
  },
];

export interface MockClobRestClientConfig {
  orderbook?: ClobOrderbookResponse;
  trades?: ClobTradeResponse[];
  midpoint?: number;
  price?: number;
  samplingMarkets?: string[];
  shouldFail?: boolean;
  failureError?: Error;
}

/**
 * Mock CLOB REST Client for testing
 */
export class MockClobRestClient {
  private config: MockClobRestClientConfig;
  private callHistory: Array<{ method: string; args: unknown[] }> = [];

  constructor(config: MockClobRestClientConfig = {}) {
    this.config = config;
  }

  /**
   * Update mock configuration
   */
  setConfig(config: Partial<MockClobRestClientConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get call history for verification
   */
  getCallHistory(): Array<{ method: string; args: unknown[] }> {
    return [...this.callHistory];
  }

  /**
   * Clear call history
   */
  clearCallHistory(): void {
    this.callHistory = [];
  }

  /**
   * Get order book for a token
   */
  async getOrderbook(tokenId: string): Promise<ClobOrderbookResponse> {
    this.callHistory.push({ method: 'getOrderbook', args: [tokenId] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return {
      ...(this.config.orderbook ?? DEFAULT_ORDERBOOK),
      asset_id: tokenId,
    };
  }

  /**
   * Get midpoint price for a token
   */
  async getMidpoint(tokenId: string): Promise<number> {
    this.callHistory.push({ method: 'getMidpoint', args: [tokenId] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return this.config.midpoint ?? 0.55;
  }

  /**
   * Get best price for a side
   */
  async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number> {
    this.callHistory.push({ method: 'getPrice', args: [tokenId, side] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    if (this.config.price !== undefined) {
      return this.config.price;
    }

    return side === 'BUY' ? 0.55 : 0.56;
  }

  /**
   * Get recent trades for a token
   */
  async getTrades(tokenId: string, limit: number = 100): Promise<ClobTradeResponse[]> {
    this.callHistory.push({ method: 'getTrades', args: [tokenId, limit] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    const trades = this.config.trades ?? DEFAULT_TRADES;
    return trades.slice(0, limit).map(trade => ({
      ...trade,
      asset_id: tokenId,
    }));
  }

  /**
   * Get sampling markets
   */
  async getSamplingMarkets(): Promise<string[]> {
    this.callHistory.push({ method: 'getSamplingMarkets', args: [] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return this.config.samplingMarkets ?? ['token_1', 'token_2', 'token_3'];
  }

  /**
   * Get sampling simplified markets
   */
  async getSamplingSimplifiedMarkets(next_cursor?: string): Promise<{
    limit: number;
    count: number;
    next_cursor: string;
    data: Array<{ condition_id: string; [key: string]: unknown }>;
  }> {
    this.callHistory.push({ method: 'getSamplingSimplifiedMarkets', args: [next_cursor] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return {
      limit: 100,
      count: 3,
      next_cursor: '',
      data: [
        { condition_id: 'condition_1', slug: 'test-market-1' },
        { condition_id: 'condition_2', slug: 'test-market-2' },
        { condition_id: 'condition_3', slug: 'test-market-3' },
      ],
    };
  }

  /**
   * Place an order (mock - always succeeds in paper mode)
   */
  async placeOrder(order: {
    tokenID: string;
    price: string;
    size: string;
    side: 'BUY' | 'SELL';
  }): Promise<{ orderID: string; status: string }> {
    this.callHistory.push({ method: 'placeOrder', args: [order] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return {
      orderID: `mock_order_${Date.now()}`,
      status: 'PENDING',
    };
  }

  /**
   * Cancel an order (mock)
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.callHistory.push({ method: 'cancelOrder', args: [orderId] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }
  }

  /**
   * Get active orders (mock)
   */
  async getActiveOrders(): Promise<Array<{ orderID: string; status: string }>> {
    this.callHistory.push({ method: 'getActiveOrders', args: [] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock CLOB API error');
    }

    return [];
  }
}

/**
 * Create a pre-configured mock client for common test scenarios
 */
export function createMockClobRestClient(scenario: 'normal' | 'imbalanced' | 'thin' | 'error' = 'normal'): MockClobRestClient {
  switch (scenario) {
    case 'imbalanced':
      return new MockClobRestClient({
        orderbook: {
          market: 'test-market',
          asset_id: 'test-token',
          bids: [
            { price: '0.55', size: '5000' },
            { price: '0.54', size: '10000' },
          ],
          asks: [
            { price: '0.56', size: '500' },
            { price: '0.57', size: '500' },
          ],
          hash: 'mock-hash',
          timestamp: new Date().toISOString(),
        },
      });

    case 'thin':
      return new MockClobRestClient({
        orderbook: {
          market: 'test-market',
          asset_id: 'test-token',
          bids: [
            { price: '0.50', size: '100' },
          ],
          asks: [
            { price: '0.60', size: '100' },
          ],
          hash: 'mock-hash',
          timestamp: new Date().toISOString(),
        },
      });

    case 'error':
      return new MockClobRestClient({
        shouldFail: true,
        failureError: new Error('API temporarily unavailable'),
      });

    default:
      return new MockClobRestClient();
  }
}

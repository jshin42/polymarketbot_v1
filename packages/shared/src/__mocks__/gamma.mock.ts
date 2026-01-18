// =============================================================================
// Mock Gamma API Client
// =============================================================================
//
// Mock implementation of the Gamma API client for testing purposes.
// Returns configurable market data without making actual API calls.

import type { GammaMarketResponse } from '../schemas/index.js';

// Default mock market data matching GammaMarketResponseSchema (camelCase)
const DEFAULT_MARKETS: GammaMarketResponse[] = [
  {
    conditionId: '0x' + '1'.repeat(64),
    question: 'Will Bitcoin reach $100k by end of 2024?',
    description: 'This market resolves YES if Bitcoin reaches $100,000 USD.',
    slug: 'btc-100k-2024',
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    endDateIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    active: true,
    closed: false,
    archived: false,
    volume: '1000000',
    liquidity: '50000',
    outcomes: JSON.stringify(['Yes', 'No']),
    outcomePrices: JSON.stringify(['0.45', '0.55']),
    clobTokenIds: JSON.stringify(['token_yes_1', 'token_no_1']),
    negRisk: false,
    tags: [
      { id: 'crypto', slug: 'crypto', label: 'Crypto' },
    ],
  },
  {
    conditionId: '0x' + '2'.repeat(64),
    question: 'Will ETH merge happen in Q3?',
    description: 'Market about Ethereum merge timing.',
    slug: 'eth-merge-q3',
    endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    endDateIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    active: true,
    closed: false,
    archived: false,
    volume: '5000000',
    liquidity: '200000',
    outcomes: JSON.stringify(['Yes', 'No']),
    outcomePrices: JSON.stringify(['0.80', '0.20']),
    clobTokenIds: JSON.stringify(['token_yes_2', 'token_no_2']),
    negRisk: false,
    tags: [
      { id: 'crypto', slug: 'crypto', label: 'Crypto' },
    ],
  },
];

export interface MockGammaClientConfig {
  markets?: GammaMarketResponse[];
  shouldFail?: boolean;
  failureError?: Error;
}

/**
 * Mock Gamma API Client for testing
 */
export class MockGammaClient {
  private config: MockGammaClientConfig;
  private callHistory: Array<{ method: string; args: unknown[] }> = [];

  constructor(config: MockGammaClientConfig = {}) {
    this.config = config;
  }

  /**
   * Update mock configuration
   */
  setConfig(config: Partial<MockGammaClientConfig>): void {
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
   * Get markets with filters
   */
  async getMarkets(params: {
    active?: boolean;
    closed?: boolean;
    archived?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<GammaMarketResponse[]> {
    this.callHistory.push({ method: 'getMarkets', args: [params] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Gamma API error');
    }

    let markets = this.config.markets ?? DEFAULT_MARKETS;

    // Apply filters
    if (params.active !== undefined) {
      markets = markets.filter(m => m.active === params.active);
    }
    if (params.closed !== undefined) {
      markets = markets.filter(m => m.closed === params.closed);
    }
    if (params.archived !== undefined) {
      markets = markets.filter(m => m.archived === params.archived);
    }

    // Apply pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    markets = markets.slice(offset, offset + limit);

    return markets;
  }

  /**
   * Get a single market by condition ID
   */
  async getMarket(conditionId: string): Promise<GammaMarketResponse | null> {
    this.callHistory.push({ method: 'getMarket', args: [conditionId] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Gamma API error');
    }

    const markets = this.config.markets ?? DEFAULT_MARKETS;
    return markets.find(m => m.condition_id === conditionId) ?? null;
  }

  /**
   * Get markets closing soon
   */
  async getMarketsClosingSoon(withinHours: number): Promise<GammaMarketResponse[]> {
    this.callHistory.push({ method: 'getMarketsClosingSoon', args: [withinHours] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Gamma API error');
    }

    const now = Date.now();
    const cutoff = now + withinHours * 60 * 60 * 1000;

    const markets = this.config.markets ?? DEFAULT_MARKETS;
    return markets.filter(m => {
      const endDateStr = m.endDate ?? m.endDateIso;
      if (!endDateStr) return false;
      const endTime = new Date(endDateStr).getTime();
      return endTime > now && endTime <= cutoff && m.active && !m.closed;
    });
  }

  /**
   * Get all active markets
   */
  async getActiveMarkets(limit: number = 100): Promise<GammaMarketResponse[]> {
    this.callHistory.push({ method: 'getActiveMarkets', args: [limit] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Gamma API error');
    }

    const markets = this.config.markets ?? DEFAULT_MARKETS;
    return markets.filter(m => m.active && !m.closed && !m.archived).slice(0, limit);
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit: number = 20): Promise<GammaMarketResponse[]> {
    this.callHistory.push({ method: 'searchMarkets', args: [query, limit] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Gamma API error');
    }

    const markets = this.config.markets ?? DEFAULT_MARKETS;
    const queryLower = query.toLowerCase();

    return markets
      .filter(m =>
        m.question?.toLowerCase().includes(queryLower) ||
        m.slug?.toLowerCase().includes(queryLower) ||
        m.description?.toLowerCase().includes(queryLower)
      )
      .slice(0, limit);
  }
}

/**
 * Create a pre-configured mock client for common test scenarios
 */
export function createMockGammaClient(scenario: 'normal' | 'closing_soon' | 'empty' | 'error' = 'normal'): MockGammaClient {
  switch (scenario) {
    case 'closing_soon':
      return new MockGammaClient({
        markets: [
          {
            condition_id: '0x' + 'c1'.repeat(32),
            question: 'Market closing in 5 minutes',
            description: 'Test market closing soon',
            market_slug: 'closing-soon',
            end_date_iso: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            game_start_time: null,
            active: true,
            closed: false,
            archived: false,
            volume: '100000',
            liquidity: '10000',
            outcomes: JSON.stringify(['Yes', 'No']),
            outcome_prices: JSON.stringify(['0.70', '0.30']),
            tokens: [
              { token_id: 'token_yes_cs', outcome: 'Yes', winner: null },
              { token_id: 'token_no_cs', outcome: 'No', winner: null },
            ],
            neg_risk: false,
            tags: null,
          },
          {
            condition_id: '0x' + 'c2'.repeat(32),
            question: 'Market closing in 30 minutes',
            description: 'Test market closing in 30 min',
            market_slug: 'closing-30min',
            end_date_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            game_start_time: null,
            active: true,
            closed: false,
            archived: false,
            volume: '200000',
            liquidity: '20000',
            outcomes: JSON.stringify(['Yes', 'No']),
            outcome_prices: JSON.stringify(['0.55', '0.45']),
            tokens: [
              { token_id: 'token_yes_30', outcome: 'Yes', winner: null },
              { token_id: 'token_no_30', outcome: 'No', winner: null },
            ],
            neg_risk: false,
            tags: null,
          },
        ],
      });

    case 'empty':
      return new MockGammaClient({ markets: [] });

    case 'error':
      return new MockGammaClient({
        shouldFail: true,
        failureError: new Error('Gamma API temporarily unavailable'),
      });

    default:
      return new MockGammaClient();
  }
}

/**
 * Create a market fixture with custom properties
 */
export function createMockMarket(overrides: Partial<GammaMarketResponse> = {}): GammaMarketResponse {
  const now = Date.now();
  return {
    condition_id: '0x' + Math.random().toString(16).substring(2, 66).padEnd(64, '0'),
    question: 'Test market question?',
    description: 'Test market description',
    market_slug: 'test-market',
    end_date_iso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    game_start_time: null,
    active: true,
    closed: false,
    archived: false,
    volume: '100000',
    liquidity: '10000',
    outcomes: JSON.stringify(['Yes', 'No']),
    outcome_prices: JSON.stringify(['0.50', '0.50']),
    tokens: [
      { token_id: `token_yes_${now}`, outcome: 'Yes', winner: null },
      { token_id: `token_no_${now}`, outcome: 'No', winner: null },
    ],
    neg_risk: false,
    tags: null,
    ...overrides,
  };
}

// =============================================================================
// Market Fixtures
// =============================================================================
//
// Test fixtures for market data covering various scenarios.

import type { MarketMetadata, GammaMarketResponse } from '../schemas/market.schema.js';

/**
 * Creates a base market fixture that can be customized
 */
export function createMarketFixture(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  const now = new Date();
  const endDate = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now

  return {
    conditionId: '0x' + '1'.repeat(64),
    question: 'Will this test market resolve YES?',
    description: 'A test market for unit testing',
    outcomes: [
      { id: '0', name: 'Yes', tokenId: 'token_yes_' + Date.now() },
      { id: '1', name: 'No', tokenId: 'token_no_' + Date.now() },
    ],
    endDateIso: endDate.toISOString(),
    active: true,
    closed: false,
    resolved: false,
    volume: 50000,
    liquidity: 10000,
    negRisk: false,
    slug: 'test-market',
    tags: ['test'],
    category: 'Test',
    ...overrides,
  };
}

/**
 * Market closing in 5 minutes - prime for last-minute anomaly detection
 */
export const marketClosingSoon = createMarketFixture({
  conditionId: '0x' + 'a'.repeat(64),
  question: 'Market closing in 5 minutes',
  endDateIso: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  volume: 100000,
  liquidity: 25000,
});

/**
 * Market closing in 2 minutes - very close to close
 */
export const marketVeryClosingSoon = createMarketFixture({
  conditionId: '0x' + 'b'.repeat(64),
  question: 'Market closing in 2 minutes',
  endDateIso: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  volume: 150000,
  liquidity: 30000,
});

/**
 * Market in no-trade zone (< 120 seconds to close)
 */
export const marketInNoTradeZone = createMarketFixture({
  conditionId: '0x' + 'c'.repeat(64),
  question: 'Market in no-trade zone',
  endDateIso: new Date(Date.now() + 60 * 1000).toISOString(), // 60 seconds
  volume: 200000,
  liquidity: 40000,
});

/**
 * Market closing in 1 hour - moderate urgency
 */
export const marketClosingInHour = createMarketFixture({
  conditionId: '0x' + 'd'.repeat(64),
  question: 'Market closing in 1 hour',
  endDateIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  volume: 75000,
  liquidity: 20000,
});

/**
 * Market closing tomorrow - low urgency
 */
export const marketClosingTomorrow = createMarketFixture({
  conditionId: '0x' + 'e'.repeat(64),
  question: 'Market closing tomorrow',
  endDateIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  volume: 30000,
  liquidity: 8000,
});

/**
 * Closed market - should not trade
 */
export const marketClosed = createMarketFixture({
  conditionId: '0x' + 'f'.repeat(64),
  question: 'Closed market',
  endDateIso: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // Ended 1 hour ago
  active: false,
  closed: true,
  volume: 500000,
  liquidity: 0,
});

/**
 * Resolved market - should not trade
 */
export const marketResolved = createMarketFixture({
  conditionId: '0x' + '0'.repeat(63) + '1',
  question: 'Resolved market',
  endDateIso: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  active: false,
  closed: true,
  resolved: true,
  volume: 1000000,
  liquidity: 0,
});

/**
 * High volume market
 */
export const marketHighVolume = createMarketFixture({
  conditionId: '0x' + '2'.repeat(64),
  question: 'High volume market',
  endDateIso: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  volume: 5000000,
  liquidity: 500000,
});

/**
 * Low liquidity market - risky for execution
 */
export const marketLowLiquidity = createMarketFixture({
  conditionId: '0x' + '3'.repeat(64),
  question: 'Low liquidity market',
  endDateIso: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  volume: 10000,
  liquidity: 500,
});

/**
 * Raw Gamma API response fixture
 */
export function createRawGammaMarketFixture(overrides: Partial<GammaMarketResponse> = {}): GammaMarketResponse {
  return {
    condition_id: '0x' + '4'.repeat(64),
    question: 'Raw Gamma market fixture',
    description: 'A raw Gamma API response for testing',
    market_slug: 'raw-gamma-fixture',
    end_date_iso: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    game_start_time: null,
    active: true,
    closed: false,
    archived: false,
    volume: '50000',
    liquidity: '10000',
    outcomes: JSON.stringify(['Yes', 'No']),
    outcome_prices: '0.60,0.40',
    tokens: [
      { token_id: 'raw_token_yes', outcome: 'Yes', winner: null },
      { token_id: 'raw_token_no', outcome: 'No', winner: null },
    ],
    neg_risk: false,
    tags: [{ id: '1', slug: 'test', label: 'Test' }],
    ...overrides,
  };
}

/**
 * Collection of all market fixtures
 */
export const marketFixtures = {
  closingSoon: marketClosingSoon,
  veryClosingSoon: marketVeryClosingSoon,
  noTradeZone: marketInNoTradeZone,
  closingInHour: marketClosingInHour,
  closingTomorrow: marketClosingTomorrow,
  closed: marketClosed,
  resolved: marketResolved,
  highVolume: marketHighVolume,
  lowLiquidity: marketLowLiquidity,
};

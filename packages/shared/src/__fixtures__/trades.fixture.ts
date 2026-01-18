// =============================================================================
// Trade Fixtures
// =============================================================================
//
// Test fixtures for trade data covering normal, large, and extreme scenarios.

import type { Trade } from '../schemas/trade.schema.js';

/**
 * Creates a base trade fixture that can be customized
 */
export function createTradeFixture(overrides: Partial<Trade> = {}): Trade {
  return {
    tradeId: 'trade_' + Date.now() + '_' + Math.random().toString(36).substring(7),
    tokenId: 'test_token',
    timestamp: Date.now(),
    side: 'BUY',
    price: 0.55,
    size: 100,
    makerAddress: '0x' + 'a'.repeat(40),
    takerAddress: '0x' + 'b'.repeat(40),
    feeRateBps: 100,
    ...overrides,
  };
}

/**
 * Small trade - typical retail size
 */
export const tradeSmall = createTradeFixture({
  tradeId: 'trade_small',
  size: 50,
  price: 0.50,
});

/**
 * Medium trade - moderate size
 */
export const tradeMedium = createTradeFixture({
  tradeId: 'trade_medium',
  size: 500,
  price: 0.55,
});

/**
 * Large trade - significant size (q95 level)
 */
export const tradeLarge = createTradeFixture({
  tradeId: 'trade_large',
  size: 5000,
  price: 0.60,
});

/**
 * Very large trade - tail event (q99 level)
 */
export const tradeVeryLarge = createTradeFixture({
  tradeId: 'trade_very_large',
  size: 20000,
  price: 0.65,
});

/**
 * Extreme trade - rare tail event (q999 level)
 */
export const tradeExtreme = createTradeFixture({
  tradeId: 'trade_extreme',
  size: 100000,
  price: 0.70,
});

/**
 * Buy trade
 */
export const tradeBuy = createTradeFixture({
  tradeId: 'trade_buy',
  side: 'BUY',
  size: 1000,
  price: 0.55,
});

/**
 * Sell trade
 */
export const tradeSell = createTradeFixture({
  tradeId: 'trade_sell',
  side: 'SELL',
  size: 1000,
  price: 0.45,
});

/**
 * Trade from new wallet (< 7 days old)
 */
export const tradeFromNewWallet = createTradeFixture({
  tradeId: 'trade_new_wallet',
  takerAddress: '0x' + 'new'.repeat(13) + 'a', // New wallet address
  size: 5000,
  price: 0.60,
});

/**
 * Trade at extreme price (near 0)
 */
export const tradeLowPrice = createTradeFixture({
  tradeId: 'trade_low_price',
  price: 0.05,
  size: 10000,
});

/**
 * Trade at extreme price (near 1)
 */
export const tradeHighPrice = createTradeFixture({
  tradeId: 'trade_high_price',
  price: 0.95,
  size: 10000,
});

/**
 * Generate a sequence of trades for testing burst detection
 */
export function generateTradeBurst(
  baseTime: number,
  count: number,
  intervalMs: number,
  baseSizeUsd: number = 100
): Trade[] {
  return Array.from({ length: count }, (_, i) => createTradeFixture({
    tradeId: `burst_trade_${i}`,
    timestamp: baseTime + i * intervalMs,
    size: baseSizeUsd + Math.random() * baseSizeUsd,
    price: 0.50 + Math.random() * 0.10,
  }));
}

/**
 * Normal trading activity - trades every ~30 seconds
 */
export const tradesNormalActivity = generateTradeBurst(
  Date.now() - 5 * 60 * 1000, // 5 minutes ago
  10,
  30000, // 30 second intervals
  100
);

/**
 * High activity burst - many trades in short period
 */
export const tradesBurstActivity = generateTradeBurst(
  Date.now() - 60 * 1000, // 1 minute ago
  20,
  3000, // 3 second intervals
  500
);

/**
 * Generate trades with varying sizes for testing size distribution
 */
export function generateSizeDistribution(baseTime: number): Trade[] {
  const sizes = [10, 20, 30, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000];
  return sizes.map((size, i) => createTradeFixture({
    tradeId: `size_dist_trade_${i}`,
    timestamp: baseTime - (sizes.length - i) * 60000,
    size,
    price: 0.50,
  }));
}

/**
 * Historical trades for baseline calculation
 */
export const tradesHistorical = generateSizeDistribution(Date.now());

/**
 * Collection of all trade fixtures
 */
export const tradeFixtures = {
  small: tradeSmall,
  medium: tradeMedium,
  large: tradeLarge,
  veryLarge: tradeVeryLarge,
  extreme: tradeExtreme,
  buy: tradeBuy,
  sell: tradeSell,
  fromNewWallet: tradeFromNewWallet,
  lowPrice: tradeLowPrice,
  highPrice: tradeHighPrice,
  normalActivity: tradesNormalActivity,
  burstActivity: tradesBurstActivity,
  historical: tradesHistorical,
};

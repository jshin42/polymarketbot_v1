// =============================================================================
// Orderbook Fixtures
// =============================================================================
//
// Test fixtures for orderbook data covering balanced, imbalanced, and thin scenarios.

import type { OrderbookSnapshot, OrderbookMetrics, PriceLevel } from '../schemas/orderbook.schema.js';

/**
 * Creates a base orderbook fixture that can be customized
 */
export function createOrderbookFixture(overrides: Partial<OrderbookSnapshot> = {}): OrderbookSnapshot {
  return {
    tokenId: 'test_token_' + Date.now(),
    timestamp: Date.now(),
    bids: [
      { price: 0.55, size: 1000 },
      { price: 0.54, size: 800 },
      { price: 0.53, size: 600 },
      { price: 0.52, size: 400 },
      { price: 0.51, size: 200 },
    ],
    asks: [
      { price: 0.56, size: 1000 },
      { price: 0.57, size: 800 },
      { price: 0.58, size: 600 },
      { price: 0.59, size: 400 },
      { price: 0.60, size: 200 },
    ],
    bestBid: 0.55,
    bestAsk: 0.56,
    midPrice: 0.555,
    spread: 0.01,
    spreadBps: 18.02, // 0.01 / 0.555 * 10000
    ...overrides,
  };
}

/**
 * Balanced orderbook - equal depth on both sides
 */
export const orderbookBalanced = createOrderbookFixture({
  tokenId: 'balanced_orderbook',
  bids: [
    { price: 0.50, size: 5000 },
    { price: 0.49, size: 4000 },
    { price: 0.48, size: 3000 },
    { price: 0.47, size: 2000 },
    { price: 0.46, size: 1000 },
  ],
  asks: [
    { price: 0.51, size: 5000 },
    { price: 0.52, size: 4000 },
    { price: 0.53, size: 3000 },
    { price: 0.54, size: 2000 },
    { price: 0.55, size: 1000 },
  ],
  bestBid: 0.50,
  bestAsk: 0.51,
  midPrice: 0.505,
  spread: 0.01,
  spreadBps: 19.8,
});

/**
 * Bid-heavy orderbook - more buyers than sellers (bullish signal)
 * High imbalance score expected
 */
export const orderbookBidHeavy = createOrderbookFixture({
  tokenId: 'bid_heavy_orderbook',
  bids: [
    { price: 0.60, size: 10000 },
    { price: 0.59, size: 8000 },
    { price: 0.58, size: 6000 },
    { price: 0.57, size: 4000 },
    { price: 0.56, size: 2000 },
  ],
  asks: [
    { price: 0.61, size: 500 },
    { price: 0.62, size: 400 },
    { price: 0.63, size: 300 },
    { price: 0.64, size: 200 },
    { price: 0.65, size: 100 },
  ],
  bestBid: 0.60,
  bestAsk: 0.61,
  midPrice: 0.605,
  spread: 0.01,
  spreadBps: 16.53,
});

/**
 * Ask-heavy orderbook - more sellers than buyers (bearish signal)
 * High imbalance score expected
 */
export const orderbookAskHeavy = createOrderbookFixture({
  tokenId: 'ask_heavy_orderbook',
  bids: [
    { price: 0.40, size: 500 },
    { price: 0.39, size: 400 },
    { price: 0.38, size: 300 },
    { price: 0.37, size: 200 },
    { price: 0.36, size: 100 },
  ],
  asks: [
    { price: 0.41, size: 10000 },
    { price: 0.42, size: 8000 },
    { price: 0.43, size: 6000 },
    { price: 0.44, size: 4000 },
    { price: 0.45, size: 2000 },
  ],
  bestBid: 0.40,
  bestAsk: 0.41,
  midPrice: 0.405,
  spread: 0.01,
  spreadBps: 24.69,
});

/**
 * Thin asks - very little selling liquidity
 * High thin opposite score expected for BUY trades
 */
export const orderbookThinAsks = createOrderbookFixture({
  tokenId: 'thin_asks_orderbook',
  bids: [
    { price: 0.70, size: 8000 },
    { price: 0.69, size: 6000 },
    { price: 0.68, size: 4000 },
    { price: 0.67, size: 2000 },
    { price: 0.66, size: 1000 },
  ],
  asks: [
    { price: 0.71, size: 50 },
    { price: 0.72, size: 30 },
    { price: 0.73, size: 20 },
  ],
  bestBid: 0.70,
  bestAsk: 0.71,
  midPrice: 0.705,
  spread: 0.01,
  spreadBps: 14.18,
});

/**
 * Thin bids - very little buying liquidity
 * High thin opposite score expected for SELL trades
 */
export const orderbookThinBids = createOrderbookFixture({
  tokenId: 'thin_bids_orderbook',
  bids: [
    { price: 0.30, size: 50 },
    { price: 0.29, size: 30 },
    { price: 0.28, size: 20 },
  ],
  asks: [
    { price: 0.31, size: 8000 },
    { price: 0.32, size: 6000 },
    { price: 0.33, size: 4000 },
    { price: 0.34, size: 2000 },
    { price: 0.35, size: 1000 },
  ],
  bestBid: 0.30,
  bestAsk: 0.31,
  midPrice: 0.305,
  spread: 0.01,
  spreadBps: 32.79,
});

/**
 * Wide spread orderbook - execution risk
 */
export const orderbookWideSpread = createOrderbookFixture({
  tokenId: 'wide_spread_orderbook',
  bids: [
    { price: 0.45, size: 2000 },
    { price: 0.44, size: 1500 },
    { price: 0.43, size: 1000 },
  ],
  asks: [
    { price: 0.55, size: 2000 },
    { price: 0.56, size: 1500 },
    { price: 0.57, size: 1000 },
  ],
  bestBid: 0.45,
  bestAsk: 0.55,
  midPrice: 0.50,
  spread: 0.10,
  spreadBps: 2000, // 10% spread - very wide
});

/**
 * Empty orderbook - no liquidity
 */
export const orderbookEmpty = createOrderbookFixture({
  tokenId: 'empty_orderbook',
  bids: [],
  asks: [],
  bestBid: null,
  bestAsk: null,
  midPrice: null,
  spread: null,
  spreadBps: null,
});

/**
 * Deep orderbook - high liquidity
 */
export const orderbookDeep = createOrderbookFixture({
  tokenId: 'deep_orderbook',
  bids: [
    { price: 0.50, size: 50000 },
    { price: 0.49, size: 40000 },
    { price: 0.48, size: 30000 },
    { price: 0.47, size: 20000 },
    { price: 0.46, size: 10000 },
  ],
  asks: [
    { price: 0.51, size: 50000 },
    { price: 0.52, size: 40000 },
    { price: 0.53, size: 30000 },
    { price: 0.54, size: 20000 },
    { price: 0.55, size: 10000 },
  ],
  bestBid: 0.50,
  bestAsk: 0.51,
  midPrice: 0.505,
  spread: 0.01,
  spreadBps: 19.8,
});

/**
 * Calculate expected metrics for a fixture
 */
export function calculateExpectedMetrics(orderbook: OrderbookSnapshot): Partial<OrderbookMetrics> {
  const bidDepth = orderbook.bids.reduce((sum, b) => sum + b.size, 0);
  const askDepth = orderbook.asks.reduce((sum, a) => sum + a.size, 0);
  const totalDepth = bidDepth + askDepth;
  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  return {
    tokenId: orderbook.tokenId,
    timestamp: orderbook.timestamp,
    imbalance,
    totalDepth,
    bidDepthTop5: orderbook.bids.slice(0, 5).reduce((sum, b) => sum + b.size, 0),
    askDepthTop5: orderbook.asks.slice(0, 5).reduce((sum, a) => sum + a.size, 0),
    spreadBps: orderbook.spreadBps ?? 0,
  };
}

/**
 * Collection of all orderbook fixtures
 */
export const orderbookFixtures = {
  balanced: orderbookBalanced,
  bidHeavy: orderbookBidHeavy,
  askHeavy: orderbookAskHeavy,
  thinAsks: orderbookThinAsks,
  thinBids: orderbookThinBids,
  wideSpread: orderbookWideSpread,
  empty: orderbookEmpty,
  deep: orderbookDeep,
};

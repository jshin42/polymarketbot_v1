// =============================================================================
// Wallet Fixtures
// =============================================================================
//
// Test fixtures for wallet profiles covering new, moderate, and established accounts.

import type { WalletProfile, WalletEnrichment } from '../schemas/wallet.schema.js';

/**
 * Creates a base wallet profile fixture that can be customized
 */
export function createWalletProfileFixture(overrides: Partial<WalletProfile> = {}): WalletProfile {
  const now = new Date().toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  return {
    address: ('0x' + Math.random().toString(16).substring(2, 42).padEnd(40, '0')).toLowerCase(),
    firstSeenAt: ninetyDaysAgo,
    transactionCount: 500,
    polymarketTradeCount: 150,
    uniqueMarketsTraded: 25,
    totalVolume: 50000,
    tradesLast24h: 5,
    volumeLast24h: 1000,
    marketsLast24h: 2,
    lastEnrichedAt: now,
    createdAt: ninetyDaysAgo,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Creates a wallet enrichment fixture
 */
export function createWalletEnrichmentFixture(overrides: Partial<WalletEnrichment> = {}): WalletEnrichment {
  const now = new Date().toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  return {
    address: ('0x' + Math.random().toString(16).substring(2, 42).padEnd(40, '0')).toLowerCase(),
    firstSeenAt: ninetyDaysAgo,
    firstSeenBlockNumber: 50000000,
    ageMinutes: 90 * 24 * 60,
    ageDays: 90,
    transactionCount: 500,
    polymarketTradeCount: 150,
    uniqueMarketsTraded: 25,
    totalVolume: 50000,
    isNewAccount: false,
    isLowActivity: false,
    walletAgeScore: 0.3,
    activityScore: 0.2,
    concentrationScore: 0.1,
    lastEnrichedAt: now,
    enrichmentSource: 'polygonscan',
    ttlSeconds: 3600,
    ...overrides,
  };
}

/**
 * Very new wallet - created less than 7 days ago
 * walletAgeScore should be 1.0
 */
export const walletVeryNew = createWalletProfileFixture({
  address: '0x' + 'a'.repeat(40),
  firstSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
  transactionCount: 10,
  polymarketTradeCount: 5,
  uniqueMarketsTraded: 2,
  totalVolume: 500,
  tradesLast24h: 3,
  volumeLast24h: 200,
  marketsLast24h: 1,
});

/**
 * New wallet - created 7-30 days ago
 * walletAgeScore should be 0.7
 */
export const walletNew = createWalletProfileFixture({
  address: '0x' + 'b'.repeat(40),
  firstSeenAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), // 15 days ago
  transactionCount: 50,
  polymarketTradeCount: 20,
  uniqueMarketsTraded: 5,
  totalVolume: 2000,
  tradesLast24h: 2,
  volumeLast24h: 100,
  marketsLast24h: 1,
});

/**
 * Moderate wallet - created 30-180 days ago
 * walletAgeScore should be 0.3
 */
export const walletModerate = createWalletProfileFixture({
  address: '0x' + 'c'.repeat(40),
  firstSeenAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
  transactionCount: 300,
  polymarketTradeCount: 100,
  uniqueMarketsTraded: 15,
  totalVolume: 25000,
  tradesLast24h: 5,
  volumeLast24h: 500,
  marketsLast24h: 2,
});

/**
 * Established wallet - created more than 180 days ago
 * walletAgeScore should be 0.0
 */
export const walletEstablished = createWalletProfileFixture({
  address: '0x' + 'd'.repeat(40),
  firstSeenAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year ago
  transactionCount: 5000,
  polymarketTradeCount: 1000,
  uniqueMarketsTraded: 100,
  totalVolume: 500000,
  tradesLast24h: 10,
  volumeLast24h: 2000,
  marketsLast24h: 5,
});

/**
 * Low activity wallet - few trades despite age
 * High walletActivityScore (suspicious)
 */
export const walletLowActivity = createWalletProfileFixture({
  address: '0x' + 'e'.repeat(40),
  firstSeenAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
  transactionCount: 20, // Very few transactions for 90-day-old wallet
  polymarketTradeCount: 10,
  uniqueMarketsTraded: 3,
  totalVolume: 1000,
  tradesLast24h: 0,
  volumeLast24h: 0,
  marketsLast24h: 0,
});

/**
 * High activity wallet - many trades
 * Low walletActivityScore (normal)
 */
export const walletHighActivity = createWalletProfileFixture({
  address: '0x' + 'f'.repeat(40),
  firstSeenAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(), // 180 days ago
  transactionCount: 10000,
  polymarketTradeCount: 5000,
  uniqueMarketsTraded: 200,
  totalVolume: 2000000,
  tradesLast24h: 50,
  volumeLast24h: 10000,
  marketsLast24h: 10,
});

/**
 * Whale wallet - very large trades
 */
export const walletWhale = createWalletProfileFixture({
  address: '0x' + '1'.repeat(40),
  firstSeenAt: new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString(), // ~10 months ago
  transactionCount: 2000,
  polymarketTradeCount: 500,
  uniqueMarketsTraded: 50,
  totalVolume: 10000000, // $10M total volume
  tradesLast24h: 5,
  volumeLast24h: 100000,
  marketsLast24h: 3,
});

/**
 * Suspicious new wallet with large trade
 * Combination that triggers alerts
 */
export const walletSuspicious = createWalletProfileFixture({
  address: '0x' + '2'.repeat(40),
  firstSeenAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
  transactionCount: 5,
  polymarketTradeCount: 1,
  uniqueMarketsTraded: 1,
  totalVolume: 50000, // Large for new wallet
  tradesLast24h: 1,
  volumeLast24h: 50000,
  marketsLast24h: 1,
});

/**
 * Unknown wallet - no prior history (null firstSeenAt)
 */
export const walletUnknown = createWalletProfileFixture({
  address: '0x' + '3'.repeat(40),
  firstSeenAt: null,
  transactionCount: 0,
  polymarketTradeCount: 0,
  uniqueMarketsTraded: 0,
  totalVolume: 0,
  tradesLast24h: 0,
  volumeLast24h: 0,
  marketsLast24h: 0,
  lastEnrichedAt: null,
});

/**
 * WalletEnrichment fixture for very new wallet
 */
export const enrichmentVeryNew = createWalletEnrichmentFixture({
  address: '0x' + 'a'.repeat(40),
  firstSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  firstSeenBlockNumber: 55000000,
  ageMinutes: 3 * 24 * 60,
  ageDays: 3,
  transactionCount: 10,
  polymarketTradeCount: 5,
  uniqueMarketsTraded: 2,
  totalVolume: 500,
  isNewAccount: true,
  isLowActivity: true,
  walletAgeScore: 1.0,
  activityScore: 0.9,
  concentrationScore: 0.2,
});

/**
 * WalletEnrichment fixture for established wallet
 */
export const enrichmentEstablished = createWalletEnrichmentFixture({
  address: '0x' + 'd'.repeat(40),
  firstSeenAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  firstSeenBlockNumber: 30000000,
  ageMinutes: 365 * 24 * 60,
  ageDays: 365,
  transactionCount: 5000,
  polymarketTradeCount: 1000,
  uniqueMarketsTraded: 100,
  totalVolume: 500000,
  isNewAccount: false,
  isLowActivity: false,
  walletAgeScore: 0.0,
  activityScore: 0.0,
  concentrationScore: 0.05,
});

/**
 * Calculate expected wallet scores from a profile
 */
export function calculateWalletScores(wallet: WalletProfile): {
  walletAgeScore: number;
  walletActivityScore: number;
} {
  // Calculate age in days
  let ageDays: number | null = null;
  if (wallet.firstSeenAt) {
    const firstSeenMs = new Date(wallet.firstSeenAt).getTime();
    ageDays = (Date.now() - firstSeenMs) / (24 * 60 * 60 * 1000);
  }

  // walletAgeScore based on age (from wallet.schema.ts computeWalletAgeScore)
  let walletAgeScore: number;
  if (ageDays === null) {
    walletAgeScore = 0.5; // Unknown age - neutral
  } else if (ageDays < 7) {
    walletAgeScore = 1.0;
  } else if (ageDays < 30) {
    walletAgeScore = 0.7;
  } else if (ageDays < 180) {
    walletAgeScore = 0.3;
  } else {
    walletAgeScore = 0.0;
  }

  // walletActivityScore based on activity metrics
  // Low trades + low markets = high score (suspicious)
  const tradesScore = Math.max(0, 1 - wallet.polymarketTradeCount / 100);
  const marketsScore = Math.max(0, 1 - wallet.uniqueMarketsTraded / 20);
  const volumeScore = Math.max(0, 1 - wallet.totalVolume / 10000);
  const walletActivityScore = tradesScore * 0.4 + marketsScore * 0.3 + volumeScore * 0.3;

  return { walletAgeScore, walletActivityScore };
}

/**
 * Collection of all wallet profile fixtures
 */
export const walletProfileFixtures = {
  veryNew: walletVeryNew,
  new: walletNew,
  moderate: walletModerate,
  established: walletEstablished,
  lowActivity: walletLowActivity,
  highActivity: walletHighActivity,
  whale: walletWhale,
  suspicious: walletSuspicious,
  unknown: walletUnknown,
};

/**
 * Collection of all wallet enrichment fixtures
 */
export const walletEnrichmentFixtures = {
  veryNew: enrichmentVeryNew,
  established: enrichmentEstablished,
};

/**
 * Legacy alias for backwards compatibility
 */
export const walletFixtures = walletProfileFixtures;

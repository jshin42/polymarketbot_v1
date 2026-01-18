// =============================================================================
// Feature Vector Fixtures
// =============================================================================
//
// Complete feature vectors for testing scoring and decision logic.

import type {
  FeatureVector,
  TimeToCloseFeature,
  TradeSizeFeature,
  OrderbookFeature,
  WalletFeature,
  ImpactFeature,
  BurstFeature,
  ChangePointFeature,
} from '../schemas/feature.schema.js';

/**
 * Creates a base feature vector that can be customized
 */
export function createFeatureVectorFixture(overrides: Partial<FeatureVector> = {}): FeatureVector {
  const now = Date.now();

  return {
    tokenId: 'test_token_' + now,
    conditionId: '0x' + '1'.repeat(64),
    timestamp: now,
    timeToClose: createTimeToCloseFixture(),
    tradeSize: createTradeSizeFixture(),
    orderbook: createOrderbookFeatureFixture(),
    wallet: createWalletFeatureFixture(),
    impact: createImpactFixture(),
    burst: createBurstFixture(),
    changePoint: createChangePointFixture(),
    dataComplete: true,
    dataStale: false,
    lastBookUpdate: now - 1000,
    lastTradeUpdate: now - 5000,
    ...overrides,
  };
}

/**
 * Create time-to-close feature
 */
export function createTimeToCloseFixture(overrides: Partial<TimeToCloseFeature> = {}): TimeToCloseFeature {
  return {
    ttcSeconds: 600, // 10 minutes
    ttcMinutes: 10,
    ttcHours: 0.167,
    rampMultiplier: 2.0,
    inLast5Minutes: false,
    inLast15Minutes: true,
    inLast30Minutes: true,
    inLastHour: true,
    inLast2Hours: true,
    inNoTradeZone: false,
    ...overrides,
  };
}

/**
 * Create trade size feature
 */
export function createTradeSizeFixture(overrides: Partial<TradeSizeFeature> = {}): TradeSizeFeature {
  return {
    size: 1000,
    sizeUsd: 500,
    robustZScore: 1.5,
    percentile: 85,
    rollingMedian: 200,
    rollingMad: 100,
    rollingQ95: 800,
    rollingQ99: 2000,
    rollingQ999: 5000,
    sizeTailScore: 0.4, // Below q95
    isLargeTrade: false,
    isTailTrade: false,
    isExtremeTrade: false,
    ...overrides,
  };
}

/**
 * Create orderbook feature
 */
export function createOrderbookFeatureFixture(overrides: Partial<OrderbookFeature> = {}): OrderbookFeature {
  return {
    bidDepth: 5000,
    askDepth: 5000,
    totalDepth: 10000,
    imbalance: 0.0,
    imbalanceAbs: 0.0,
    bookImbalanceScore: 0.0,
    thinSide: 'balanced',
    thinSideRatio: 1.0,
    thinOppositeScore: 0.0,
    spreadBps: 20,
    spreadScore: 0.96, // 1 - 20/500
    depthScore: 1.0,
    isAsymmetric: false,
    ...overrides,
  };
}

/**
 * Create wallet feature
 */
export function createWalletFeatureFixture(overrides: Partial<WalletFeature> = {}): WalletFeature {
  return {
    walletAddress: '0x' + 'a'.repeat(40),
    walletAgeDays: 100,
    walletAgeMinutes: 144000,
    tradeCount: 200,
    marketsTraded: 30,
    totalVolume: 100000,
    walletNewScore: 0.0, // Old wallet
    walletActivityScore: 0.0, // Normal activity
    walletConcentrationScore: 0.1,
    walletRiskScore: 0.0,
    isNewAccount: false,
    isLowActivity: false,
    isHighConcentration: false,
    ...overrides,
  };
}

/**
 * Create impact feature
 */
export function createImpactFixture(overrides: Partial<ImpactFeature> = {}): ImpactFeature {
  return {
    tradeTimestamp: Date.now() - 60000,
    tradeSide: 'BUY',
    tradePrice: 0.55,
    midAtTrade: 0.54,
    midAfter30s: 0.56,
    midAfter60s: 0.57,
    drift30s: 0.037, // (0.56 - 0.54) / 0.54
    drift60s: 0.056, // (0.57 - 0.54) / 0.54
    driftMagnitude30s: 0.037,
    driftMagnitude60s: 0.056,
    impactScore30s: 0.37,
    impactScore60s: 0.56,
    impactScore: 0.5,
    priceConfirmed: true,
    ...overrides,
  };
}

/**
 * Create burst feature
 */
export function createBurstFixture(overrides: Partial<BurstFeature> = {}): BurstFeature {
  return {
    tradeCount1m: 3,
    tradeCount5m: 10,
    tradesPerMinute: 2.0,
    avgInterArrival: 30000, // 30 seconds
    minInterArrival: 10000,
    hawkesIntensity: 0.1,
    baselineIntensity: 0.05,
    intensityRatio: 2.0,
    burstScore: 0.3,
    burstDetected: false,
    ...overrides,
  };
}

/**
 * Create change point feature
 */
export function createChangePointFixture(overrides: Partial<ChangePointFeature> = {}): ChangePointFeature {
  return {
    focusStatistic: 2.5,
    threshold: 5.0,
    changePointDetected: false,
    changePointTimestamp: null,
    regimeShift: 'none',
    shiftMagnitude: 0,
    changePointScore: 0.0,
    ...overrides,
  };
}

// =============================================================================
// Pre-built Scenario Fixtures
// =============================================================================

/**
 * Triple signal scenario - all three signals high
 * Size tail + Book imbalance + New wallet
 */
export const featureTripleSignal = createFeatureVectorFixture({
  tokenId: 'triple_signal_token',
  timeToClose: createTimeToCloseFixture({
    ttcSeconds: 300, // 5 minutes
    ttcMinutes: 5,
    rampMultiplier: 3.0,
    inLast5Minutes: true,
  }),
  tradeSize: createTradeSizeFixture({
    size: 20000,
    sizeUsd: 12000,
    robustZScore: 5.0,
    percentile: 99.5,
    sizeTailScore: 0.95,
    isLargeTrade: true,
    isTailTrade: true,
    isExtremeTrade: true,
  }),
  orderbook: createOrderbookFeatureFixture({
    bidDepth: 15000,
    askDepth: 1000,
    totalDepth: 16000,
    imbalance: 0.875, // (15000 - 1000) / 16000
    imbalanceAbs: 0.875,
    bookImbalanceScore: 0.95,
    thinSide: 'ask',
    thinSideRatio: 0.067, // 1000 / 15000
    thinOppositeScore: 0.93,
    isAsymmetric: true,
  }),
  wallet: createWalletFeatureFixture({
    walletAgeDays: 3,
    tradeCount: 2,
    marketsTraded: 1,
    walletNewScore: 1.0,
    walletActivityScore: 0.9,
    walletRiskScore: 0.95,
    isNewAccount: true,
    isLowActivity: true,
  }),
  impact: createImpactFixture({
    drift60s: 0.10,
    impactScore: 0.8,
    priceConfirmed: true,
  }),
  changePoint: createChangePointFixture({
    focusStatistic: 7.0,
    changePointDetected: true,
    changePointTimestamp: Date.now() - 30000,
    regimeShift: 'increase',
    shiftMagnitude: 0.15,
    changePointScore: 0.85,
  }),
});

/**
 * Normal market activity - no significant signals
 */
export const featureNormal = createFeatureVectorFixture({
  tokenId: 'normal_token',
  timeToClose: createTimeToCloseFixture({
    ttcSeconds: 7200, // 2 hours
    ttcMinutes: 120,
    ttcHours: 2,
    rampMultiplier: 1.0,
    inLast5Minutes: false,
    inLast15Minutes: false,
    inLast30Minutes: false,
    inLastHour: false,
    inLast2Hours: true,
  }),
  tradeSize: createTradeSizeFixture({
    size: 200,
    sizeUsd: 100,
    robustZScore: 0.5,
    percentile: 60,
    sizeTailScore: 0.3,
    isLargeTrade: false,
    isTailTrade: false,
    isExtremeTrade: false,
  }),
  orderbook: createOrderbookFeatureFixture({
    bidDepth: 5000,
    askDepth: 4800,
    imbalance: 0.02,
    imbalanceAbs: 0.02,
    bookImbalanceScore: 0.03,
    thinSideRatio: 0.96,
    thinOppositeScore: 0.04,
    isAsymmetric: false,
  }),
  wallet: createWalletFeatureFixture({
    walletAgeDays: 200,
    tradeCount: 500,
    walletNewScore: 0.0,
    walletActivityScore: 0.0,
    walletRiskScore: 0.0,
    isNewAccount: false,
    isLowActivity: false,
  }),
});

/**
 * No-trade zone scenario
 */
export const featureNoTradeZone = createFeatureVectorFixture({
  tokenId: 'no_trade_zone_token',
  timeToClose: createTimeToCloseFixture({
    ttcSeconds: 60, // 1 minute - in no-trade zone
    ttcMinutes: 1,
    rampMultiplier: 5.0,
    inLast5Minutes: true,
    inNoTradeZone: true,
  }),
  // Even with high signals, should not trade
  tradeSize: createTradeSizeFixture({
    sizeTailScore: 0.95,
  }),
  orderbook: createOrderbookFeatureFixture({
    bookImbalanceScore: 0.9,
    thinOppositeScore: 0.85,
  }),
});

/**
 * Stale data scenario
 */
export const featureStaleData = createFeatureVectorFixture({
  tokenId: 'stale_data_token',
  dataComplete: false,
  dataStale: true,
  lastBookUpdate: Date.now() - 30000, // 30 seconds old (stale)
  lastTradeUpdate: Date.now() - 60000,
});

/**
 * High execution risk - wide spread, low liquidity
 */
export const featureHighExecutionRisk = createFeatureVectorFixture({
  tokenId: 'high_exec_risk_token',
  orderbook: createOrderbookFeatureFixture({
    bidDepth: 100,
    askDepth: 100,
    totalDepth: 200,
    spreadBps: 300, // 3% spread - very wide
    spreadScore: 0.4,
    depthScore: 0.2,
  }),
});

/**
 * Large trade only - no book imbalance or new wallet
 */
export const featureLargeTradeOnly = createFeatureVectorFixture({
  tokenId: 'large_trade_only_token',
  tradeSize: createTradeSizeFixture({
    size: 50000,
    sizeUsd: 30000,
    robustZScore: 6.0,
    percentile: 99.9,
    sizeTailScore: 0.99,
    isLargeTrade: true,
    isTailTrade: true,
    isExtremeTrade: true,
  }),
  orderbook: createOrderbookFeatureFixture({
    imbalance: 0.1,
    imbalanceAbs: 0.1,
    bookImbalanceScore: 0.14,
    thinOppositeScore: 0.1,
    isAsymmetric: false,
  }),
  wallet: createWalletFeatureFixture({
    walletAgeDays: 300,
    walletNewScore: 0.0,
    walletActivityScore: 0.0,
    isNewAccount: false,
  }),
});

/**
 * Collection of all feature fixtures
 */
export const featureFixtures = {
  tripleSignal: featureTripleSignal,
  normal: featureNormal,
  noTradeZone: featureNoTradeZone,
  staleData: featureStaleData,
  highExecutionRisk: featureHighExecutionRisk,
  largeTradeOnly: featureLargeTradeOnly,
};

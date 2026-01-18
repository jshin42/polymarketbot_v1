import { z } from 'zod';
import { DOLLAR_FLOOR_DEFAULTS } from '../constants/index.js';

// =============================================================================
// Feature Vector Schemas
// =============================================================================

/**
 * Time-to-close feature group
 */
export const TimeToCloseFeatureSchema = z.object({
  ttcSeconds: z.number().nonnegative(),
  ttcMinutes: z.number().nonnegative(),
  ttcHours: z.number().nonnegative(),

  // Ramp multiplier: increases as close approaches
  // 1.0 when far from close, up to maxMultiplier near close
  rampMultiplier: z.number().min(1),

  // Categorical time buckets
  inLast5Minutes: z.boolean(),
  inLast15Minutes: z.boolean(),
  inLast30Minutes: z.boolean(),
  inLastHour: z.boolean(),
  inLast2Hours: z.boolean(),

  // No-trade zone flag
  inNoTradeZone: z.boolean(), // Last 120s by default
});

export type TimeToCloseFeature = z.infer<typeof TimeToCloseFeatureSchema>;

/**
 * Trade size / large bet feature group
 */
export const TradeSizeFeatureSchema = z.object({
  // Raw values
  size: z.number().positive(),
  sizeUsd: z.number().positive(),

  // Statistical measures
  robustZScore: z.number(),
  percentile: z.number().min(0).max(100),

  // Rolling baseline stats
  rollingMedian: z.number().nonnegative(),
  rollingMad: z.number().nonnegative(), // Median Absolute Deviation
  rollingQ95: z.number().nonnegative(),
  rollingQ99: z.number().nonnegative(),
  rollingQ999: z.number().nonnegative(),

  // Dollar floor multiplier applied (0-1)
  // 0 below $5k, 0.5 for $5k-$10k, 0.75 for $10k-$25k, 1.0 above $25k
  dollarFloorMultiplier: z.number().min(0).max(1),

  // Raw percentile-based score before dollar floor adjustment
  rawSizeTailScore: z.number().min(0).max(1),

  // Computed score: 0-1 scale (after dollar floor adjustment)
  // rawSizeTailScore * dollarFloorMultiplier
  sizeTailScore: z.number().min(0).max(1),

  // Flags
  isLargeTrade: z.boolean(), // z > 3 or percentile > 99
  isTailTrade: z.boolean(), // percentile > 95
  isExtremeTrade: z.boolean(), // percentile > 99.9
});

export type TradeSizeFeature = z.infer<typeof TradeSizeFeatureSchema>;

/**
 * Order book asymmetry feature group
 */
export const OrderbookFeatureSchema = z.object({
  // Depth metrics
  bidDepth: z.number().nonnegative(),
  askDepth: z.number().nonnegative(),
  totalDepth: z.number().nonnegative(),

  // Imbalance: (bidDepth - askDepth) / (bidDepth + askDepth)
  imbalance: z.number().min(-1).max(1),
  imbalanceAbs: z.number().min(0).max(1),

  // Book imbalance score (mapped to 0-1)
  bookImbalanceScore: z.number().min(0).max(1),

  // Thin opposite side metrics
  thinSide: z.enum(['bid', 'ask', 'balanced']),
  thinSideRatio: z.number().min(0).max(1),
  thinOppositeScore: z.number().min(0).max(1),

  // Spread metrics
  spreadBps: z.number().nonnegative(),
  spreadScore: z.number().min(0).max(1), // 1 = narrow (good), 0 = wide (bad)

  // Depth adequacy
  depthScore: z.number().min(0).max(1), // 1 = sufficient depth

  // Combined asymmetry flag
  isAsymmetric: z.boolean(), // imbalance > 0.5 AND thinSideRatio < 0.3
});

export type OrderbookFeature = z.infer<typeof OrderbookFeatureSchema>;

/**
 * Wallet / new account feature group
 */
export const WalletFeatureSchema = z.object({
  walletAddress: z.string(),

  // Age metrics
  walletAgeDays: z.number().nonnegative().nullable(),
  walletAgeMinutes: z.number().nonnegative().nullable(),

  // Activity metrics
  tradeCount: z.number().int().nonnegative(),
  marketsTraded: z.number().int().nonnegative(),
  totalVolume: z.number().nonnegative(),

  // Computed scores
  walletNewScore: z.number().min(0).max(1), // 1.0 if new account
  walletActivityScore: z.number().min(0).max(1), // 1.0 if low activity
  walletConcentrationScore: z.number().min(0).max(1), // Volume share

  // Combined risk score
  walletRiskScore: z.number().min(0).max(1),

  // Flags
  isNewAccount: z.boolean(),
  isLowActivity: z.boolean(),
  isHighConcentration: z.boolean(),
});

export type WalletFeature = z.infer<typeof WalletFeatureSchema>;

/**
 * Price impact / confirmation feature group
 */
export const ImpactFeatureSchema = z.object({
  // Trade context
  tradeTimestamp: z.number().int().positive(),
  tradeSide: z.enum(['BUY', 'SELL']),
  tradePrice: z.number().min(0).max(1),

  // Mid price at trade time and after
  midAtTrade: z.number().min(0).max(1),
  midAfter30s: z.number().min(0).max(1).nullable(),
  midAfter60s: z.number().min(0).max(1).nullable(),

  // Drift calculations: sign * (mid_after - mid_at) / mid_at
  // Positive drift = price moved in trade direction
  drift30s: z.number().nullable(),
  drift60s: z.number().nullable(),

  // Drift magnitude (absolute)
  driftMagnitude30s: z.number().nonnegative().nullable(),
  driftMagnitude60s: z.number().nonnegative().nullable(),

  // Impact score: positive if price confirms trade direction
  impactScore30s: z.number().min(-1).max(1).nullable(),
  impactScore60s: z.number().min(-1).max(1).nullable(),

  // Combined impact score (scaled 0-1, only positive)
  impactScore: z.number().min(0).max(1),

  // Confirmation flag
  priceConfirmed: z.boolean(), // drift > 0 in trade direction
});

export type ImpactFeature = z.infer<typeof ImpactFeatureSchema>;

/**
 * Burst / clustering feature group (Hawkes process proxy)
 */
export const BurstFeatureSchema = z.object({
  // Trade rate
  tradeCount1m: z.number().int().nonnegative(),
  tradeCount5m: z.number().int().nonnegative(),
  tradesPerMinute: z.number().nonnegative(),

  // Inter-arrival times
  avgInterArrival: z.number().nonnegative().nullable(), // ms
  minInterArrival: z.number().nonnegative().nullable(),

  // Hawkes intensity estimate
  hawkesIntensity: z.number().nonnegative(),
  baselineIntensity: z.number().nonnegative(),
  intensityRatio: z.number().nonnegative(), // intensity / baseline

  // Burst score (0-1)
  burstScore: z.number().min(0).max(1),

  // Flags
  burstDetected: z.boolean(), // intensity > 2 * baseline
});

export type BurstFeature = z.infer<typeof BurstFeatureSchema>;

/**
 * Change-point detection feature group (FOCuS / CUSUM)
 */
export const ChangePointFeatureSchema = z.object({
  // FOCuS statistic
  focusStatistic: z.number().nonnegative(),
  threshold: z.number().positive(),

  // Change point detection
  changePointDetected: z.boolean(),
  changePointTimestamp: z.number().int().nullable(),

  // Regime shift direction
  regimeShift: z.enum(['none', 'increase', 'decrease']),
  shiftMagnitude: z.number().nonnegative(),

  // Change point score (0-1)
  changePointScore: z.number().min(0).max(1),
});

export type ChangePointFeature = z.infer<typeof ChangePointFeatureSchema>;

/**
 * Complete feature vector for a token at a point in time
 */
export const FeatureVectorSchema = z.object({
  // Identifiers
  tokenId: z.string(),
  conditionId: z.string().optional(),
  timestamp: z.number().int().positive(),

  // Feature groups
  timeToClose: TimeToCloseFeatureSchema,
  tradeSize: TradeSizeFeatureSchema.nullable(), // Null if no recent trade
  orderbook: OrderbookFeatureSchema,
  wallet: WalletFeatureSchema.nullable(), // Null if wallet unknown
  impact: ImpactFeatureSchema.nullable(), // Null if insufficient data
  burst: BurstFeatureSchema,
  changePoint: ChangePointFeatureSchema,

  // Data quality flags
  dataComplete: z.boolean(), // All required features present
  dataStale: z.boolean(), // Any data beyond staleness threshold
  lastBookUpdate: z.number().int().positive(),
  lastTradeUpdate: z.number().int().nullable(),
});

export type FeatureVector = z.infer<typeof FeatureVectorSchema>;

/**
 * Compute the dollar floor multiplier for trade size scoring.
 * Trades must meet both statistical anomaly AND minimum dollar size.
 *
 * @param notionalUsd - The dollar value of the trade
 * @returns Multiplier from 0 to 1
 */
export function computeDollarFloorMultiplier(notionalUsd: number): number {
  const {
    MIN_ANOMALY_TRADE_USD,
    TIER_1_THRESHOLD_USD,
    TIER_2_THRESHOLD_USD,
  } = DOLLAR_FLOOR_DEFAULTS;

  if (notionalUsd < MIN_ANOMALY_TRADE_USD) return 0; // Below $5k: 0
  if (notionalUsd < TIER_1_THRESHOLD_USD) return 0.5; // $5k-$10k: 50%
  if (notionalUsd < TIER_2_THRESHOLD_USD) return 0.75; // $10k-$25k: 75%
  return 1.0; // Above $25k: 100%
}

/**
 * Compute raw size tail score from percentile (before dollar floor adjustment)
 * 0.5 at q95, 0.9 at q99, 0.98 at q999
 */
export function computeRawSizeTailScore(percentile: number): number {
  if (percentile < 95) {
    // Linear from 0 to 0.5 between 0 and 95
    return (percentile / 95) * 0.5;
  } else if (percentile < 99) {
    // Linear from 0.5 to 0.9 between 95 and 99
    return 0.5 + ((percentile - 95) / 4) * 0.4;
  } else if (percentile < 99.9) {
    // Linear from 0.9 to 0.98 between 99 and 99.9
    return 0.9 + ((percentile - 99) / 0.9) * 0.08;
  } else {
    // Cap at 1.0
    return Math.min(1.0, 0.98 + ((percentile - 99.9) / 0.1) * 0.02);
  }
}

/**
 * Compute size tail score from percentile with dollar floor adjustment.
 * The dollar floor ensures small-dollar trades don't generate high scores
 * even if statistically anomalous.
 *
 * @param percentile - The trade's percentile in the size distribution (0-100)
 * @param notionalUsd - Optional dollar value of the trade for floor adjustment
 * @returns Adjusted size tail score (0-1)
 */
export function computeSizeTailScore(
  percentile: number,
  notionalUsd?: number
): number {
  const rawScore = computeRawSizeTailScore(percentile);

  // Apply dollar floor multiplier if notional provided
  if (notionalUsd !== undefined) {
    return rawScore * computeDollarFloorMultiplier(notionalUsd);
  }

  return rawScore;
}

/**
 * Compute book imbalance score from raw imbalance
 */
export function computeBookImbalanceScore(imbalance: number): number {
  const absImbalance = Math.abs(imbalance);
  // Sigmoid-like mapping with saturation at ±0.7
  return Math.min(1, absImbalance / 0.7);
}

/**
 * Compute thin opposite score
 */
export function computeThinOppositeScore(thinSideRatio: number): number {
  // Score is high when opposite side is thin (ratio is low)
  return Math.max(0, 1 - thinSideRatio);
}

/**
 * Compute spread score (1 = narrow/good, 0 = wide/bad)
 */
export function computeSpreadScore(spreadBps: number, maxSpreadBps = 500): number {
  return Math.max(0, 1 - spreadBps / maxSpreadBps);
}

/**
 * Compute depth score (1 = sufficient, 0 = insufficient)
 */
export function computeDepthScore(depth: number, minDepth = 100): number {
  return Math.min(1, depth / minDepth);
}

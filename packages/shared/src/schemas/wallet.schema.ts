import { z } from 'zod';

// =============================================================================
// Wallet Schemas
// =============================================================================

/**
 * Ethereum address validation
 */
export const EthAddressSchema = z.string()
  .length(42)
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address')
  .transform(addr => addr.toLowerCase());

export type EthAddress = z.infer<typeof EthAddressSchema>;

/**
 * Wallet enrichment data from on-chain sources (Polygonscan)
 */
export const WalletEnrichmentSchema = z.object({
  address: EthAddressSchema,

  // Temporal data
  firstSeenAt: z.string().datetime().nullable(),
  firstSeenBlockNumber: z.number().int().positive().nullable(),
  ageMinutes: z.number().nonnegative().nullable(),
  ageDays: z.number().nonnegative().nullable(),

  // Activity metrics
  transactionCount: z.number().int().nonnegative(),
  polymarketTradeCount: z.number().int().nonnegative(),
  uniqueMarketsTraded: z.number().int().nonnegative(),
  totalVolume: z.number().nonnegative(),

  // Computed scores
  isNewAccount: z.boolean(), // age < 7 days
  isLowActivity: z.boolean(), // trade count < 10
  walletAgeScore: z.number().min(0).max(1), // 1.0 for new, 0.0 for old
  activityScore: z.number().min(0).max(1), // Low activity = high score
  concentrationScore: z.number().min(0).max(1), // Volume share

  // Metadata
  lastEnrichedAt: z.string().datetime(),
  enrichmentSource: z.enum(['polygonscan', 'alchemy', 'cache']),
  ttlSeconds: z.number().int().positive(),
});

export type WalletEnrichment = z.infer<typeof WalletEnrichmentSchema>;

/**
 * Wallet profile stored in database
 */
export const WalletProfileSchema = z.object({
  address: EthAddressSchema,

  // From enrichment
  firstSeenAt: z.string().datetime().nullable(),
  transactionCount: z.number().int().nonnegative(),
  polymarketTradeCount: z.number().int().nonnegative(),
  uniqueMarketsTraded: z.number().int().nonnegative(),
  totalVolume: z.number().nonnegative(),

  // Rolling metrics (computed from recent activity)
  tradesLast24h: z.number().int().nonnegative(),
  volumeLast24h: z.number().nonnegative(),
  marketsLast24h: z.number().int().nonnegative(),

  // Timestamps
  lastEnrichedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WalletProfile = z.infer<typeof WalletProfileSchema>;

/**
 * Polygonscan API response for first transaction
 */
export const PolygonscanTxResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  result: z.array(z.object({
    blockNumber: z.string(),
    timeStamp: z.string(),
    hash: z.string(),
    from: z.string(),
    to: z.string(),
    value: z.string(),
  })).or(z.string()), // API returns string on error
});

export type PolygonscanTxResponse = z.infer<typeof PolygonscanTxResponseSchema>;

/**
 * Compute wallet age score based on account age
 * - 1.0 if age < 7 days (very suspicious)
 * - 0.7 if age < 30 days
 * - 0.3 if age < 180 days
 * - 0.0 if age >= 180 days
 */
export function computeWalletAgeScore(ageDays: number | null): number {
  if (ageDays === null) return 0.5; // Unknown age - neutral
  if (ageDays < 7) return 1.0;
  if (ageDays < 30) return 0.7;
  if (ageDays < 180) return 0.3;
  return 0.0;
}

/**
 * Compute activity score based on trade history
 * Low activity = high score (suspicious)
 */
export function computeActivityScore(
  tradeCount: number,
  marketsTraded: number,
  volume: number
): number {
  // Normalize each factor
  const tradeScore = Math.max(0, 1 - tradeCount / 100); // 100+ trades = 0
  const marketScore = Math.max(0, 1 - marketsTraded / 20); // 20+ markets = 0
  const volumeScore = Math.max(0, 1 - volume / 10000); // $10k+ volume = 0

  // Weighted average
  return tradeScore * 0.4 + marketScore * 0.3 + volumeScore * 0.3;
}

/**
 * Compute combined wallet risk score
 */
export function computeWalletRiskScore(
  ageScore: number,
  activityScore: number,
  concentrationScore: number = 0
): number {
  return (
    ageScore * 0.40 +
    activityScore * 0.35 +
    concentrationScore * 0.25
  );
}

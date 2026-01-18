import { z } from 'zod';

// =============================================================================
// Trade Schemas
// =============================================================================

/**
 * Trade side enum
 */
export const TradeSideSchema = z.enum(['BUY', 'SELL']);
export type TradeSide = z.infer<typeof TradeSideSchema>;

/**
 * Single trade record
 */
export const TradeSchema = z.object({
  tradeId: z.string().min(1),
  tokenId: z.string().min(1),
  timestamp: z.number().int().positive(),
  makerAddress: z.string().length(42).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  takerAddress: z.string().length(42).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  side: TradeSideSchema,
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  feeRateBps: z.number().int().nonnegative().optional(),
  // Transaction hash for on-chain verification (Polygonscan link)
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
});

export type Trade = z.infer<typeof TradeSchema>;

/**
 * Trade with computed metrics for feature engineering
 */
export const TradeWithMetricsSchema = TradeSchema.extend({
  // Size metrics
  sizeUsd: z.number().positive(),

  // Statistical metrics (computed from rolling window)
  robustZScore: z.number(),
  percentile: z.number().min(0).max(100),

  // Flags
  isLargeTrade: z.boolean(), // z > 3 or percentile > 99
  isTailTrade: z.boolean(), // percentile > 95
});

export type TradeWithMetrics = z.infer<typeof TradeWithMetricsSchema>;

/**
 * Trade aggregation for time window
 */
export const TradeAggregateSchema = z.object({
  tokenId: z.string(),
  windowStart: z.number().int().positive(),
  windowEnd: z.number().int().positive(),
  windowMinutes: z.number().positive(),

  // Count metrics
  tradeCount: z.number().int().nonnegative(),
  buyCount: z.number().int().nonnegative(),
  sellCount: z.number().int().nonnegative(),

  // Volume metrics
  totalVolume: z.number().nonnegative(),
  buyVolume: z.number().nonnegative(),
  sellVolume: z.number().nonnegative(),
  volumeImbalance: z.number().min(-1).max(1),

  // Price metrics
  vwap: z.number().min(0).max(1).nullable(),
  priceHigh: z.number().min(0).max(1).nullable(),
  priceLow: z.number().min(0).max(1).nullable(),
  priceOpen: z.number().min(0).max(1).nullable(),
  priceClose: z.number().min(0).max(1).nullable(),

  // Size distribution
  sizeMedian: z.number().nonnegative(),
  sizeMad: z.number().nonnegative(), // Median Absolute Deviation
  sizeQ95: z.number().nonnegative(),
  sizeQ99: z.number().nonnegative(),

  // Rate metrics
  tradesPerMinute: z.number().nonnegative(),
  avgInterArrival: z.number().nonnegative().nullable(), // ms between trades

  // Unique wallets
  uniqueMakers: z.number().int().nonnegative(),
  uniqueTakers: z.number().int().nonnegative(),
});

export type TradeAggregate = z.infer<typeof TradeAggregateSchema>;

/**
 * Raw CLOB trade response
 */
export const ClobTradeResponseSchema = z.object({
  id: z.string(),
  asset_id: z.string(),
  market: z.string().optional(),
  timestamp: z.string(),
  maker_address: z.string(),
  taker_address: z.string(),
  side: z.string(),
  price: z.string(),
  size: z.string(),
  fee_rate_bps: z.string().optional(),
  match_time: z.string().optional(),
  transaction_hash: z.string().optional(),
});

export type ClobTradeResponse = z.infer<typeof ClobTradeResponseSchema>;

/**
 * Transform CLOB API response to canonical Trade
 */
export function transformClobTrade(raw: ClobTradeResponse): Trade {
  return {
    tradeId: raw.id,
    tokenId: raw.asset_id,
    timestamp: new Date(raw.timestamp).getTime(),
    makerAddress: raw.maker_address.toLowerCase() as `0x${string}`,
    takerAddress: raw.taker_address.toLowerCase() as `0x${string}`,
    side: raw.side.toUpperCase() as TradeSide,
    price: parseFloat(raw.price),
    size: parseFloat(raw.size),
    feeRateBps: raw.fee_rate_bps ? parseInt(raw.fee_rate_bps, 10) : undefined,
  };
}

/**
 * WebSocket trade event schema
 */
export const WsTradeEventSchema = z.object({
  event_type: z.literal('last_trade_price'),
  asset_id: z.string(),
  market: z.string().optional(),
  price: z.string(),
  size: z.string(),
  side: z.string(),
  fee_rate_bps: z.string().optional(),
  timestamp: z.string().optional(),
});

export type WsTradeEvent = z.infer<typeof WsTradeEventSchema>;

/**
 * Raw Data API trade response (no authentication required)
 * This endpoint provides market-wide trades without needing L2 auth
 */
export const DataApiTradeResponseSchema = z.object({
  proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  side: z.enum(['BUY', 'SELL']),
  asset: z.string(), // token ID
  conditionId: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  title: z.string().optional().nullable(),
  slug: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  eventSlug: z.string().optional().nullable(),
  outcome: z.string().optional().nullable(),
  outcomeIndex: z.number().optional().nullable(),
  name: z.string().optional().nullable(),
  pseudonym: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
  profileImage: z.string().optional().nullable(),
  profileImageOptimized: z.string().optional().nullable(),
  transactionHash: z.string().optional().nullable(),
});

export type DataApiTradeResponse = z.infer<typeof DataApiTradeResponseSchema>;

/**
 * Transform Data API response to canonical Trade
 * Preserves transactionHash for on-chain verification via Polygonscan
 */
export function transformDataApiTrade(raw: DataApiTradeResponse): Trade {
  // Preserve the transaction hash if it's a valid format, otherwise undefined
  const transactionHash = raw.transactionHash && /^0x[a-fA-F0-9]{64}$/.test(raw.transactionHash)
    ? raw.transactionHash
    : undefined;

  return {
    tradeId: transactionHash || `${raw.conditionId}-${raw.timestamp}-${raw.proxyWallet}`,
    tokenId: raw.asset,
    timestamp: raw.timestamp * 1000, // Convert seconds to milliseconds
    makerAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`, // Not available in Data API
    takerAddress: raw.proxyWallet.toLowerCase() as `0x${string}`,
    side: raw.side,
    price: raw.price,
    size: raw.size,
    transactionHash,
  };
}

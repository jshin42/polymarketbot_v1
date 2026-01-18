import { z } from 'zod';

// =============================================================================
// Order Book Schemas
// =============================================================================

/**
 * Single price level in the order book
 */
export const PriceLevelSchema = z.object({
  price: z.number().min(0).max(1),
  size: z.number().positive(),
});

export type PriceLevel = z.infer<typeof PriceLevelSchema>;

/**
 * Order book snapshot from CLOB API
 */
export const OrderbookSnapshotSchema = z.object({
  tokenId: z.string().min(1),
  timestamp: z.number().int().positive(),
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  bestBid: z.number().min(0).max(1).nullable(),
  bestAsk: z.number().min(0).max(1).nullable(),
  midPrice: z.number().min(0).max(1).nullable(),
  spread: z.number().min(0).nullable(),
  spreadBps: z.number().nonnegative().nullable(),
  hash: z.string().optional(),
});

export type OrderbookSnapshot = z.infer<typeof OrderbookSnapshotSchema>;

/**
 * Computed order book metrics for feature engineering
 */
export const OrderbookMetricsSchema = z.object({
  tokenId: z.string().min(1),
  timestamp: z.number().int().positive(),

  // Depth at various levels
  bidDepth5Pct: z.number().nonnegative(), // Depth within 5% of mid
  bidDepth10Pct: z.number().nonnegative(), // Depth within 10% of mid
  askDepth5Pct: z.number().nonnegative(),
  askDepth10Pct: z.number().nonnegative(),

  // Top-of-book depth
  bidDepthTop5: z.number().nonnegative(), // Sum of top 5 levels
  askDepthTop5: z.number().nonnegative(),

  // Imbalance metrics
  imbalance: z.number().min(-1).max(1), // (bidDepth - askDepth) / (bidDepth + askDepth)
  imbalanceTop5: z.number().min(-1).max(1),

  // Thin side detection
  thinSide: z.enum(['bid', 'ask', 'balanced']),
  thinSideDepth: z.number().nonnegative(),
  thickSideDepth: z.number().nonnegative(),
  thinSideRatio: z.number().min(0).max(1), // thinSide / thickSide

  // Spread metrics
  spreadBps: z.number().nonnegative(),
  spreadPct: z.number().nonnegative(),

  // Liquidity adequacy
  totalDepth: z.number().nonnegative(),
  depthAdequate: z.boolean(), // Has sufficient depth for typical trade sizes
});

export type OrderbookMetrics = z.infer<typeof OrderbookMetricsSchema>;

/**
 * Raw CLOB order book response
 */
export const ClobOrderbookResponseSchema = z.object({
  market: z.string().optional(),
  asset_id: z.string(),
  hash: z.string().optional(),
  timestamp: z.string().optional(),
  bids: z.array(z.object({
    price: z.string(),
    size: z.string(),
  })),
  asks: z.array(z.object({
    price: z.string(),
    size: z.string(),
  })),
});

export type ClobOrderbookResponse = z.infer<typeof ClobOrderbookResponseSchema>;

/**
 * Transform CLOB API response to canonical OrderbookSnapshot
 */
export function transformClobOrderbook(raw: ClobOrderbookResponse): OrderbookSnapshot {
  const bids: PriceLevel[] = raw.bids
    .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .filter(b => b.size > 0)
    .sort((a, b) => b.price - a.price); // Highest bid first

  const asks: PriceLevel[] = raw.asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.size > 0)
    .sort((a, b) => a.price - b.price); // Lowest ask first

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  let midPrice: number | null = null;
  let spread: number | null = null;
  let spreadBps: number | null = null;

  if (bestBid !== null && bestAsk !== null) {
    midPrice = (bestBid + bestAsk) / 2;
    spread = bestAsk - bestBid;
    spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : null;
  }

  return {
    tokenId: raw.asset_id,
    timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    spreadBps,
    hash: raw.hash,
  };
}

/**
 * Compute order book metrics from snapshot
 */
export function computeOrderbookMetrics(snapshot: OrderbookSnapshot): OrderbookMetrics {
  const { tokenId, timestamp, bids, asks, midPrice } = snapshot;

  // Compute depth at various levels
  const computeDepthWithinPct = (levels: PriceLevel[], midPrice: number | null, pct: number, isBid: boolean): number => {
    if (midPrice === null || midPrice === 0) return 0;
    const threshold = isBid ? midPrice * (1 - pct) : midPrice * (1 + pct);
    return levels
      .filter(l => isBid ? l.price >= threshold : l.price <= threshold)
      .reduce((sum, l) => sum + l.size, 0);
  };

  const bidDepth5Pct = computeDepthWithinPct(bids, midPrice, 0.05, true);
  const bidDepth10Pct = computeDepthWithinPct(bids, midPrice, 0.10, true);
  const askDepth5Pct = computeDepthWithinPct(asks, midPrice, 0.05, false);
  const askDepth10Pct = computeDepthWithinPct(asks, midPrice, 0.10, false);

  // Top 5 levels depth
  const bidDepthTop5 = bids.slice(0, 5).reduce((sum, l) => sum + l.size, 0);
  const askDepthTop5 = asks.slice(0, 5).reduce((sum, l) => sum + l.size, 0);

  // Imbalance calculations
  const totalDepth10Pct = bidDepth10Pct + askDepth10Pct;
  const imbalance = totalDepth10Pct > 0
    ? (bidDepth10Pct - askDepth10Pct) / totalDepth10Pct
    : 0;

  const totalDepthTop5 = bidDepthTop5 + askDepthTop5;
  const imbalanceTop5 = totalDepthTop5 > 0
    ? (bidDepthTop5 - askDepthTop5) / totalDepthTop5
    : 0;

  // Thin side detection
  let thinSide: 'bid' | 'ask' | 'balanced' = 'balanced';
  let thinSideDepth = Math.min(bidDepth10Pct, askDepth10Pct);
  let thickSideDepth = Math.max(bidDepth10Pct, askDepth10Pct);

  if (Math.abs(imbalance) > 0.3) {
    thinSide = imbalance > 0 ? 'ask' : 'bid';
    thinSideDepth = imbalance > 0 ? askDepth10Pct : bidDepth10Pct;
    thickSideDepth = imbalance > 0 ? bidDepth10Pct : askDepth10Pct;
  }

  const thinSideRatio = thickSideDepth > 0 ? thinSideDepth / thickSideDepth : 1;

  // Spread metrics
  const spreadBps = snapshot.spreadBps ?? 0;
  const spreadPct = spreadBps / 10000;

  // Total depth
  const totalDepth = bids.reduce((sum, l) => sum + l.size, 0) +
                     asks.reduce((sum, l) => sum + l.size, 0);

  // Depth adequacy (> $100 on each side within 10%)
  const depthAdequate = bidDepth10Pct >= 100 && askDepth10Pct >= 100;

  return {
    tokenId,
    timestamp,
    bidDepth5Pct,
    bidDepth10Pct,
    askDepth5Pct,
    askDepth10Pct,
    bidDepthTop5,
    askDepthTop5,
    imbalance,
    imbalanceTop5,
    thinSide,
    thinSideDepth,
    thickSideDepth,
    thinSideRatio,
    spreadBps,
    spreadPct,
    totalDepth,
    depthAdequate,
  };
}

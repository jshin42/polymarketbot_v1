import {
  type FeatureVector,
  type AnomalyScore,
  type AnomalyScoreComponents,
  type TriggeringTrade,
  type Trade,
  DEFAULT_ANOMALY_WEIGHTS,
  DOLLAR_FLOOR_DEFAULTS,
  checkTripleSignal,
  computeDollarFloorMultiplier,
  computeRawSizeTailScore,
  RedisKeys,
  type Redis,
} from '@polymarketbot/shared';

// =============================================================================
// Anomaly Score Computation
// =============================================================================
//
// This module implements the anomaly detection scoring system as specified in
// CLAUDE.md Section 3.2. The anomaly score measures the likelihood that a
// trade or market state represents unusual activity worth investigating.
//
// The scoring formula combines:
// 1. Core signals (70% weight): trade size, orderbook asymmetry, wallet newness, impact
// 2. Context signals (30% weight): burst detection, change-point detection
//
// The score is amplified by a time-to-close ramp function that increases
// sensitivity as markets approach their resolution time.
// =============================================================================

/**
 * Computes the anomaly score from a feature vector.
 *
 * This is the primary scoring function that detects potentially anomalous
 * trading activity by combining multiple signal dimensions into a single
 * composite score between 0 and 1.
 *
 * **Formula (from CLAUDE.md Section 3.2):**
 * ```
 * core = 0.35*size_tail + 0.30*(0.6*book_imbalance + 0.4*thin_opposite) +
 *        0.20*wallet_new + 0.15*impact
 * context = max(change_point_score, burst_intensity)
 * anomaly_score = clamp(time_ramp * (0.7*core + 0.3*context), 0, 1)
 * ```
 *
 * **Signal Components:**
 * - `tradeSizeComponent` (35%): Large trades relative to market baseline
 * - `orderbookComponent` (30%): Book imbalance (60%) + thin opposite side (40%)
 * - `walletComponent` (20%): New/low-activity wallet indicators
 * - `impactComponent` (15%): Post-trade mid-price drift confirmation
 * - `contextScore`: Maximum of burst intensity or change-point detection
 *
 * **Triple Signal Detection:**
 * Also checks for the "triple signal" condition (size + book + wallet all high)
 * which indicates high-confidence anomaly per CLAUDE.md Section 3.1.
 *
 * @param features - The computed feature vector for the current market state
 * @returns Complete AnomalyScore object with score, components, and metadata
 *
 * @example
 * ```ts
 * const features = await featureComputer.computeFeatures(tokenId, conditionId, timestamp, trade);
 * const anomalyScore = computeAnomalyScore(features);
 *
 * if (anomalyScore.triggered) {
 *   console.log(`Anomaly detected! Score: ${anomalyScore.score}`);
 * }
 * if (anomalyScore.tripleSignal) {
 *   console.log('Triple signal detected - high confidence!');
 * }
 * ```
 */
export function computeAnomalyScore(features: FeatureVector): AnomalyScore {
  const weights = DEFAULT_ANOMALY_WEIGHTS;

  // Extract component scores
  const tradeSizeComponent = features.tradeSize?.sizeTailScore ?? 0;
  const bookImbalanceComponent = features.orderbook.bookImbalanceScore;
  const thinOppositeComponent = features.orderbook.thinOppositeScore;
  const walletComponent = features.wallet?.walletNewScore ?? 0;
  const impactComponent = features.impact?.impactScore ?? 0;
  const burstComponent = features.burst.burstScore;
  const changePointComponent = features.changePoint.changePointScore;

  // Compute orderbook combined score
  const orderbookComponent = 0.6 * bookImbalanceComponent + 0.4 * thinOppositeComponent;

  // Compute core score
  const coreScore =
    weights.tradeSize * tradeSizeComponent +
    weights.orderbook * orderbookComponent +
    weights.wallet * walletComponent +
    weights.impact * impactComponent;

  // Compute context score
  const contextScore = Math.max(changePointComponent, burstComponent);

  // Combine with 70/30 weighting
  const combinedScore = 0.7 * coreScore + 0.3 * contextScore;

  // Apply time ramp multiplier
  const ramp = features.timeToClose.rampMultiplier;
  const rawScore = ramp * combinedScore;

  // Clamp to [0, 1]
  const score = Math.min(1, Math.max(0, rawScore));

  // Check for triple signal (high-confidence insider proxy)
  const tripleSignal = checkTripleSignal(
    tradeSizeComponent,
    bookImbalanceComponent,
    thinOppositeComponent,
    walletComponent,
    features.wallet?.walletActivityScore ?? 1
  );

  // Build components object
  const components: AnomalyScoreComponents = {
    tradeSizeComponent,
    bookImbalanceComponent,
    thinOppositeComponent,
    orderbookComponent,
    walletComponent,
    impactComponent,
    burstComponent,
    changePointComponent,
  };

  // Calculate confidence based on data availability
  let dataPoints = 0;
  const totalPossible = 5;
  if (features.tradeSize) dataPoints++;
  if (features.wallet) dataPoints++;
  if (features.impact) dataPoints++;
  dataPoints += 2; // orderbook and burst always available
  const confidence = dataPoints / totalPossible;

  // Triggered if score exceeds threshold (0.65 per CLAUDE.md)
  const triggered = score >= 0.65;

  return {
    score,
    components,
    coreScore,
    contextScore,
    confidence,
    triggered,
    tripleSignal,
  };
}

// =============================================================================
// Triggering Trade Identification
// =============================================================================

/**
 * Format wallet age for display.
 * @param days - Wallet age in days (null if unknown)
 * @returns Formatted string like "New (3d)", "Recent (25d)", "Established (180+d)"
 */
function formatWalletAge(days: number | null): string {
  if (days === null) return 'Unknown';
  if (days < 7) return `New (${Math.floor(days)}d)`;
  if (days < 30) return `Recent (${Math.floor(days)}d)`;
  if (days < 180) return `${Math.floor(days)}d`;
  return 'Established (180+d)';
}

/**
 * Build Polygonscan URL for a transaction hash.
 * @param transactionHash - The transaction hash (0x-prefixed hex string)
 * @returns Polygonscan URL or undefined if no hash provided
 */
function buildPolygonscanUrl(transactionHash: string | undefined): string | undefined {
  if (!transactionHash) return undefined;
  return `https://polygonscan.com/tx/${transactionHash}`;
}

/**
 * Identifies the trades that triggered the anomaly detection.
 *
 * Filters trades to those meeting BOTH criteria:
 * 1. Statistical anomaly: percentile >= 95
 * 2. Minimum dollar size: notional >= MIN_ANOMALY_TRADE_USD ($5k)
 *
 * Returns up to 3 triggering trades sorted by significance (highest notional first).
 *
 * @param tokenId - The token to identify triggering trades for
 * @param features - The computed feature vector (used for percentile estimation)
 * @param redis - Redis client for accessing trade history and wallet data
 * @returns Array of up to 3 TriggeringTrade objects, or empty array if none found
 */
export async function identifyTriggeringTrades(
  tokenId: string,
  features: FeatureVector,
  redis: Redis
): Promise<TriggeringTrade[]> {
  const { MIN_ANOMALY_TRADE_USD } = DOLLAR_FLOOR_DEFAULTS;

  // Get recent trades from the 60-minute rolling window
  const tradeWindowKey = RedisKeys.tradeWindow(tokenId, 60);
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000; // Last 60 minutes

  const tradeStrings = await redis.zrangebyscore(tradeWindowKey, cutoff, now);
  if (!tradeStrings || tradeStrings.length === 0) {
    return [];
  }

  // Parse trades and compute notional values
  const trades: Array<Trade & { notional: number }> = tradeStrings.map((str) => {
    const trade = JSON.parse(str) as Trade;
    return {
      ...trade,
      notional: trade.price * trade.size,
    };
  });

  // Get rolling stats for percentile estimation
  // Use the 95th percentile from features as a threshold proxy
  const q95 = features.tradeSize?.rollingQ95 ?? 0;
  const q99 = features.tradeSize?.rollingQ99 ?? 0;

  // Filter to potential triggering trades:
  // 1. Notional >= MIN_ANOMALY_TRADE_USD (hard dollar floor)
  // 2. Notional >= q95 (statistical anomaly proxy)
  const triggeringCandidates = trades.filter((trade) => {
    return trade.notional >= MIN_ANOMALY_TRADE_USD && trade.notional >= q95;
  });

  if (triggeringCandidates.length === 0) {
    return [];
  }

  // Sort by notional (highest first) and take top 3
  triggeringCandidates.sort((a, b) => b.notional - a.notional);
  const topTrades = triggeringCandidates.slice(0, 3);

  // Enrich with wallet data
  const triggeringTrades: TriggeringTrade[] = [];

  for (const trade of topTrades) {
    // Get wallet age from Redis - try first_seen, fallback to wallet profile
    const walletAddress = trade.takerAddress;
    let walletAgeDays: number | null = null;

    // Try the walletFirstSeen key first (from Polygonscan enrichment)
    const firstSeenStr = await redis.get(RedisKeys.walletFirstSeen(walletAddress));
    if (firstSeenStr) {
      const firstSeen = parseInt(firstSeenStr, 10);
      walletAgeDays = (now - firstSeen) / (1000 * 60 * 60 * 24);
    }

    // Fallback to wallet profile (from Polymarket scraping)
    if (walletAgeDays === null) {
      const profileStr = await redis.get(RedisKeys.walletProfile(walletAddress.toLowerCase()));
      if (profileStr) {
        try {
          const profile = JSON.parse(profileStr);
          if (profile.joinedTimestamp) {
            walletAgeDays = (now - profile.joinedTimestamp) / (1000 * 60 * 60 * 24);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Estimate percentile based on position relative to quantiles
    let percentile: number;
    if (q99 > 0 && trade.notional >= q99) {
      percentile = 99 + Math.min(0.9, (trade.notional - q99) / q99);
    } else if (q95 > 0 && trade.notional >= q95) {
      percentile = 95 + ((trade.notional - q95) / (q99 - q95 || 1)) * 4;
    } else {
      percentile = 95; // Minimum to be a triggering trade
    }

    triggeringTrades.push({
      tradeId: trade.tradeId,
      timestamp: trade.timestamp,
      sizeUsd: trade.notional,
      price: trade.price,
      side: trade.side,
      percentile: Math.min(100, percentile),
      walletAddress,
      walletAgeDays,
      walletAgeFormatted: formatWalletAge(walletAgeDays),
      dollarFloorMultiplier: computeDollarFloorMultiplier(trade.notional),
      transactionHash: trade.transactionHash,
      polygonscanUrl: buildPolygonscanUrl(trade.transactionHash),
    });
  }

  return triggeringTrades;
}

/**
 * Get the highest trade in a time window for a token.
 *
 * Unlike identifyTriggeringTrades(), this has NO minimum thresholds ($5k, q95).
 * Always returns the largest trade to show as signal data for ALL ranked markets.
 *
 * This ensures every market displayed in "Top Ranked Opportunities" has
 * TRIGGER $ and WALLET AGE data, not just those meeting high-confidence criteria.
 *
 * @param tokenId - The token to find trades for
 * @param windowMinutes - Time window (60 for 1h)
 * @param features - Feature vector for percentile calculation
 * @param redis - Redis client
 * @param minDisplayUsd - Minimum trade size to display (default 0, pass higher to filter small trades)
 * @returns Highest trade or null if no trades in window or below threshold
 */
export async function getHighestTrade(
  tokenId: string,
  windowMinutes: number,
  features: FeatureVector,
  redis: Redis,
  minDisplayUsd: number = 0
): Promise<TriggeringTrade | null> {
  const tradeWindowKey = RedisKeys.tradeWindow(tokenId, windowMinutes);
  const now = Date.now();
  const cutoff = now - windowMinutes * 60 * 1000;

  const tradeStrings = await redis.zrangebyscore(tradeWindowKey, cutoff, now);
  if (!tradeStrings || tradeStrings.length === 0) {
    return null;
  }

  // Parse trades and compute notional values
  const trades: Array<Trade & { notional: number }> = tradeStrings.map((str) => {
    const trade = JSON.parse(str) as Trade;
    return {
      ...trade,
      notional: trade.price * trade.size,
    };
  });

  // Sort by notional descending, take highest
  trades.sort((a, b) => b.notional - a.notional);
  const highest = trades[0];

  if (!highest || highest.notional === 0) {
    return null;
  }

  // Check minimum display threshold
  if (minDisplayUsd > 0 && highest.notional < minDisplayUsd) {
    return null;
  }

  // Get wallet age from Redis - try first_seen, fallback to wallet profile
  const walletAddress = highest.takerAddress;
  let walletAgeDays: number | null = null;

  // Try the walletFirstSeen key first (from Polygonscan enrichment)
  const firstSeenStr = await redis.get(RedisKeys.walletFirstSeen(walletAddress));
  if (firstSeenStr) {
    const firstSeen = parseInt(firstSeenStr, 10);
    walletAgeDays = (now - firstSeen) / (1000 * 60 * 60 * 24);
  }

  // Fallback to wallet profile (from Polymarket scraping)
  if (walletAgeDays === null) {
    const profileStr = await redis.get(RedisKeys.walletProfile(walletAddress.toLowerCase()));
    if (profileStr) {
      try {
        const profile = JSON.parse(profileStr);
        if (profile.joinedTimestamp) {
          walletAgeDays = (now - profile.joinedTimestamp) / (1000 * 60 * 60 * 24);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Calculate percentile based on rolling stats
  const q95 = features.tradeSize?.rollingQ95 ?? 0;
  const q99 = features.tradeSize?.rollingQ99 ?? 0;
  let percentile: number;

  if (q99 > 0 && highest.notional >= q99) {
    // Above q99: 99-100
    percentile = 99 + Math.min(0.9, (highest.notional - q99) / q99);
  } else if (q95 > 0 && highest.notional >= q95) {
    // Between q95 and q99: 95-99
    percentile = 95 + ((highest.notional - q95) / (q99 - q95 || 1)) * 4;
  } else if (q95 > 0) {
    // Below q95: estimate based on ratio to q95
    percentile = Math.min(95, (highest.notional / q95) * 95);
  } else {
    // No stats available, assume median
    percentile = 50;
  }

  return {
    tradeId: highest.tradeId,
    timestamp: highest.timestamp,
    sizeUsd: highest.notional,
    price: highest.price,
    side: highest.side,
    percentile: Math.min(100, Math.max(0, percentile)),
    walletAddress,
    walletAgeDays,
    walletAgeFormatted: formatWalletAge(walletAgeDays),
    dollarFloorMultiplier: computeDollarFloorMultiplier(highest.notional),
    transactionHash: highest.transactionHash,
    polygonscanUrl: buildPolygonscanUrl(highest.transactionHash),
  };
}

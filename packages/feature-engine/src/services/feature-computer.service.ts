import {
  RedisKeys,
  createLogger,
  Redis,
  type FeatureVector,
  type TimeToCloseFeature,
  type TradeSizeFeature,
  type OrderbookFeature,
  type WalletFeature,
  type ImpactFeature,
  type BurstFeature,
  type ChangePointFeature,
  type Trade,
  type OrderbookSnapshot,
  type OrderbookMetrics,
  type MarketMetadata,
  computeSizeTailScore,
  computeRawSizeTailScore,
  computeDollarFloorMultiplier,
  computeBookImbalanceScore,
  computeThinOppositeScore,
  computeSpreadScore,
  computeDepthScore,
  computeWalletAgeScore,
  computeActivityScore,
  computeWalletRiskScore,
  SCORING_DEFAULTS,
  DEFAULT_TIME_RAMP_PARAMS,
  RISK_DEFAULTS,
} from '@polymarketbot/shared';
import { RollingStateService } from './rolling-state.service.js';
import { computeRobustStats, computeRobustZScore } from '../algorithms/robust-zscore.js';
import { computeChangePointScore } from '../algorithms/focus-cusum.js';

// =============================================================================
// Feature Computer Service
// =============================================================================
//
// This service is the core of the feature engineering pipeline as specified in
// CLAUDE.md Section 2. It transforms raw market data (trades, orderbooks, wallet
// info) into a comprehensive FeatureVector that captures all signals needed for
// anomaly detection.
//
// **Feature Groups (per CLAUDE.md Section 2):**
// 1. Time-to-Close (2.1): Ramp multiplier, categorical time buckets
// 2. Trade Size (2.2): Robust z-scores, tail quantiles, size tail score
// 3. Orderbook (2.3): Depth imbalance, thin opposite side, spread
// 4. Wallet (2.4): Account age, activity level, concentration
// 5. Impact (2.5): Mid-price drift after large trades (confirmation)
// 6. Burst (2.6): Trade clustering via Hawkes process proxy
// 7. Change Point (2.7): FOCuS/CUSUM for regime shift detection
//
// The service maintains rolling state via Redis for efficient streaming updates.
// =============================================================================

const logger = createLogger('feature-computer-service');

/**
 * Service for computing comprehensive feature vectors from raw market data.
 *
 * The FeatureComputerService transforms streaming market data into structured
 * feature vectors that capture all the signals needed for anomaly detection.
 * It implements the feature engineering pipeline described in CLAUDE.md Section 2.
 *
 * **Architecture:**
 * - Stateless computation where possible for horizontal scaling
 * - Rolling state (T-Digest, Hawkes, CUSUM) persisted to Redis
 * - Graceful degradation when optional data is unavailable
 *
 * **Usage:**
 * ```ts
 * const featureComputer = new FeatureComputerService(redis, rollingState);
 *
 * // On trade event
 * const features = await featureComputer.computeFeatures(
 *   tokenId, conditionId, timestamp, trade, orderbookData
 * );
 *
 * // Features ready for scoring
 * const anomalyScore = computeAnomalyScore(features);
 * ```
 */
export class FeatureComputerService {
  constructor(
    private readonly redis: Redis,
    private readonly rollingState: RollingStateService
  ) {}

  async computeFeatures(
    tokenId: string,
    conditionId: string,
    timestamp: number,
    trade?: Trade,
    orderbookData?: { orderbook: OrderbookSnapshot; metrics: OrderbookMetrics }
  ): Promise<FeatureVector> {
    // Get market metadata for time-to-close
    const marketKey = RedisKeys.marketMetadata(conditionId);
    const marketStr = await this.redis.get(marketKey);
    const market = marketStr ? (JSON.parse(marketStr) as MarketMetadata) : null;

    // Compute all feature groups
    const timeToClose = this.computeTimeToCloseFeatures(market, timestamp);
    const tradeSize = trade ? await this.computeTradeSizeFeatures(tokenId, trade) : null;
    const orderbook = orderbookData
      ? this.computeOrderbookFeatures(orderbookData.orderbook, orderbookData.metrics)
      : await this.getLastOrderbookFeatures(tokenId);
    const wallet = trade ? await this.computeWalletFeatures(trade.takerAddress) : null;
    const impact = await this.computeImpactFeatures(tokenId);
    const burst = await this.computeBurstFeatures(tokenId, timestamp);
    const changePoint = await this.computeChangePointFeatures(tokenId);

    const featureVector: FeatureVector = {
      tokenId,
      timestamp,
      timeToClose,
      tradeSize,
      orderbook,
      wallet,
      impact,
      burst,
      changePoint,
    };

    return featureVector;
  }

  // ===========================================================================
  // Time-to-Close Features
  // ===========================================================================

  private computeTimeToCloseFeatures(
    market: MarketMetadata | null,
    timestamp: number
  ): TimeToCloseFeature {
    if (!market) {
      return {
        ttcSeconds: Infinity,
        ttcMinutes: Infinity,
        ttcHours: Infinity,
        rampMultiplier: 1.0,
        inLast5Minutes: false,
        inLast15Minutes: false,
        inLast30Minutes: false,
        inLastHour: false,
        inLast2Hours: false,
        inNoTradeZone: false,
      };
    }

    const endTimeMs = new Date(market.endDateIso).getTime();
    const ttcMs = Math.max(0, endTimeMs - timestamp);
    const ttcSeconds = ttcMs / 1000;
    const ttcMinutes = ttcMs / 60000;
    const ttcHours = ttcMinutes / 60;

    // Ramp function: 1 + alpha * exp(-beta * ttc_hours)
    const { alpha, beta, maxMultiplier } = DEFAULT_TIME_RAMP_PARAMS;
    const noTradeZoneSeconds = RISK_DEFAULTS.NO_TRADE_ZONE_SECONDS;
    const rawRamp = 1 + alpha * Math.exp(-beta * ttcHours);
    const rampMultiplier = Math.min(rawRamp, maxMultiplier);

    // Categorical flags
    const inLast5Minutes = ttcMinutes <= 5;
    const inLast15Minutes = ttcMinutes <= 15;
    const inLast30Minutes = ttcMinutes <= 30;
    const inLastHour = ttcMinutes <= 60;
    const inLast2Hours = ttcMinutes <= 120;
    const inNoTradeZone = ttcSeconds <= noTradeZoneSeconds;

    return {
      ttcSeconds,
      ttcMinutes,
      ttcHours,
      rampMultiplier,
      inLast5Minutes,
      inLast15Minutes,
      inLast30Minutes,
      inLastHour,
      inLast2Hours,
      inNoTradeZone,
    };
  }

  // ===========================================================================
  // Trade Size Features
  // ===========================================================================

  private async computeTradeSizeFeatures(
    tokenId: string,
    trade: Trade
  ): Promise<TradeSizeFeature> {
    const notional = trade.price * trade.size;

    // Get trade history for rolling stats
    const trades = await this.rollingState.getTradeWindow(tokenId, 60);
    const notionals = trades.map((t) => t.price * t.size);

    if (notionals.length < 5) {
      // Insufficient data for robust statistics
      const dollarFloorMultiplier = computeDollarFloorMultiplier(notional);
      return {
        size: trade.size,
        sizeUsd: notional,
        robustZScore: 0,
        percentile: 50,
        rollingMedian: notional,
        rollingMad: 0,
        rollingQ95: notional,
        rollingQ99: notional,
        rollingQ999: notional,
        dollarFloorMultiplier,
        rawSizeTailScore: 0,
        sizeTailScore: 0,
        isLargeTrade: false,
        isTailTrade: false,
        isExtremeTrade: false,
      };
    }

    // Compute robust statistics
    const stats = computeRobustStats(notionals);
    const robustZScore = computeRobustZScore(notional, stats);

    // Get percentile from T-Digest
    const percentile = (await this.rollingState.getTradeSizePercentile(tokenId, notional)) ?? 50;

    // Get rolling quantiles
    const rollingQ95 = (await this.rollingState.getTradeSizeQuantile(tokenId, 95)) ?? notional;
    const rollingQ99 = (await this.rollingState.getTradeSizeQuantile(tokenId, 99)) ?? notional;
    const rollingQ999 = (await this.rollingState.getTradeSizeQuantile(tokenId, 99.9)) ?? notional;

    // Compute size tail score with dollar floor adjustment
    const dollarFloorMultiplier = computeDollarFloorMultiplier(notional);
    const rawSizeTailScore = computeRawSizeTailScore(percentile);
    const sizeTailScore = computeSizeTailScore(percentile, notional);

    // Trade classification flags
    const isLargeTrade = robustZScore > 3 || percentile > 99;
    const isTailTrade = percentile > 95;
    const isExtremeTrade = percentile > 99.9;

    return {
      size: trade.size,
      sizeUsd: notional,
      robustZScore,
      percentile,
      rollingMedian: stats.median,
      rollingMad: stats.mad,
      rollingQ95,
      rollingQ99,
      rollingQ999,
      dollarFloorMultiplier,
      rawSizeTailScore,
      sizeTailScore,
      isLargeTrade,
      isTailTrade,
      isExtremeTrade,
    };
  }

  // ===========================================================================
  // Orderbook Features
  // ===========================================================================

  private computeOrderbookFeatures(
    orderbook: OrderbookSnapshot,
    metrics: OrderbookMetrics
  ): OrderbookFeature {
    const imbalance = metrics.imbalance;
    const bookImbalanceScore = computeBookImbalanceScore(imbalance);

    // Compute thin side ratio
    const bidDepth = metrics.bidDepth5Pct + metrics.bidDepth10Pct;
    const askDepth = metrics.askDepth5Pct + metrics.askDepth10Pct;
    const totalDepth = bidDepth + askDepth;
    const thinSide = bidDepth < askDepth ? 'bid' : askDepth < bidDepth ? 'ask' : 'balanced';
    const thinSideDepthVal = Math.min(bidDepth, askDepth);
    const thickSideDepth = Math.max(bidDepth, askDepth);
    const thinSideRatio = thickSideDepth > 0 ? thinSideDepthVal / thickSideDepth : 1;
    const thinOppositeScore = computeThinOppositeScore(thinSideRatio);

    // Spread score
    const spreadBps = (orderbook.spread ?? 0) * 10000;
    const spreadScore = computeSpreadScore(spreadBps);

    // Depth score
    const depthScore = computeDepthScore(totalDepth);

    // Asymmetric check: imbalance > 0.5 AND thinSideRatio < 0.3
    const isAsymmetric = Math.abs(imbalance) > 0.5 && thinSideRatio < 0.3;

    return {
      bidDepth,
      askDepth,
      totalDepth,
      imbalance,
      imbalanceAbs: Math.abs(imbalance),
      bookImbalanceScore,
      thinSide,
      thinSideRatio,
      thinOppositeScore,
      spreadBps,
      spreadScore,
      depthScore,
      isAsymmetric,
    };
  }

  private async getLastOrderbookFeatures(tokenId: string): Promise<OrderbookFeature> {
    const stateStr = await this.redis.get(RedisKeys.orderbookState(tokenId));

    if (!stateStr) {
      // Return default neutral features
      return {
        bidDepth: 0,
        askDepth: 0,
        totalDepth: 0,
        imbalance: 0,
        imbalanceAbs: 0,
        bookImbalanceScore: 0,
        thinSide: 'balanced',
        thinSideRatio: 1,
        thinOppositeScore: 0,
        spreadBps: 0,
        spreadScore: 1,
        depthScore: 0,
        isAsymmetric: false,
      };
    }

    const { orderbook, metrics } = JSON.parse(stateStr);
    return this.computeOrderbookFeatures(orderbook, metrics);
  }

  // ===========================================================================
  // Wallet Features
  // ===========================================================================

  private async computeWalletFeatures(walletAddress: string): Promise<WalletFeature> {
    const now = Date.now();

    // Try to get enriched wallet data from cache first (set by WalletEnricherService)
    const cacheKey = RedisKeys.walletCache(walletAddress.toLowerCase());
    const cached = await this.redis.hgetall(cacheKey);

    let walletAgeDays: number | null = null;
    let walletAgeMinutes: number | null = null;
    let tradeCount = 0;
    let walletActivityScore = 0.5; // Default neutral

    if (cached && cached.enrichedAt) {
      // Use enriched data from Polygonscan (via WalletEnricherService)
      if (cached.firstSeenTimestamp && cached.firstSeenTimestamp !== '') {
        const firstSeen = parseInt(cached.firstSeenTimestamp, 10);
        walletAgeMinutes = (now - firstSeen) / 60000;
        walletAgeDays = walletAgeMinutes / 1440;
      }

      // Get transaction count for activity scoring
      tradeCount = parseInt(cached.transactionCount || '0', 10);

      // Compute activity score based on real transaction count
      // Lower activity = higher score (more suspicious for anomaly detection)
      walletActivityScore = this.computeActivityScoreFromTxCount(tradeCount);
    } else {
      // Fallback: try legacy walletFirstSeen key
      const firstSeenStr = await this.redis.get(RedisKeys.walletFirstSeen(walletAddress));

      if (firstSeenStr) {
        const firstSeen = parseInt(firstSeenStr, 10);
        walletAgeMinutes = (now - firstSeen) / 60000;
        walletAgeDays = walletAgeMinutes / 1440;
      }

      // No enrichment data - use neutral activity score
      walletActivityScore = 0.5;
    }

    // Compute wallet age score
    const walletNewScore = computeWalletAgeScore(walletAgeDays);
    const isNewAccount = walletAgeDays !== null && walletAgeDays < 7;

    // Low activity if txCount < 50 or unknown
    const isLowActivity = tradeCount < 50 || !cached?.transactionCount;

    const walletConcentrationScore = 0; // Would need position data

    const walletRiskScore = computeWalletRiskScore(
      walletNewScore,
      walletActivityScore,
      walletConcentrationScore
    );

    return {
      walletAddress,
      walletAgeDays,
      walletAgeMinutes,
      tradeCount,
      marketsTraded: 0, // Would need additional enrichment
      totalVolume: 0, // Would need additional enrichment
      walletNewScore,
      walletActivityScore,
      walletConcentrationScore,
      walletRiskScore,
      isNewAccount,
      isLowActivity,
      isHighConcentration: false,
    };
  }

  /**
   * Compute wallet activity score from on-chain transaction count.
   *
   * Lower activity = higher score (more suspicious for anomaly detection).
   * Based on typical Polygon wallet activity patterns.
   *
   * @param txCount - Total transaction count from Polygonscan
   * @returns Activity score between 0 and 1
   */
  private computeActivityScoreFromTxCount(txCount: number): number {
    if (txCount < 10) return 0.9;   // Very low activity = suspicious
    if (txCount < 50) return 0.6;   // Low activity
    if (txCount < 100) return 0.3;  // Moderate activity
    return 0.1;                      // High activity = normal
  }

  // ===========================================================================
  // Impact Features
  // ===========================================================================

  private async computeImpactFeatures(tokenId: string): Promise<ImpactFeature | null> {
    // This would track mid-price drift after large trades
    // For MVP, return null (would need historical mid tracking)
    return null;
  }

  // ===========================================================================
  // Burst Features
  // ===========================================================================

  private async computeBurstFeatures(tokenId: string, timestamp: number): Promise<BurstFeature> {
    const { intensity, isBurst } = await this.rollingState.getHawkesIntensity(tokenId, timestamp);
    const tradeCount1m = await this.rollingState.getTradeCount(tokenId, 1);
    const tradeCount5m = await this.rollingState.getTradeCount(tokenId, 5);

    // Compute burst score based on intensity
    const baselineIntensity = 0.1; // Expected trades per second
    const intensityRatio = intensity / baselineIntensity;
    const burstScore = Math.min(1, Math.max(0, (intensityRatio - 1) / 4));

    // Compute trades per minute
    const tradesPerMinute = tradeCount1m;

    // Get inter-arrival stats from rolling state
    const interArrivalStats = await this.rollingState.getInterArrivalStats(tokenId);

    return {
      tradeCount1m,
      tradeCount5m,
      tradesPerMinute,
      avgInterArrival: interArrivalStats?.avg ?? null,
      minInterArrival: interArrivalStats?.min ?? null,
      hawkesIntensity: intensity,
      baselineIntensity,
      intensityRatio,
      burstScore,
      burstDetected: isBurst,
    };
  }

  // ===========================================================================
  // Change Point Features
  // ===========================================================================

  private async computeChangePointFeatures(tokenId: string): Promise<ChangePointFeature> {
    // Get CUSUM stats for multiple metrics
    const tradeRateCusum = await this.rollingState.getCusumStats(tokenId, 'trade_rate');
    const spreadCusum = await this.rollingState.getCusumStats(tokenId, 'spread');
    const imbalanceCusum = await this.rollingState.getCusumStats(tokenId, 'imbalance');

    // FOCuS threshold for change-point detection
    const threshold = 5.0;

    // Combine into single change point score
    const maxStatistic = Math.max(
      tradeRateCusum.statistic,
      spreadCusum.statistic,
      imbalanceCusum.statistic
    );

    const changePointScore = computeChangePointScore(maxStatistic, threshold);
    const changePointDetected =
      tradeRateCusum.detected || spreadCusum.detected || imbalanceCusum.detected;

    // Determine regime shift direction and magnitude
    let regimeShift: 'none' | 'increase' | 'decrease' = 'none';
    let shiftMagnitude = 0;
    if (changePointDetected) {
      // Use trade rate change to determine direction
      regimeShift = tradeRateCusum.statistic > 0 ? 'increase' : 'decrease';
      shiftMagnitude = Math.abs(tradeRateCusum.statistic);
    }

    return {
      focusStatistic: maxStatistic,
      threshold,
      changePointDetected,
      changePointTimestamp: tradeRateCusum.changePointIndex,
      regimeShift,
      shiftMagnitude,
      changePointScore,
    };
  }
}

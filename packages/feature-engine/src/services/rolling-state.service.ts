import {
  RedisKeys,
  createLogger,
  Redis,
  RedisTTL,
  type Trade,
  type OrderbookSnapshot,
  type OrderbookMetrics,
} from '@polymarketbot/shared';
import { TDigestManager } from '../algorithms/t-digest.js';
import { HawkesProxy, type HawkesState } from '../algorithms/hawkes-proxy.js';
import { FocusCusum, type FocusState } from '../algorithms/focus-cusum.js';

// =============================================================================
// Rolling State Service
// =============================================================================
//
// This service manages the persistent rolling statistical state required for
// feature computation. It provides a unified interface for:
//
// 1. **T-Digest** (CLAUDE.md 2.2): Approximate quantile estimation for trade sizes
//    - Efficiently computes q95/q99/q999 for tail detection
//    - Memory-efficient streaming quantiles
//
// 2. **Hawkes Process** (CLAUDE.md 2.6): Burst detection via self-exciting process
//    - Tracks event intensity with exponential decay
//    - Detects clustering of trades (burst events)
//
// 3. **FOCuS CUSUM** (CLAUDE.md 2.7): Online change-point detection
//    - Monitors trade rate, spread, and imbalance for regime shifts
//    - Triggers when cumulative deviation exceeds threshold
//
// All state is persisted to Redis for durability and horizontal scaling.
// In-memory caches are used for performance within a single process.
// =============================================================================

const logger = createLogger('rolling-state-service');

/**
 * Manages rolling statistical state for each token.
 *
 * The RollingStateService maintains per-token state for streaming algorithms
 * that require historical context. This includes:
 *
 * - **Trade size distribution**: T-Digest for quantile estimation
 * - **Event intensity**: Hawkes process for burst detection
 * - **Change detection**: CUSUM statistics for regime shifts
 *
 * **State Lifecycle:**
 * 1. On first access, state is loaded from Redis (or initialized fresh)
 * 2. Updates are applied in-memory for performance
 * 3. State is periodically persisted back to Redis
 * 4. TTLs ensure stale state is automatically cleaned up
 *
 * **Thread Safety:**
 * Each service instance maintains its own in-memory cache. For multi-process
 * deployments, ensure each token is processed by a consistent worker to
 * avoid state divergence.
 *
 * @example
 * ```ts
 * const rollingState = new RollingStateService(redis);
 *
 * // Record a trade (updates T-Digest, Hawkes, CUSUM)
 * await rollingState.recordTrade(tokenId, trade);
 *
 * // Query state for feature computation
 * const quantiles = await rollingState.getTradeSizeQuantiles(tokenId);
 * const { intensity, isBurst } = await rollingState.getHawkesIntensity(tokenId, now);
 * ```
 */
export class RollingStateService {
  private tDigestManager: TDigestManager;
  private hawkesInstances: Map<string, HawkesProxy> = new Map();
  private cusumInstances: Map<string, FocusCusum> = new Map();

  constructor(private readonly redis: Redis) {
    this.tDigestManager = new TDigestManager(redis);
  }

  // ===========================================================================
  // Trade Processing
  // ===========================================================================

  async recordTrade(tokenId: string, trade: Trade): Promise<void> {
    const notional = trade.price * trade.size;

    // Update T-Digest with trade size
    await this.tDigestManager.push(tokenId, notional);
    await this.tDigestManager.persist(tokenId);

    // Update Hawkes process
    const hawkes = await this.getOrCreateHawkes(tokenId);
    hawkes.recordEvent(trade.timestamp);
    await this.persistHawkesState(tokenId, hawkes);

    // Update CUSUM for trade rate change detection
    const cusum = await this.getOrCreateCusum(tokenId, 'trade_rate');
    cusum.update(1); // Record trade event
    await this.persistCusumState(tokenId, 'trade_rate', cusum);
  }

  async recordOrderbook(
    tokenId: string,
    orderbook: OrderbookSnapshot,
    metrics: OrderbookMetrics
  ): Promise<void> {
    // Update CUSUM for spread changes
    if (orderbook.spread !== null) {
      const spreadCusum = await this.getOrCreateCusum(tokenId, 'spread');
      spreadCusum.update(orderbook.spread);
      await this.persistCusumState(tokenId, 'spread', spreadCusum);
    }

    // Update CUSUM for imbalance changes
    const imbalanceCusum = await this.getOrCreateCusum(tokenId, 'imbalance');
    imbalanceCusum.update(metrics.imbalance);
    await this.persistCusumState(tokenId, 'imbalance', imbalanceCusum);
  }

  // ===========================================================================
  // State Retrieval
  // ===========================================================================

  async getTradeSizeQuantiles(tokenId: string): Promise<{
    p50: number | null;
    p95: number | null;
    p99: number | null;
    p999: number | null;
  }> {
    return {
      p50: await this.tDigestManager.percentile(tokenId, 50),
      p95: await this.tDigestManager.percentile(tokenId, 95),
      p99: await this.tDigestManager.percentile(tokenId, 99),
      p999: await this.tDigestManager.percentile(tokenId, 99.9),
    };
  }

  async getTradeSizePercentile(tokenId: string, value: number): Promise<number | null> {
    return this.tDigestManager.percentileRank(tokenId, value);
  }

  async getTradeSizeQuantile(tokenId: string, percentile: number): Promise<number | null> {
    return this.tDigestManager.percentile(tokenId, percentile);
  }

  async getHawkesIntensity(tokenId: string, currentTime: number): Promise<{
    intensity: number;
    isBurst: boolean;
  }> {
    const hawkes = await this.getOrCreateHawkes(tokenId);
    const intensity = hawkes.getCurrentIntensity(currentTime);
    const isBurst = hawkes.isBurst(currentTime, 2.0);

    return { intensity, isBurst };
  }

  async getCusumStats(tokenId: string, metric: string): Promise<{
    detected: boolean;
    statistic: number;
    changePointIndex: number | null;
  }> {
    const cusum = await this.getOrCreateCusum(tokenId, metric);
    const state = cusum.getState();

    return {
      detected: state.changePointIndex !== null,
      statistic: state.maxStatistic,
      changePointIndex: state.changePointIndex,
    };
  }

  async getTradeWindow(tokenId: string, windowMinutes: number): Promise<Trade[]> {
    const key = RedisKeys.tradeWindow(tokenId, windowMinutes);
    const now = Date.now();
    const cutoff = now - windowMinutes * 60 * 1000;

    const members = await this.redis.zrangebyscore(key, cutoff, now);
    return members.map((m) => JSON.parse(m) as Trade);
  }

  async getTradeCount(tokenId: string, windowMinutes: number): Promise<number> {
    const key = RedisKeys.tradeWindow(tokenId, windowMinutes);
    const now = Date.now();
    const cutoff = now - windowMinutes * 60 * 1000;

    return this.redis.zcount(key, cutoff, now);
  }

  async getInterArrivalStats(tokenId: string): Promise<{ avg: number; min: number } | null> {
    // Get recent trades to compute inter-arrival times
    const trades = await this.getTradeWindow(tokenId, 5); // Last 5 minutes

    if (trades.length < 2) {
      return null;
    }

    // Sort by timestamp
    const sorted = trades.sort((a, b) => a.timestamp - b.timestamp);

    // Compute inter-arrival times (in milliseconds)
    const interArrivals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      interArrivals.push(sorted[i].timestamp - sorted[i - 1].timestamp);
    }

    if (interArrivals.length === 0) {
      return null;
    }

    const avg = interArrivals.reduce((sum, val) => sum + val, 0) / interArrivals.length;
    const min = Math.min(...interArrivals);

    return { avg, min };
  }

  // ===========================================================================
  // Hawkes State Management
  // ===========================================================================

  private async getOrCreateHawkes(tokenId: string): Promise<HawkesProxy> {
    let hawkes = this.hawkesInstances.get(tokenId);
    if (hawkes) return hawkes;

    // Try to load from Redis
    const key = RedisKeys.hawkesState(tokenId);
    const stateStr = await this.redis.get(key);

    if (stateStr) {
      const state = JSON.parse(stateStr) as HawkesState;
      hawkes = HawkesProxy.fromState(state);
    } else {
      hawkes = new HawkesProxy(0.1, 0.5, 0.1); // Default params
    }

    this.hawkesInstances.set(tokenId, hawkes);
    return hawkes;
  }

  private async persistHawkesState(tokenId: string, hawkes: HawkesProxy): Promise<void> {
    const key = RedisKeys.hawkesState(tokenId);
    const state = hawkes.getState();
    await this.redis.set(key, JSON.stringify(state), 'EX', RedisTTL.hawkesState);
  }

  // ===========================================================================
  // CUSUM State Management
  // ===========================================================================

  private async getOrCreateCusum(tokenId: string, metric: string): Promise<FocusCusum> {
    const instanceKey = `${tokenId}:${metric}`;
    let cusum = this.cusumInstances.get(instanceKey);
    if (cusum) return cusum;

    // Try to load from Redis
    const key = RedisKeys.cpdState(tokenId, metric);
    const stateStr = await this.redis.get(key);

    if (stateStr) {
      const state = JSON.parse(stateStr) as FocusState;
      cusum = FocusCusum.fromState(state);
    } else {
      cusum = new FocusCusum(5.0); // Default threshold
    }

    this.cusumInstances.set(instanceKey, cusum);
    return cusum;
  }

  private async persistCusumState(tokenId: string, metric: string, cusum: FocusCusum): Promise<void> {
    const key = RedisKeys.cpdState(tokenId, metric);
    const state = cusum.getState();
    await this.redis.set(key, JSON.stringify(state), 'EX', RedisTTL.cpdState);
  }
}

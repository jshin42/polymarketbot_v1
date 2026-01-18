import TDigest from 'tdigest';
import { RedisKeys, RedisTTL, Redis } from '@polymarketbot/shared';

// =============================================================================
// T-Digest Manager for Streaming Quantile Estimation
// =============================================================================

/**
 * T-Digest state for serialization
 */
interface TDigestState {
  centroids: Array<{ mean: number; n: number }>;
  compression: number;
}

/**
 * Manage T-Digest instances for multiple tokens with Redis persistence
 */
export class TDigestManager {
  private digests: Map<string, TDigest.TDigest> = new Map();
  private readonly compression: number;

  constructor(
    private readonly redis: Redis,
    compression: number = 100
  ) {
    this.compression = compression;
  }

  /**
   * Get or create a T-Digest for a token
   */
  async getOrCreate(tokenId: string): Promise<TDigest.TDigest> {
    // Check in-memory cache first
    if (this.digests.has(tokenId)) {
      return this.digests.get(tokenId)!;
    }

    // Try to load from Redis
    const key = RedisKeys.tradeSizeDigest(tokenId);
    const serialized = await this.redis.get(key);

    let digest: TDigest.TDigest;

    if (serialized) {
      // Deserialize from Redis
      try {
        const state: TDigestState = JSON.parse(serialized);
        digest = new TDigest.TDigest();

        // Restore centroids
        for (const centroid of state.centroids) {
          digest.push(centroid.mean, centroid.n);
        }
      } catch (error) {
        // Corrupted data, create fresh
        digest = new TDigest.TDigest(this.compression);
      }
    } else {
      // Create fresh
      digest = new TDigest.TDigest(this.compression);
    }

    this.digests.set(tokenId, digest);
    return digest;
  }

  /**
   * Push a value into the T-Digest
   */
  async push(tokenId: string, value: number): Promise<void> {
    const digest = await this.getOrCreate(tokenId);
    digest.push(value);
  }

  /**
   * Get percentile from T-Digest
   * @param p Percentile (0-100)
   */
  async percentile(tokenId: string, p: number): Promise<number | null> {
    const digest = await this.getOrCreate(tokenId);

    if (digest.size() === 0) {
      return null;
    }

    return digest.percentile(p / 100);
  }

  /**
   * Get percentile rank of a value
   * @returns Percentile rank (0-100)
   */
  async percentileRank(tokenId: string, value: number): Promise<number | null> {
    const digest = await this.getOrCreate(tokenId);

    if (digest.size() === 0) {
      return null;
    }

    // p_rank returns a single number when given a single value
    const rank = digest.p_rank(value) as number;
    return rank * 100;
  }

  /**
   * Get multiple percentiles at once
   */
  async percentiles(tokenId: string, ps: number[]): Promise<Array<number | null>> {
    const digest = await this.getOrCreate(tokenId);

    if (digest.size() === 0) {
      return ps.map(() => null);
    }

    return ps.map(p => digest.percentile(p / 100));
  }

  /**
   * Get digest size (number of values)
   */
  async size(tokenId: string): Promise<number> {
    const digest = await this.getOrCreate(tokenId);
    return digest.size();
  }

  /**
   * Persist T-Digest to Redis
   */
  async persist(tokenId: string): Promise<void> {
    const digest = this.digests.get(tokenId);

    if (!digest) {
      return;
    }

    const key = RedisKeys.tradeSizeDigest(tokenId);
    const centroids = digest.toArray().map(c => ({ mean: c.mean, n: c.n }));

    const state: TDigestState = {
      centroids,
      compression: this.compression,
    };

    await this.redis.setex(
      key,
      RedisTTL.digest,
      JSON.stringify(state)
    );
  }

  /**
   * Persist all loaded digests
   */
  async persistAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const tokenId of this.digests.keys()) {
      promises.push(this.persist(tokenId));
    }

    await Promise.all(promises);
  }

  /**
   * Clear in-memory cache for a token
   */
  clear(tokenId: string): void {
    this.digests.delete(tokenId);
  }

  /**
   * Clear all in-memory caches
   */
  clearAll(): void {
    this.digests.clear();
  }
}

/**
 * Compute quantiles from an array of values (for testing or small datasets)
 */
export function computeQuantiles(
  values: number[],
  quantiles: number[]
): number[] {
  if (values.length === 0) {
    return quantiles.map(() => 0);
  }

  const sorted = [...values].sort((a, b) => a - b);

  return quantiles.map(q => {
    const position = (sorted.length - 1) * (q / 100);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;

    if (lower === upper) {
      return sorted[lower]!;
    }

    return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
  });
}

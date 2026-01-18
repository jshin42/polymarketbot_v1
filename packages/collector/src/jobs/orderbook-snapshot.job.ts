import { Queue } from 'bullmq';
import {
  RedisKeys,
  RedisTTL,
  transformClobOrderbook,
  computeOrderbookMetrics,
  createLogger,
  Redis,
} from '@polymarketbot/shared';
import { ClobRestClient } from '../clients/clob-rest.client.js';
import type { OrderbookSnapshotJobData } from '../workers/collector.worker.js';

// =============================================================================
// Orderbook Snapshot Job
// =============================================================================

const logger = createLogger('orderbook-snapshot-job');

export interface OrderbookSnapshotJobDeps {
  redis: Redis;
  clobClient: ClobRestClient;
  featuresQueue: Queue;
}

export interface OrderbookSnapshotJobResult {
  tokenId: string;
  timestamp: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  bidDepth: number;
  askDepth: number;
}

/**
 * Fetches order book snapshot from CLOB API and emits to feature queue.
 */
export async function processOrderbookSnapshotJob(
  data: OrderbookSnapshotJobData,
  deps: OrderbookSnapshotJobDeps
): Promise<OrderbookSnapshotJobResult> {
  const { tokenId, conditionId } = data;
  const { redis, clobClient, featuresQueue } = deps;
  const timestamp = Date.now();

  // Fetch orderbook from CLOB
  const rawOrderbook = await clobClient.getOrderbook(tokenId);

  // Transform to canonical schema
  const orderbook = transformClobOrderbook(rawOrderbook);

  // Compute metrics
  const metrics = computeOrderbookMetrics(orderbook);

  // Update staleness tracking
  await redis.set(
    RedisKeys.lastUpdate('orderbook', tokenId),
    timestamp.toString(),
    'EX',
    60 // 60 second TTL
  );

  // Cache current orderbook state
  await redis.set(
    RedisKeys.orderbookState(tokenId),
    JSON.stringify({ orderbook, metrics }),
    'EX',
    RedisTTL.featureCache
  );

  // Store in rolling window for historical analysis
  const windowKey = RedisKeys.bookWindow(tokenId, 60); // 60 minute window
  await redis.zadd(windowKey, timestamp, JSON.stringify({ orderbook, metrics }));
  await redis.expire(windowKey, 3600); // 1 hour expiry

  // Trim old entries from window (keep last hour)
  const cutoff = timestamp - 60 * 60 * 1000;
  await redis.zremrangebyscore(windowKey, '-inf', cutoff);

  // Emit to feature queue for processing
  await featuresQueue.add(
    `features-book-${tokenId}`,
    {
      type: 'orderbook',
      tokenId,
      conditionId,
      timestamp,
      data: { orderbook, metrics },
    },
    {
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  const result: OrderbookSnapshotJobResult = {
    tokenId,
    timestamp,
    bestBid: orderbook.bestBid,
    bestAsk: orderbook.bestAsk,
    spread: orderbook.spread,
    bidDepth: metrics.bidDepth5Pct + metrics.bidDepth10Pct,
    askDepth: metrics.askDepth5Pct + metrics.askDepth10Pct,
  };

  logger.debug(result, 'Orderbook snapshot processed');

  return result;
}

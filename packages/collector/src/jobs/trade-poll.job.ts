import { Queue } from 'bullmq';
import { RedisKeys, transformDataApiTrade, createLogger, Redis } from '@polymarketbot/shared';
import { DataApiClient } from '../clients/data-api.client.js';
import { WalletEnricherService } from '../services/wallet-enricher.service.js';
import type { TradePollJobData } from '../workers/collector.worker.js';

// =============================================================================
// Trade Poll Job
// =============================================================================

const logger = createLogger('trade-poll-job');

export interface TradePollJobDeps {
  redis: Redis;
  dataApiClient: DataApiClient;
  walletEnricherService: WalletEnricherService;
  featuresQueue: Queue;
}

export interface TradePollJobResult {
  tokenId: string;
  timestamp: number;
  tradesFound: number;
  newTrades: number;
  latestTradeTimestamp: number | null;
}

/**
 * Fetches recent trades from Data API and emits new trades to feature queue.
 * Uses the public Data API endpoint (no authentication required).
 */
export async function processTradePollJob(
  data: TradePollJobData,
  deps: TradePollJobDeps
): Promise<TradePollJobResult> {
  const { tokenId, conditionId, since } = data;
  const { redis, dataApiClient, walletEnricherService, featuresQueue } = deps;
  const timestamp = Date.now();

  // Fetch recent trades from Data API (NO AUTH REQUIRED)
  const rawTrades = await dataApiClient.getTokenTrades(conditionId, tokenId, {
    limit: 100,
    sortDirection: 'DESC',
  });

  // Update staleness tracking
  await redis.set(
    RedisKeys.lastUpdate('trade', tokenId),
    timestamp.toString(),
    'EX',
    60
  );

  if (rawTrades.length === 0) {
    return {
      tokenId,
      timestamp,
      tradesFound: 0,
      newTrades: 0,
      latestTradeTimestamp: since ?? null,
    };
  }

  // Transform to canonical format
  const trades = rawTrades.map((t) => transformDataApiTrade(t));

  // Filter for trades after 'since' timestamp
  const sinceMs = since ?? 0;
  const newTrades = trades.filter((t) => t.timestamp > sinceMs);

  if (newTrades.length === 0) {
    return {
      tokenId,
      timestamp,
      tradesFound: trades.length,
      newTrades: 0,
      latestTradeTimestamp: Math.max(...trades.map((t) => t.timestamp)),
    };
  }

  // Process each new trade
  const windowKey = RedisKeys.tradeWindow(tokenId, 60); // 60 minute window
  const walletWindowKey = RedisKeys.tokenWallets(tokenId, 60);

  for (const trade of newTrades) {
    // Add to rolling trade window
    await redis.zadd(windowKey, trade.timestamp, JSON.stringify(trade));

    // Track wallets seen (Data API only provides taker/proxy wallet)
    await redis.sadd(walletWindowKey, trade.takerAddress);
    await redis.expire(walletWindowKey, 3600);

    // Enrich wallet with real Polygonscan data (BLOCKING for new wallets)
    // This fetches the actual first-seen timestamp from on-chain data
    // instead of using the trade timestamp as a placeholder.
    // Must be blocking so wallet data is available before feature/scoring computation.
    const takerFirstSeenKey = RedisKeys.walletFirstSeen(trade.takerAddress);
    const existingFirstSeen = await redis.get(takerFirstSeenKey);
    if (!existingFirstSeen) {
      // BLOCKING: Wait for enrichment before emitting to features queue
      // This ensures wallet age data is available for scoring
      try {
        await walletEnricherService.enrichWallet(trade.takerAddress);
        logger.debug({ wallet: trade.takerAddress }, 'Wallet enriched before scoring');
      } catch (error) {
        logger.warn({ error, wallet: trade.takerAddress }, 'Wallet enrichment failed, continuing');
      }
    }

    // Emit to feature queue
    await featuresQueue.add(
      `features-trade-${tokenId}-${trade.tradeId}`,
      {
        type: 'trade',
        tokenId,
        conditionId,
        timestamp: trade.timestamp,
        data: { trade },
      },
      {
        removeOnComplete: 100,
        removeOnFail: 50,
      }
    );
  }

  // Set expiry on trade window
  await redis.expire(windowKey, 3600);

  // Trim old entries from window
  const cutoff = timestamp - 60 * 60 * 1000;
  await redis.zremrangebyscore(windowKey, '-inf', cutoff);

  // Update last trade timestamp
  const latestTradeTimestamp = Math.max(...newTrades.map((t) => t.timestamp));
  await redis.set(
    RedisKeys.lastUpdate('trade', tokenId),
    latestTradeTimestamp.toString(),
    'EX',
    60
  );

  const result: TradePollJobResult = {
    tokenId,
    timestamp,
    tradesFound: trades.length,
    newTrades: newTrades.length,
    latestTradeTimestamp,
  };

  logger.debug(result, 'Trade poll processed');

  return result;
}

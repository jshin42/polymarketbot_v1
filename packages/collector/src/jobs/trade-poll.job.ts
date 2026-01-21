import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { RedisKeys, transformDataApiTrade, createLogger, Redis, Trade } from '@polymarketbot/shared';
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
  pgPool: Pool | null;
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
  const { redis, dataApiClient, walletEnricherService, featuresQueue, pgPool } = deps;
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

  // Persist trades to PostgreSQL for historical queries
  if (pgPool && newTrades.length > 0) {
    const persistedCount = await persistTradesToPostgres(newTrades, pgPool);
    if (persistedCount > 0) {
      logger.debug({ persistedCount, total: newTrades.length }, 'Trades persisted to PostgreSQL');
    }
  }

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

// =============================================================================
// PostgreSQL Persistence
// =============================================================================

/**
 * Batch insert trades into PostgreSQL.
 * Uses ON CONFLICT DO NOTHING to handle duplicates (trade_id + time is unique).
 */
async function persistTradesToPostgres(trades: Trade[], pgPool: Pool): Promise<number> {
  if (trades.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const trade of trades) {
    placeholders.push(
      `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
    );
    values.push(
      new Date(trade.timestamp),    // time
      trade.tradeId,                // trade_id
      trade.tokenId,                // token_id
      trade.makerAddress,           // maker_address
      trade.takerAddress,           // taker_address
      trade.side,                   // side
      trade.price,                  // price
      trade.size,                   // size
      trade.feeRateBps ?? null      // fee_rate_bps
    );
  }

  const query = `
    INSERT INTO trades (time, trade_id, token_id, maker_address, taker_address, side, price, size, fee_rate_bps)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (trade_id, time) DO NOTHING
  `;

  try {
    const result = await pgPool.query(query, values);
    return result.rowCount ?? 0;
  } catch (error) {
    logger.error({ error, tradeCount: trades.length }, 'Failed to persist trades to PostgreSQL');
    return 0;
  }
}

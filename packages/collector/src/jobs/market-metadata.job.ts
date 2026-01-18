import { RedisKeys, RedisTTL, transformGammaMarket, shouldFilterMarket, createLogger, Redis, MARKET_FILTERING } from '@polymarketbot/shared';
import { GammaClient } from '../clients/gamma.client.js';
import type { MarketMetadataJobData } from '../workers/collector.worker.js';

// =============================================================================
// Market Metadata Job
// =============================================================================

const logger = createLogger('market-metadata-job');

export interface MarketMetadataJobDeps {
  redis: Redis;
  gammaClient: GammaClient;
}

export interface MarketMetadataJobResult {
  marketsFound: number;
  marketsFiltered: number;
  tokensTracked: number;
  newTokens: string[];
  filterReasons?: Record<string, number>;
}

/**
 * Discovers markets closing soon and adds their tokens to the tracking set.
 */
export async function processMarketMetadataJob(
  data: MarketMetadataJobData,
  deps: MarketMetadataJobDeps
): Promise<MarketMetadataJobResult> {
  const { withinHours } = data;
  const { redis, gammaClient } = deps;

  logger.info({ withinHours }, 'Fetching markets closing soon');

  // Fetch markets from Gamma API
  const rawMarkets = await gammaClient.getMarketsClosingSoon(withinHours);

  logger.info({ count: rawMarkets.length }, 'Markets fetched from Gamma');

  const newTokens: string[] = [];
  const trackedTokensKey = RedisKeys.trackedTokens();

  // Get currently tracked tokens for comparison
  const existingTokens = new Set(
    (await redis.smembers(trackedTokensKey)).map((t) => JSON.parse(t).tokenId)
  );

  // Track filtering stats
  let filteredCount = 0;
  const filterReasons: Record<string, number> = {};

  // Process each market
  for (const rawMarket of rawMarkets) {
    try {
      const market = transformGammaMarket(rawMarket);

      // Skip if market is closed or resolved
      if (market.closed || market.resolved) {
        continue;
      }

      // Apply market filtering
      const filterResult = shouldFilterMarket(market);
      if (filterResult.filtered) {
        filteredCount++;
        const reasonKey = filterResult.reason?.split(':')[0] ?? 'Unknown';
        filterReasons[reasonKey] = (filterReasons[reasonKey] ?? 0) + 1;

        if (MARKET_FILTERING.LOG_FILTERED_MARKETS) {
          logger.debug(
            {
              conditionId: market.conditionId,
              question: market.question.substring(0, 60),
              category: market.category,
              tags: market.tags.slice(0, 3),
              volume: market.volume,
              liquidity: market.liquidity,
              reason: filterResult.reason,
            },
            'Market filtered out'
          );
        }
        continue;
      }

      // Cache market metadata
      const marketKey = RedisKeys.marketMetadata(market.conditionId);
      await redis.set(
        marketKey,
        JSON.stringify(market),
        'EX',
        RedisTTL.marketMetadata
      );

      // Add each outcome's token to tracking
      for (const outcome of market.outcomes) {
        const tokenData = JSON.stringify({
          tokenId: outcome.tokenId,
          conditionId: market.conditionId,
          outcome: outcome.name,
          endTime: market.endDateIso,
        });

        // Add to tracked tokens set
        const added = await redis.sadd(trackedTokensKey, tokenData);

        // Always refresh the token-to-condition mapping (it may have expired)
        await redis.set(
          RedisKeys.tokenToCondition(outcome.tokenId),
          market.conditionId,
          'EX',
          86400 // 24 hours
        );

        if (added > 0 || !existingTokens.has(outcome.tokenId)) {
          newTokens.push(outcome.tokenId);

          logger.debug(
            {
              tokenId: outcome.tokenId,
              conditionId: market.conditionId,
              outcome: outcome.name,
              endTime: market.endDateIso,
            },
            'Token added to tracking'
          );
        }
      }
    } catch (error) {
      logger.warn({ error, market: rawMarket.condition_id }, 'Failed to process market');
    }
  }

  // Clean up expired tokens (markets that have closed)
  await cleanupExpiredTokens(redis);

  const result: MarketMetadataJobResult = {
    marketsFound: rawMarkets.length,
    marketsFiltered: filteredCount,
    tokensTracked: (await redis.scard(trackedTokensKey)),
    newTokens,
    filterReasons: Object.keys(filterReasons).length > 0 ? filterReasons : undefined,
  };

  logger.info(
    {
      marketsFound: result.marketsFound,
      marketsFiltered: result.marketsFiltered,
      marketsTracked: result.marketsFound - result.marketsFiltered,
      tokensTracked: result.tokensTracked,
      newTokens: result.newTokens.length,
      filterReasons: result.filterReasons,
    },
    'Market metadata job completed'
  );

  return result;
}

/**
 * Remove tokens for markets that have closed
 */
async function cleanupExpiredTokens(redis: Redis): Promise<void> {
  const trackedTokensKey = RedisKeys.trackedTokens();
  const tokens = await redis.smembers(trackedTokensKey);
  const now = Date.now();
  let removed = 0;

  for (const tokenData of tokens) {
    try {
      const { tokenId, endTime } = JSON.parse(tokenData);
      const endTimeMs = new Date(endTime).getTime();

      // Remove if market ended more than 5 minutes ago
      if (endTimeMs < now - 5 * 60 * 1000) {
        await redis.srem(trackedTokensKey, tokenData);
        await redis.del(RedisKeys.tokenToCondition(tokenId));

        // Clean up associated state
        await redis.del(RedisKeys.orderbookState(tokenId));
        await redis.del(RedisKeys.featureCache(tokenId));
        await redis.del(RedisKeys.scoreCache(tokenId));

        removed++;
      }
    } catch (error) {
      logger.warn({ error, tokenData }, 'Failed to parse token data during cleanup');
    }
  }

  if (removed > 0) {
    logger.info({ removed }, 'Cleaned up expired tokens');
  }
}

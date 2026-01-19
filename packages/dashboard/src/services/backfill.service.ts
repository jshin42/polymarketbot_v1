import { Pool } from 'pg';
import { createLogger } from '@polymarketbot/shared';
import { robustZScore, percentileRank } from './statistics.service.js';

// =============================================================================
// Backfill Service - Historical Data Fetching for Research Analysis
// =============================================================================

const logger = createLogger('backfill-service');

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';

// Rate limiting: 100ms between API calls
const API_DELAY_MS = 100;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface BackfillConfig {
  days: number;
  windowMinutes: number;
  minSizeUsd: number;
}

export interface BackfillStatus {
  jobId: number | null;
  status: 'idle' | 'running' | 'completed' | 'failed';
  jobType: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  itemsProcessed: number;
  itemsTotal: number | null;
  errorMessage: string | null;
  progress: number;
}

export interface BackfillResult {
  marketsFound: number;
  marketsProcessed: number;
  tradesProcessed: number;
  eventsCreated: number;
  errors: string[];
}

interface GammaMarket {
  conditionId: string;
  question: string;
  endDate: string;
  closed: boolean;
  active: boolean;
  volume: string;
  liquidity: string;
  outcomePrices: string;
  outcomes: string;
  clobTokenIds: string;
  slug?: string;
  events?: Array<{ slug?: string; title?: string }>;
}

interface DataApiTrade {
  id?: string;
  transactionHash?: string;
  timestamp: number;
  conditionId: string;
  outcomeIndex: number;
  outcome?: string;
  proxyWallet: string;
  maker?: string;
  side: string;
  price: number;
  size: number;
  assetId?: string;
}

// -----------------------------------------------------------------------------
// Backfill Service Class
// -----------------------------------------------------------------------------

export class BackfillService {
  private readonly pg: Pool;
  private currentJobId: number | null = null;

  constructor(pg: Pool) {
    this.pg = pg;
  }

  /**
   * Get current backfill status
   */
  async getStatus(): Promise<BackfillStatus> {
    try {
      const result = await this.pg.query(`
        SELECT id, job_type, status, started_at, completed_at,
               items_processed, items_total, error_message
        FROM backfill_jobs
        ORDER BY id DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return {
          jobId: null,
          status: 'idle',
          jobType: null,
          startedAt: null,
          completedAt: null,
          itemsProcessed: 0,
          itemsTotal: null,
          errorMessage: null,
          progress: 0,
        };
      }

      const row = result.rows[0];
      const progress = row.items_total > 0
        ? Math.round((row.items_processed / row.items_total) * 100)
        : 0;

      return {
        jobId: row.id,
        status: row.status,
        jobType: row.job_type,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        itemsProcessed: row.items_processed,
        itemsTotal: row.items_total,
        errorMessage: row.error_message,
        progress,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get backfill status');
      return {
        jobId: null,
        status: 'idle',
        jobType: null,
        startedAt: null,
        completedAt: null,
        itemsProcessed: 0,
        itemsTotal: null,
        errorMessage: 'Failed to get status',
        progress: 0,
      };
    }
  }

  /**
   * Run full 30-day backfill pipeline
   */
  async runFullBackfill(config: BackfillConfig): Promise<BackfillResult> {
    const result: BackfillResult = {
      marketsFound: 0,
      marketsProcessed: 0,
      tradesProcessed: 0,
      eventsCreated: 0,
      errors: [],
    };

    // Create job record
    const jobResult = await this.pg.query(`
      INSERT INTO backfill_jobs (job_type, status, started_at, config)
      VALUES ('full', 'running', NOW(), $1)
      RETURNING id
    `, [JSON.stringify(config)]);
    this.currentJobId = jobResult.rows[0].id;

    try {
      // Step 1: Fetch resolved markets from Gamma API
      logger.info({ days: config.days, config }, 'Starting market backfill - fetching resolved markets');
      const markets = await this.fetchResolvedMarkets(config.days);
      result.marketsFound = markets.length;
      logger.info({ marketsFound: markets.length }, 'Fetched markets, updating job progress');

      await this.updateJobProgress(markets.length, 0);
      logger.info({ marketsFound: markets.length }, 'Job progress updated, starting market processing');

      // Step 2: Process each market
      for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        try {
          // Insert market into resolved_markets table
          await this.insertResolvedMarket(market);

          // Fetch trades for this market
          const trades = await this.fetchMarketTrades(
            market.conditionId,
            new Date(market.endDate),
            config.windowMinutes
          );

          // Insert historical trades
          for (const trade of trades) {
            await this.insertHistoricalTrade(market.conditionId, trade, market);
          }
          result.tradesProcessed += trades.length;

          // Compute contrarian events for this market
          const eventsCreated = await this.computeContrarianEvents(
            market.conditionId,
            config
          );
          result.eventsCreated += eventsCreated;

          result.marketsProcessed++;
          await this.updateJobProgress(markets.length, i + 1);

        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Market ${market.conditionId}: ${errMsg}`);
          logger.warn({ error, conditionId: market.conditionId }, 'Failed to process market');
        }

        // Rate limiting
        await this.delay(API_DELAY_MS);
      }

      // Mark job complete
      await this.pg.query(`
        UPDATE backfill_jobs
        SET status = 'completed', completed_at = NOW()
        WHERE id = $1
      `, [this.currentJobId]);

      logger.info(result, 'Backfill completed');

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errMsg);

      await this.pg.query(`
        UPDATE backfill_jobs
        SET status = 'failed', completed_at = NOW(), error_message = $2
        WHERE id = $1
      `, [this.currentJobId, errMsg]);

      logger.error({ error }, 'Backfill failed');
    }

    this.currentJobId = null;
    return result;
  }

  /**
   * Fetch resolved markets from Gamma API
   */
  private async fetchResolvedMarkets(days: number): Promise<GammaMarket[]> {
    const markets: GammaMarket[] = [];
    const minEndDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const minEndDateStr = minEndDate.toISOString().split('T')[0];

    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const url = `${GAMMA_API_BASE}/markets?closed=true&end_date_min=${minEndDateStr}&limit=${limit}&offset=${offset}`;
      logger.info({ url, offset }, 'Fetching markets from Gamma API');

      try {
        const response = await fetch(url);
        logger.info({ status: response.status, ok: response.ok }, 'Gamma API response received');
        if (!response.ok) {
          throw new Error(`Gamma API error: ${response.status}`);
        }

        const data = await response.json() as GammaMarket[];
        logger.info({ dataLength: data.length }, 'Parsed Gamma API response');

        if (data.length === 0) {
          hasMore = false;
          logger.info('No more markets to fetch');
        } else {
          // Filter to only resolved markets with outcome prices
          const resolved = data.filter(m => {
            if (!m.outcomePrices) return false;
            try {
              const prices = JSON.parse(m.outcomePrices);
              // Market is resolved if one outcome is 1 and other is 0
              // Prices may be strings or numbers from the API
              const p0 = String(prices[0]);
              const p1 = String(prices[1]);
              return prices.length === 2 &&
                ((p0 === '1' && p1 === '0') ||
                 (p0 === '0' && p1 === '1'));
            } catch {
              return false;
            }
          });

          logger.info({ resolvedCount: resolved.length, totalDataCount: data.length }, 'Filtered resolved markets');
          markets.push(...resolved);
          offset += limit;

          if (data.length < limit) {
            hasMore = false;
            logger.info('Reached end of market data');
          }
        }

        await this.delay(API_DELAY_MS);

      } catch (error) {
        logger.error({ error, url }, 'Failed to fetch markets from Gamma API');
        hasMore = false;
      }
    }

    logger.info({ totalResolved: markets.length }, 'Completed fetching resolved markets from Gamma');
    return markets;
  }

  /**
   * Fetch trades for a market from Data API
   */
  private async fetchMarketTrades(
    conditionId: string,
    endDate: Date,
    windowMinutes: number
  ): Promise<DataApiTrade[]> {
    const trades: DataApiTrade[] = [];

    // Fetch trades from windowMinutes before close to end
    const startTime = Math.floor((endDate.getTime() - windowMinutes * 60 * 1000) / 1000);
    const endTime = Math.floor(endDate.getTime() / 1000);

    let offset = 0;
    const limit = 500;
    let hasMore = true;

    while (hasMore) {
      const url = `${DATA_API_BASE}/trades?market=${conditionId}&start=${startTime}&end=${endTime}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;

      try {
        const response = await fetch(url);
        if (!response.ok) {
          if (response.status === 504) {
            // Gateway timeout - skip and continue
            logger.warn({ conditionId }, 'Data API timeout, skipping');
            break;
          }
          throw new Error(`Data API error: ${response.status}`);
        }

        const data = await response.json() as DataApiTrade[];

        if (data.length === 0) {
          hasMore = false;
        } else {
          trades.push(...data);
          offset += limit;

          if (data.length < limit || offset >= 10000) {
            hasMore = false;
          }
        }

        await this.delay(API_DELAY_MS);

      } catch (error) {
        logger.warn({ error, conditionId }, 'Failed to fetch trades');
        hasMore = false;
      }
    }

    return trades;
  }

  /**
   * Insert a resolved market into the database
   */
  private async insertResolvedMarket(market: GammaMarket): Promise<void> {
    // Parse outcome prices to determine winner
    let winningOutcome: string | null = null;
    let finalYesPrice: number | null = null;
    let finalNoPrice: number | null = null;
    let yesTokenId: string | null = null;
    let noTokenId: string | null = null;
    let winningTokenId: string | null = null;

    try {
      const prices = JSON.parse(market.outcomePrices);
      finalYesPrice = prices[0];
      finalNoPrice = prices[1];

      if (prices[0] === 1) {
        winningOutcome = 'Yes';
      } else if (prices[1] === 1) {
        winningOutcome = 'No';
      }

      // Parse token IDs
      if (market.clobTokenIds) {
        const tokenIds = JSON.parse(market.clobTokenIds);
        yesTokenId = tokenIds[0] || null;
        noTokenId = tokenIds[1] || null;
        winningTokenId = winningOutcome === 'Yes' ? yesTokenId : noTokenId;
      }
    } catch {
      // Ignore parse errors
    }

    const eventSlug = market.events?.[0]?.slug || null;
    const category = market.events?.[0]?.title || null;

    await this.pg.query(`
      INSERT INTO resolved_markets (
        condition_id, question, end_date, winning_outcome, winning_token_id,
        yes_token_id, no_token_id, final_yes_price, final_no_price,
        total_volume, total_liquidity, category, event_slug, slug
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (condition_id) DO UPDATE SET
        winning_outcome = EXCLUDED.winning_outcome,
        final_yes_price = EXCLUDED.final_yes_price,
        final_no_price = EXCLUDED.final_no_price,
        backfilled_at = NOW()
    `, [
      market.conditionId,
      market.question,
      market.endDate,
      winningOutcome,
      winningTokenId,
      yesTokenId,
      noTokenId,
      finalYesPrice,
      finalNoPrice,
      parseFloat(market.volume) || 0,
      parseFloat(market.liquidity) || 0,
      category,
      eventSlug,
      market.slug,
    ]);
  }

  /**
   * Insert a historical trade
   */
  private async insertHistoricalTrade(
    conditionId: string,
    trade: DataApiTrade,
    market: GammaMarket
  ): Promise<void> {
    // Determine outcome from outcomeIndex or token ID
    let outcome = trade.outcome;
    if (!outcome) {
      outcome = trade.outcomeIndex === 0 ? 'Yes' : 'No';
    }

    // Get token ID
    let tokenId = trade.assetId;
    if (!tokenId && market.clobTokenIds) {
      try {
        const tokenIds = JSON.parse(market.clobTokenIds);
        tokenId = tokenIds[trade.outcomeIndex] || '';
      } catch {
        tokenId = '';
      }
    }

    const notional = trade.size * trade.price;
    const tradeId = trade.transactionHash || trade.id || `${conditionId}-${trade.timestamp}`;

    await this.pg.query(`
      INSERT INTO historical_trades (
        condition_id, token_id, trade_id, trade_timestamp, taker_address,
        maker_address, side, price, size, notional, outcome, transaction_hash
      )
      VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (condition_id, trade_id) DO NOTHING
    `, [
      conditionId,
      tokenId,
      tradeId,
      trade.timestamp,
      trade.proxyWallet,
      trade.maker || null,
      trade.side.toUpperCase(),
      trade.price,
      trade.size,
      notional,
      outcome,
      trade.transactionHash || null,
    ]);
  }

  /**
   * Compute contrarian events for a market
   */
  private async computeContrarianEvents(
    conditionId: string,
    config: BackfillConfig
  ): Promise<number> {
    // Get market info
    const marketResult = await this.pg.query(`
      SELECT end_date, winning_outcome, yes_token_id, no_token_id
      FROM resolved_markets
      WHERE condition_id = $1
    `, [conditionId]);

    if (marketResult.rows.length === 0) return 0;

    const market = marketResult.rows[0];
    const endDate = new Date(market.end_date);
    const winningOutcome = market.winning_outcome;

    // Get all BUY trades within the window
    const tradesResult = await this.pg.query(`
      SELECT token_id, trade_timestamp, taker_address, side, price, size, notional, outcome
      FROM historical_trades
      WHERE condition_id = $1
        AND side = 'BUY'
        AND notional >= $2
      ORDER BY trade_timestamp ASC
    `, [conditionId, config.minSizeUsd]);

    if (tradesResult.rows.length === 0) return 0;

    // Get all trade sizes for percentile calculation
    const allSizesResult = await this.pg.query(`
      SELECT notional FROM historical_trades WHERE condition_id = $1
    `, [conditionId]);
    const allSizes = allSizesResult.rows.map(r => parseFloat(r.notional));

    let eventsCreated = 0;

    for (const trade of tradesResult.rows) {
      const tradeTime = new Date(trade.trade_timestamp);
      const minutesBeforeClose = (endDate.getTime() - tradeTime.getTime()) / (1000 * 60);

      // Skip if outside window
      if (minutesBeforeClose > config.windowMinutes || minutesBeforeClose < 0) {
        continue;
      }

      const notional = parseFloat(trade.notional);
      const price = parseFloat(trade.price);
      const outcome = trade.outcome;

      // Compute size features
      const sizePercentile = percentileRank(notional, allSizes);
      const sizeZScore = robustZScore(notional, allSizes);
      const isTailTrade = sizePercentile >= 95;

      // Price-based contrarian (simple: price < 0.50)
      const isPriceContrarian = price < 0.50;

      // Compute price trend (simplified: use average price in prior 30 min)
      const priorPricesResult = await this.pg.query(`
        SELECT AVG(price) as avg_price
        FROM historical_trades
        WHERE condition_id = $1
          AND token_id = $2
          AND trade_timestamp < $3
          AND trade_timestamp > $3 - INTERVAL '30 minutes'
      `, [conditionId, trade.token_id, trade.trade_timestamp]);

      const priorAvgPrice = priorPricesResult.rows[0]?.avg_price
        ? parseFloat(priorPricesResult.rows[0].avg_price)
        : price;
      const priceTrend = price - priorAvgPrice;

      // Is against trend? For a BUY, contrarian if price has been falling
      const isAgainstTrend = priceTrend < -0.01; // Price dropped by at least 1%

      // OFI simplified: count buys vs sells in prior period
      const ofiResult = await this.pg.query(`
        SELECT
          SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END) as buy_volume,
          SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END) as sell_volume
        FROM historical_trades
        WHERE condition_id = $1
          AND trade_timestamp < $2
          AND trade_timestamp > $2 - INTERVAL '30 minutes'
      `, [conditionId, trade.trade_timestamp]);

      const buyVolume = parseFloat(ofiResult.rows[0]?.buy_volume || '0');
      const sellVolume = parseFloat(ofiResult.rows[0]?.sell_volume || '0');
      const ofi = buyVolume - sellVolume;
      const isAgainstOfi = ofi < 0; // More selling than buying

      // Combined contrarian: against both trend and OFI
      const isContrarian = isAgainstTrend && isAgainstOfi;

      // Determine if outcome won
      const outcomeWon = outcome === winningOutcome;

      // Insert contrarian event
      await this.pg.query(`
        INSERT INTO contrarian_events (
          condition_id, token_id, trade_timestamp, minutes_before_close,
          trade_side, trade_price, trade_size, trade_notional, taker_address,
          size_percentile, size_z_score, is_tail_trade,
          is_price_contrarian, price_trend_30m, is_against_trend,
          ofi_30m, is_against_ofi, is_contrarian,
          traded_outcome, outcome_won
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (condition_id, token_id, trade_timestamp) DO UPDATE SET
          size_percentile = EXCLUDED.size_percentile,
          is_price_contrarian = EXCLUDED.is_price_contrarian,
          is_against_trend = EXCLUDED.is_against_trend,
          is_against_ofi = EXCLUDED.is_against_ofi,
          is_contrarian = EXCLUDED.is_contrarian,
          outcome_won = EXCLUDED.outcome_won
      `, [
        conditionId,
        trade.token_id,
        trade.trade_timestamp,
        minutesBeforeClose,
        trade.side,
        price,
        parseFloat(trade.size),
        notional,
        trade.taker_address,
        sizePercentile,
        sizeZScore,
        isTailTrade,
        isPriceContrarian,
        priceTrend,
        isAgainstTrend,
        ofi,
        isAgainstOfi,
        isContrarian,
        outcome,
        outcomeWon,
      ]);

      eventsCreated++;
    }

    return eventsCreated;
  }

  /**
   * Update job progress
   */
  private async updateJobProgress(total: number, processed: number): Promise<void> {
    if (!this.currentJobId) return;

    await this.pg.query(`
      UPDATE backfill_jobs
      SET items_total = $2, items_processed = $3
      WHERE id = $1
    `, [this.currentJobId, total, processed]);
  }

  /**
   * Delay helper for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

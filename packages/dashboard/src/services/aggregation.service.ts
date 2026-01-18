import { Pool } from 'pg';
import { RedisKeys, createLogger, Redis, DataApiTradeResponse } from '@polymarketbot/shared';
import { WalletProfileService } from './wallet-profile.service.js';
import { DataApiClient } from '@polymarketbot/collector';

// =============================================================================
// Aggregation Service
// =============================================================================

const logger = createLogger('aggregation-service');

export interface MarketSummary {
  conditionId: string;
  tokenId: string;
  question: string;
  closeTime: number;
  timeToCloseMinutes: number;
  currentMid: number | null;
  latestAnomalyScore: number | null;
  latestExecutionScore: number | null;
  signalStrength: string | null;
  category: string | null;
  tags: string[];
}

export interface PositionSummary {
  tokenId: string;
  conditionId: string;
  side: string;
  entryPrice: number;
  currentPrice: number | null;
  sizeUsd: number;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  entryTime: number;
}

export interface SystemStats {
  bankroll: number;
  totalExposure: number;
  exposurePct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  drawdownPct: number;
  circuitBreakerActive: boolean;
  openPositions: number;
  trackedMarkets: number;
  totalTrades: number;
  winRate: number | null;
}

export interface TriggeringTradeInfo {
  tradeId: string;
  timestamp: number;
  sizeUsd: number;
  price: number;
  side: 'BUY' | 'SELL';
  percentile: number;
  walletAddress: string;
  walletAgeDays: number | null;
  walletAgeFormatted: string;
  dollarFloorMultiplier: number;
  /** Transaction hash for on-chain verification */
  transactionHash: string | null;
  /** Polygonscan URL for the transaction */
  polygonscanUrl: string | null;
}

export interface EnrichedOpportunity {
  tokenId: string;
  conditionId: string;
  question: string;
  slug: string | null;
  eventSlug: string | null;
  polymarketUrl: string | null;
  outcome: string;
  daysUntilClose: number;
  closeTime: number;
  currentPrice: number | null;
  anomalyScore: number;
  executionScore: number;
  edgeScore: number;
  compositeScore: number;
  signalStrength: string;
  // Triggering trade information
  triggerTradeUsd: number | null;
  triggerWalletAge: string | null;
  triggerWalletAgeDays: number | null;
  /** Transaction hash of the triggering trade for on-chain verification */
  triggerTxHash: string | null;
  /** Polygonscan URL for the triggering transaction */
  triggerPolygonscanUrl: string | null;
  triggeringTrades: TriggeringTradeInfo[];
}

export interface RecentTradeActivity {
  // Trade info
  tradeId: string;
  timestamp: number;
  side: 'buy' | 'sell';
  sizeUsd: number;
  quantity: number;
  price: number;
  outcome: string;
  displaySide: string; // "bought Yes", "sold No", etc.

  // Market info
  conditionId: string;
  question: string;
  eventSlug: string | null;
  slug: string | null;

  // Wallet info
  walletAddress: string;
  username: string | null;
  displayName: string | null;
  profileUrl: string;
  polygonscanUrl: string;

  // Wallet join date
  joinedDate: string | null;
  joinedTimestamp: number | null;

  // URL
  polymarketUrl: string | null;
}

export class AggregationService {
  private redis: Redis;
  private pgPool: Pool | null;
  private walletProfileService: WalletProfileService;
  private dataApiClient: DataApiClient;

  constructor(redis: Redis, pgPool?: Pool) {
    this.redis = redis;
    this.pgPool = pgPool ?? null;
    this.walletProfileService = new WalletProfileService(redis);
    this.dataApiClient = new DataApiClient();
  }

  /**
   * Parse tracked token data from Redis (stored as JSON strings).
   */
  private parseTrackedToken(tokenData: string): { tokenId: string; conditionId?: string; outcome?: string } | null {
    try {
      const parsed = JSON.parse(tokenData);
      return {
        tokenId: parsed.tokenId,
        conditionId: parsed.conditionId,
        outcome: parsed.outcome,
      };
    } catch {
      // Fallback if already plain tokenId
      return { tokenId: tokenData };
    }
  }

  /**
   * Get all tracked markets with their latest scores.
   */
  async getTrackedMarkets(): Promise<MarketSummary[]> {
    const trackedTokens = await this.redis.smembers(RedisKeys.trackedTokens());
    const markets: MarketSummary[] = [];

    for (const tokenData of trackedTokens) {
      try {
        const parsed = this.parseTrackedToken(tokenData);
        if (!parsed) continue;
        const { tokenId } = parsed;

        // Get condition ID (from parsed data or Redis lookup)
        let conditionId = parsed.conditionId;
        if (!conditionId) {
          conditionId = await this.redis.get(RedisKeys.tokenToCondition(tokenId)) ?? undefined;
        }
        if (!conditionId) continue;

        // Get market metadata (stored as JSON string)
        const metadataJson = await this.redis.get(RedisKeys.marketMetadata(conditionId));
        if (!metadataJson) continue;
        const metadata = JSON.parse(metadataJson);
        if (!metadata.question) continue;

        // Get latest score
        const scoreJson = await this.redis.get(RedisKeys.scoreCache(tokenId));
        const score = scoreJson ? JSON.parse(scoreJson) : null;

        // Get latest orderbook state (stored as JSON string)
        let currentMid: number | null = null;
        try {
          const bookStateJson = await this.redis.get(RedisKeys.orderbookState(tokenId));
          if (bookStateJson) {
            const bookState = JSON.parse(bookStateJson);
            currentMid = bookState?.orderbook?.midPrice ?? null;
          }
        } catch {
          // Ignore orderbook parse errors
        }

        const closeTime = metadata.endDateIso ? new Date(metadata.endDateIso).getTime() : 0;
        const now = Date.now();
        const timeToCloseMinutes = Math.max(0, (closeTime - now) / 60000);

        markets.push({
          conditionId,
          tokenId,
          question: metadata.question,
          closeTime,
          timeToCloseMinutes,
          currentMid,
          latestAnomalyScore: score?.anomalyScore ?? null,
          latestExecutionScore: score?.executionScore ?? null,
          signalStrength: score?.signalStrength ?? null,
          category: metadata.category || null,
          tags: metadata.tags || [],
        });
      } catch (error) {
        logger.warn({ tokenData, error }, 'Failed to get market summary');
      }
    }

    // Sort by time to close (soonest first)
    markets.sort((a, b) => a.timeToCloseMinutes - b.timeToCloseMinutes);

    return markets;
  }

  /**
   * Get latest scores for all tracked markets.
   */
  async getLatestScores(): Promise<Array<{
    tokenId: string;
    timestamp: number;
    anomalyScore: number;
    executionScore: number;
    edgeScore: number;
    compositeScore: number;
    signalStrength: string;
  }>> {
    const trackedTokens = await this.redis.smembers(RedisKeys.trackedTokens());
    const scores: Array<{
      tokenId: string;
      timestamp: number;
      anomalyScore: number;
      executionScore: number;
      edgeScore: number;
      compositeScore: number;
      signalStrength: string;
    }> = [];

    for (const tokenData of trackedTokens) {
      const parsed = this.parseTrackedToken(tokenData);
      if (!parsed) continue;
      const { tokenId } = parsed;

      const scoreJson = await this.redis.get(RedisKeys.scoreCache(tokenId));
      if (scoreJson) {
        const score = JSON.parse(scoreJson);
        scores.push({
          tokenId,
          ...score,
        });
      }
    }

    // Sort by composite score (highest first)
    scores.sort((a, b) => b.compositeScore - a.compositeScore);

    return scores;
  }

  /**
   * Get all open positions.
   */
  async getOpenPositions(): Promise<PositionSummary[]> {
    const tokenIds = await this.redis.smembers(RedisKeys.openPositions());
    const positions: PositionSummary[] = [];

    for (const tokenId of tokenIds) {
      const positionData = await this.redis.hgetall(RedisKeys.position(tokenId));
      if (positionData && positionData.id) {
        positions.push({
          tokenId: positionData.tokenId,
          conditionId: positionData.conditionId,
          side: positionData.side,
          entryPrice: parseFloat(positionData.entryPrice),
          currentPrice: positionData.currentPrice ? parseFloat(positionData.currentPrice) : null,
          sizeUsd: parseFloat(positionData.sizeUsd),
          unrealizedPnl: positionData.unrealizedPnl ? parseFloat(positionData.unrealizedPnl) : null,
          unrealizedPnlPct: positionData.unrealizedPnlPct ? parseFloat(positionData.unrealizedPnlPct) : null,
          entryTime: parseInt(positionData.entryTime, 10),
        });
      }
    }

    // Sort by entry time (most recent first)
    positions.sort((a, b) => b.entryTime - a.entryTime);

    return positions;
  }

  /**
   * Get system-wide stats.
   */
  async getSystemStats(): Promise<SystemStats> {
    const [
      bankrollStr,
      exposureStr,
      dailyPnlStr,
      drawdownStr,
      circuitBreakerData,
      openPositionIds,
      trackedTokenIds,
    ] = await Promise.all([
      this.redis.get(RedisKeys.paperBankroll()),
      this.redis.get(RedisKeys.totalExposure()),
      this.redis.get(RedisKeys.dailyPnl()),
      this.redis.get(RedisKeys.drawdownPct()),
      this.redis.hgetall(RedisKeys.circuitBreaker()),
      this.redis.smembers(RedisKeys.openPositions()),
      this.redis.smembers(RedisKeys.trackedTokens()),
    ]);

    const bankroll = parseFloat(bankrollStr ?? '10000');
    const totalExposure = parseFloat(exposureStr ?? '0');
    const dailyPnl = parseFloat(dailyPnlStr ?? '0');
    const drawdownPct = parseFloat(drawdownStr ?? '0');
    const circuitBreakerActive = circuitBreakerData?.active === 'true';

    // Calculate percentages
    const exposurePct = bankroll > 0 ? (totalExposure / bankroll) * 100 : 0;
    const dailyPnlPct = bankroll > 0 ? (dailyPnl / bankroll) * 100 : 0;

    // Get win rate from PostgreSQL if available
    let totalTrades = 0;
    let winRate: number | null = null;

    if (this.pgPool) {
      try {
        const result = await this.pgPool.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE realized_pnl > 0) as wins
          FROM paper_positions
          WHERE status = 'closed'
        `);
        if (result.rows[0]) {
          totalTrades = parseInt(result.rows[0].total, 10);
          const wins = parseInt(result.rows[0].wins, 10);
          winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null;
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to get win rate from PostgreSQL');
      }
    }

    return {
      bankroll,
      totalExposure,
      exposurePct,
      dailyPnl,
      dailyPnlPct,
      drawdownPct: drawdownPct * 100,
      circuitBreakerActive,
      openPositions: openPositionIds.length,
      trackedMarkets: trackedTokenIds.length,
      totalTrades,
      winRate,
    };
  }

  /**
   * Get recent decisions.
   */
  async getRecentDecisions(limit: number = 20): Promise<Array<{
    tokenId: string;
    timestamp: number;
    action: string;
    approved: boolean;
    targetSizeUsd: number | null;
    rejectionReason: string | null;
  }>> {
    if (!this.pgPool) {
      return [];
    }

    try {
      const result = await this.pgPool.query(
        `
        SELECT
          token_id,
          time as timestamp,
          action,
          approved,
          target_size_usd,
          rejection_reason
        FROM decisions
        ORDER BY time DESC
        LIMIT $1
      `,
        [limit]
      );

      return result.rows.map((row) => ({
        tokenId: row.token_id,
        timestamp: new Date(row.timestamp).getTime(),
        action: row.action,
        approved: row.approved,
        targetSizeUsd: row.target_size_usd ? parseFloat(row.target_size_usd) : null,
        rejectionReason: row.rejection_reason,
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to get recent decisions');
      return [];
    }
  }

  /**
   * Get enriched opportunities with market data and Polymarket links.
   * Returns all tracked tokens with scores, sorted by composite score.
   */
  async getEnrichedOpportunities(): Promise<EnrichedOpportunity[]> {
    const trackedTokens = await this.redis.smembers(RedisKeys.trackedTokens());
    const opportunities: EnrichedOpportunity[] = [];
    const now = Date.now();

    for (const tokenData of trackedTokens) {
      try {
        const parsed = this.parseTrackedToken(tokenData);
        if (!parsed) continue;
        const { tokenId, outcome } = parsed;

        // Get condition ID
        let conditionId = parsed.conditionId;
        if (!conditionId) {
          conditionId = await this.redis.get(RedisKeys.tokenToCondition(tokenId)) ?? undefined;
        }
        if (!conditionId) continue;

        // Get market metadata (includes slug, question, endDateIso)
        const metadataJson = await this.redis.get(RedisKeys.marketMetadata(conditionId));
        const metadata = metadataJson ? JSON.parse(metadataJson) : null;

        // Get current price from orderbook (stored as JSON string)
        let currentPrice: number | null = null;
        try {
          const bookStateJson = await this.redis.get(RedisKeys.orderbookState(tokenId));
          if (bookStateJson) {
            const bookState = JSON.parse(bookStateJson);
            currentPrice = bookState?.orderbook?.midPrice ?? null;
          }
        } catch {
          // Ignore orderbook parse errors
        }

        // Filter out "almost certain" markets - no edge available
        // Skip markets with price > 0.95 (almost certain YES) or < 0.05 (almost certain NO)
        if (currentPrice !== null && (currentPrice > 0.95 || currentPrice < 0.05)) {
          continue;
        }

        // Parse endTime from tracked token if available (format: "2026-01-19")
        let endTimeFromToken: string | undefined;
        try {
          const tokenJson = JSON.parse(tokenData);
          endTimeFromToken = tokenJson.endTime;
        } catch {
          // Ignore parse errors
        }

        // Calculate days until close - prefer metadata, fallback to tracked token endTime
        const endDateStr = metadata?.endDateIso || endTimeFromToken;
        const closeTime = endDateStr ? new Date(endDateStr).getTime() : 0;
        const msUntilClose = closeTime - now;
        const daysUntilClose = msUntilClose / (1000 * 60 * 60 * 24);

        // Construct Polymarket URL from eventSlug and slug
        // URL format: /event/{eventSlug}/{marketSlug} for specific outcome
        // Fallback 1: /event/{eventSlug} for event overview
        // Fallback 2: /event/{conditionId} if no slugs available
        const polymarketUrl = metadata?.eventSlug && metadata?.slug
          ? `https://polymarket.com/event/${metadata.eventSlug}/${metadata.slug}`
          : metadata?.eventSlug
            ? `https://polymarket.com/event/${metadata.eventSlug}`
            : conditionId
              ? `https://polymarket.com/event/${conditionId}`
              : null;

        // Get score (may not exist yet if scorer hasn't run)
        const scoreJson = await this.redis.get(RedisKeys.scoreCache(tokenId));
        const score = scoreJson ? JSON.parse(scoreJson) : null;

        // Extract trade information
        // Prefer highestTrade1h (always available for all ranked markets)
        // Fallback to triggeringTrades (only for high-confidence signals meeting $5k + q95)
        const highestTrade1h = score?.highestTrade1h ?? null;
        const triggeringTrades: TriggeringTradeInfo[] = score?.triggeringTrades ?? [];
        const primaryTrade = highestTrade1h ?? (triggeringTrades.length > 0 ? triggeringTrades[0] : null);

        opportunities.push({
          tokenId,
          conditionId,
          question: metadata?.question || outcome || 'Unknown Market',
          slug: metadata?.slug || null,
          eventSlug: metadata?.eventSlug || null,
          polymarketUrl,
          outcome: outcome || 'Yes',
          daysUntilClose: Math.max(0, daysUntilClose),
          closeTime,
          currentPrice,
          anomalyScore: score?.anomalyScore?.score ?? score?.anomalyScore ?? 0,
          executionScore: score?.executionScore?.score ?? score?.executionScore ?? 0,
          edgeScore: score?.edgeScore?.score ?? score?.edgeScore ?? 0,
          compositeScore: score?.compositeScore ?? 0,
          signalStrength: score?.signalStrength ?? 'none',
          triggerTradeUsd: primaryTrade?.sizeUsd ?? null,
          triggerWalletAge: primaryTrade?.walletAgeFormatted ?? null,
          triggerWalletAgeDays: primaryTrade?.walletAgeDays ?? null,
          triggerTxHash: primaryTrade?.transactionHash ?? null,
          triggerPolygonscanUrl: primaryTrade?.polygonscanUrl ?? null,
          triggeringTrades,
        });
      } catch (error) {
        logger.warn({ tokenData, error }, 'Failed to parse opportunity');
      }
    }

    // Sort by composite score descending (highest first)
    opportunities.sort((a, b) => b.compositeScore - a.compositeScore);

    return opportunities;
  }

  /**
   * Get recent high-value trades from Data API.
   * Uses the rich trade data that includes username, eventSlug, etc.
   */
  async getRecentActivity(limit: number = 20): Promise<RecentTradeActivity[]> {
    try {
      // Fetch recent trades from Data API (sorted by timestamp descending)
      const trades = await this.dataApiClient.getTrades({
        limit: 100, // Fetch more than needed to filter
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      });

      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;

      const activities: RecentTradeActivity[] = [];

      for (const trade of trades) {
        // Only include trades from last hour
        const tradeTime = trade.timestamp * 1000; // API returns seconds
        if (tradeTime < oneHourAgo) continue;

        // Calculate trade notional
        const notional = trade.size * trade.price;

        // Determine outcome and display side
        const outcome = trade.outcome ?? (trade.outcomeIndex === 0 ? 'Yes' : 'No');
        const displaySide = trade.side.toLowerCase() === 'buy'
          ? `bought ${outcome}`
          : `sold ${outcome}`;

        // Get wallet join date from profile service
        const walletKey = trade.pseudonym || trade.proxyWallet;
        let joinedDate: string | null = null;
        let joinedTimestamp: number | null = null;

        try {
          const walletProfile = await this.walletProfileService.getProfile(walletKey);
          joinedDate = walletProfile.joinedDate;
          joinedTimestamp = walletProfile.joinedTimestamp;
        } catch (error) {
          logger.debug({ error, walletKey }, 'Failed to fetch wallet profile');
        }

        activities.push({
          // Trade info
          tradeId: trade.transactionHash || `${trade.conditionId}-${trade.timestamp}`,
          timestamp: tradeTime,
          side: trade.side.toLowerCase() as 'buy' | 'sell',
          sizeUsd: notional,
          quantity: trade.size,
          price: trade.price,
          outcome,
          displaySide,

          // Market info
          conditionId: trade.conditionId,
          question: trade.title ?? 'Unknown Market',
          eventSlug: trade.eventSlug ?? null,
          slug: trade.slug ?? null,

          // Wallet info
          walletAddress: trade.proxyWallet,
          username: trade.pseudonym ?? null,
          displayName: trade.name ?? null,
          profileUrl: trade.pseudonym
            ? `https://polymarket.com/@${trade.pseudonym}`
            : `https://polymarket.com/@${trade.proxyWallet}`,
          polygonscanUrl: trade.transactionHash
            ? `https://polygonscan.com/tx/${trade.transactionHash}`
            : `https://polygonscan.com/address/${trade.proxyWallet}`,

          // Wallet join date
          joinedDate,
          joinedTimestamp,

          // Polymarket URL (fixed!)
          polymarketUrl: trade.eventSlug
            ? `https://polymarket.com/event/${trade.eventSlug}${trade.slug ? `/${trade.slug}` : ''}`
            : null,
        });

        if (activities.length >= limit) break;
      }

      logger.info({ count: activities.length }, 'Fetched recent activity');
      return activities;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch recent activity');
      return [];
    }
  }

  /**
   * Get top N largest BUY trades from recent activity.
   * Filtered to BUY side only, >= $500, excludes sports/esports, sorted by sizeUsd descending.
   */
  async getTopTrades(limit: number = 10): Promise<RecentTradeActivity[]> {
    const allActivity = await this.getRecentActivity(100);

    // Comprehensive sports/esports/betting exclusion patterns
    const exclusions = [
      // Generic sports
      'sports', 'esports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football',
      'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'mma', 'ufc',
      'boxing', 'cricket', 'f1', 'formula 1', 'nascar', 'rugby', 'volleyball',

      // Major events
      'super bowl', 'world series', 'world cup', 'champions league', 'stanley cup',
      'playoffs', 'finals', 'championship', 'march madness', 'bowl game',

      // Betting patterns (strong indicators of sports betting)
      'o/u ', 'over/under', 'handicap', 'point spread', 'moneyline',
      'vs.', 'vs ', // Matchup patterns (no leading space needed)

      // NFL teams
      'patriots', 'texans', 'rams', 'chiefs', 'eagles', 'cowboys', 'packers',
      'bills', 'dolphins', 'jets', 'ravens', 'steelers', 'bengals', 'browns',
      'titans', 'colts', 'jaguars', 'broncos', 'raiders', 'chargers', 'seahawks',
      '49ers', 'cardinals', 'falcons', 'panthers', 'saints', 'buccaneers',
      'bears', 'lions', 'vikings', 'commanders', 'giants',

      // NBA teams
      'lakers', 'celtics', 'warriors', 'heat', 'bulls', 'knicks', 'nets',
      'clippers', 'suns', 'mavericks', 'bucks', 'sixers', '76ers', 'raptors',
      'nuggets', 'grizzlies', 'pelicans', 'spurs', 'rockets', 'timberwolves',
      'thunder', 'blazers', 'jazz', 'kings', 'magic', 'pistons', 'pacers',
      'hornets', 'hawks', 'cavaliers', 'wizards',

      // Soccer/Football (international clubs & leagues)
      'fútbol', 'futbol', ' fc', 'ac milan', 'inter milan', 'as roma',
      'arsenal', 'chelsea', 'liverpool', 'manchester', 'tottenham',
      'real madrid', 'barcelona', 'atletico', 'real sociedad', 'sevilla',
      'juventus', 'napoli', 'lazio', 'fiorentina', 'lecce',
      'bayern', 'borussia', 'leverkusen', 'leipzig',
      'psg', 'marseille', 'lyon', 'olympique', 'stade', 'brestois',
      'ajax', 'psv', 'feyenoord', 'benfica', 'porto', 'sporting',
      'la liga', 'premier league', 'serie a', 'bundesliga', 'ligue 1',
      'eredivisie', 'primeira liga', 'uefa', 'fifa',

      // Esports games
      'call of duty', 'league of legends', 'counter-strike', 'cs2', 'csgo',
      'dota', 'valorant', 'overwatch', 'fortnite', 'pubg', 'apex legends',
      'rainbow six', 'rocket league', 'halo', 'starcraft',
      'lol:', 'lol ', // LoL shorthand

      // Common esports teams/orgs
      'natus vincere', 'navi', 'faze', 'g2', 'team liquid', 'fnatic',
      'cloud9', 'tsm', '100 thieves', 'sentinels', 'optic',
      'karmine', 'movistar', 'koi',
    ];

    const MIN_TOP_TRADE_USD = 500;

    return allActivity
      .filter(a => {
        // Only BUY side trades
        if (a.side !== 'buy') return false;

        // Minimum $500 threshold
        if (a.sizeUsd < MIN_TOP_TRADE_USD) return false;

        // Exclude sports/esports based on question text
        const questionLower = (a.question || '').toLowerCase();
        const isExcluded = exclusions.some(exc => questionLower.includes(exc));
        return !isExcluded;
      })
      .sort((a, b) => b.sizeUsd - a.sizeUsd)
      .slice(0, limit);
  }

  /**
   * Get markets closing soon, filtered to exclude sports/esports.
   * Returns only political and economic markets sorted by close time.
   */
  async getMarketsClosingSoon(options: {
    maxMinutes?: number;
    limit?: number;
  }): Promise<MarketSummary[]> {
    const { maxMinutes = 1440, limit = 20 } = options;

    // Comprehensive sports/esports/betting exclusion patterns
    const exclusions = [
      // Generic sports
      'sports', 'esports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football',
      'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'mma', 'ufc',
      'boxing', 'cricket', 'f1', 'formula 1', 'nascar', 'rugby', 'volleyball',

      // Major events
      'super bowl', 'world series', 'world cup', 'champions league', 'stanley cup',
      'playoffs', 'finals', 'championship', 'march madness', 'bowl game',

      // Betting patterns (strong indicators of sports betting)
      'o/u ', 'over/under', 'handicap', 'point spread', 'moneyline',
      'vs.', 'vs ', // Matchup patterns (no leading space needed)

      // NFL teams
      'patriots', 'texans', 'rams', 'chiefs', 'eagles', 'cowboys', 'packers',
      'bills', 'dolphins', 'jets', 'ravens', 'steelers', 'bengals', 'browns',
      'titans', 'colts', 'jaguars', 'broncos', 'raiders', 'chargers', 'seahawks',
      '49ers', 'cardinals', 'falcons', 'panthers', 'saints', 'buccaneers',
      'bears', 'lions', 'vikings', 'commanders', 'giants',

      // NBA teams
      'lakers', 'celtics', 'warriors', 'heat', 'bulls', 'knicks', 'nets',
      'clippers', 'suns', 'mavericks', 'bucks', 'sixers', '76ers', 'raptors',
      'nuggets', 'grizzlies', 'pelicans', 'spurs', 'rockets', 'timberwolves',
      'thunder', 'blazers', 'jazz', 'kings', 'magic', 'pistons', 'pacers',
      'hornets', 'hawks', 'cavaliers', 'wizards',

      // Soccer/Football (international clubs & leagues)
      'fútbol', 'futbol', ' fc', 'ac milan', 'inter milan', 'as roma',
      'arsenal', 'chelsea', 'liverpool', 'manchester', 'tottenham',
      'real madrid', 'barcelona', 'atletico', 'real sociedad', 'sevilla',
      'juventus', 'napoli', 'lazio', 'fiorentina', 'lecce',
      'bayern', 'borussia', 'leverkusen', 'leipzig',
      'psg', 'marseille', 'lyon', 'olympique', 'stade', 'brestois',
      'ajax', 'psv', 'feyenoord', 'benfica', 'porto', 'sporting',
      'la liga', 'premier league', 'serie a', 'bundesliga', 'ligue 1',
      'eredivisie', 'primeira liga', 'uefa', 'fifa',

      // Esports games
      'call of duty', 'league of legends', 'counter-strike', 'cs2', 'csgo',
      'dota', 'valorant', 'overwatch', 'fortnite', 'pubg', 'apex legends',
      'rainbow six', 'rocket league', 'halo', 'starcraft',
      'lol:', 'lol ', // LoL shorthand

      // Common esports teams/orgs
      'natus vincere', 'navi', 'faze', 'g2', 'team liquid', 'fnatic',
      'cloud9', 'tsm', '100 thieves', 'sentinels', 'optic',
      'karmine', 'movistar', 'koi',
    ];

    const allMarkets = await this.getTrackedMarkets();

    return allMarkets
      .filter(m => {
        // Must be closing within maxMinutes and not already closed
        if (m.timeToCloseMinutes > maxMinutes || m.timeToCloseMinutes <= 0) return false;

        // Check category and tags against exclusions
        const categoryLower = m.category?.toLowerCase() || '';
        const tagsLower = m.tags.map(t => t.toLowerCase());
        const questionLower = m.question.toLowerCase();

        const isExcluded = exclusions.some(exc =>
          categoryLower.includes(exc) ||
          tagsLower.some(tag => tag.includes(exc)) ||
          questionLower.includes(exc)
        );

        return !isExcluded;
      })
      .slice(0, limit);
  }
}

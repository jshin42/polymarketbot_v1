import { Pool } from 'pg';
import { Redis, createLogger } from '@polymarketbot/shared';
import {
  pointBiserialCorrelation,
  bootstrapCI,
  benjaminiHochberg,
  calculateAUC,
  calibrationCurve,
  logisticRegression,
  type CorrelationResult,
  type LogisticModel,
  type CalibrationPoint,
} from './statistics.service.js';

// =============================================================================
// Enhanced Analysis Service - 30D Contrarian Research Analysis
// =============================================================================

const logger = createLogger('analysis-service');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ContrarianMode = 'price_only' | 'vs_trend' | 'vs_ofi' | 'vs_both';

export interface AnalysisConfig {
  lookbackDays: number;
  minSizeUsd: number;
  windowMinutes: number;
  contrarianMode: ContrarianMode;
  requireAsymmetricBook: boolean;
  requireNewWallet: boolean;
  maxWalletAgeDays: number;
  maxSpreadBps: number;
  minDepthUsd: number;
  categories: string[];
  resolvedOnly: boolean;
}

export interface ContrarianEvent {
  id: number;
  conditionId: string;
  tokenId: string;
  tradeTimestamp: Date;
  minutesBeforeClose: number;
  tradeSide: string;
  tradePrice: number;
  tradeSize: number;
  tradeNotional: number;
  takerAddress: string | null;
  sizePercentile: number | null;
  sizeZScore: number | null;
  isTailTrade: boolean;
  isPriceContrarian: boolean;
  priceTrend30m: number | null;
  isAgainstTrend: boolean;
  ofi30m: number | null;
  isAgainstOfi: boolean;
  isContrarian: boolean;
  bookImbalance: number | null;
  thinOppositeRatio: number | null;
  spreadBps: number | null;
  isAsymmetricBook: boolean;
  walletAgeDays: number | null;
  walletTradeCount: number | null;
  isNewWallet: boolean;
  tradedOutcome: string;
  outcomeWon: boolean | null;
  drift30m: number | null;
  drift60m: number | null;
  question?: string;
  category?: string;
  slug?: string;
}

export interface EvaluationMetrics {
  n: number;
  winRate: number;
  correlation: number;
  pValue: number;
  ci: [number, number];
  auc?: number;
}

export interface BreakdownRow {
  label: string;
  n: number;
  winRate: number;
  lift: number;
  ci: [number, number];
}

export interface RollingDataPoint {
  date: string;
  correlation: number;
  winRate: number;
  sampleSize: number;
  ciLower: number;
  ciUpper: number;
}

export interface CorrelationSummary {
  totalMarkets: number;
  marketsWithSignals: number;
  totalEvents: number;
  signalWinRate: number;
  baselineWinRate: number;
  correlation: number;
  pValue: number;
  confidenceInterval: [number, number];
  lift: number;
  lookbackDays: number;
  minSizeUsd: number;
  windowMinutes: number;
  contrarianMode: ContrarianMode;
  auc?: number;
  timeSplit?: {
    train: EvaluationMetrics;
    validate: EvaluationMetrics;
    test: EvaluationMetrics;
  };
}

export interface BackfillStatus {
  isRunning: boolean;
  lastRunAt: Date | null;
  jobId: number | null;
  status: string | null;
  itemsProcessed: number;
  itemsTotal: number | null;
  errorMessage: string | null;
}

export interface ModelReport {
  coefficients: Record<string, number>;
  featureImportance: Record<string, number>;
  trainAuc: number;
  validateAuc: number;
  testAuc: number;
  calibrationCurve: CalibrationPoint[];
}

export interface ContrarianSignal {
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  price: number;
  sizeUsd: number;
  timestamp: Date;
  minutesBeforeClose: number;
  closeDate: Date;
  result: 'won' | 'lost' | 'pending';
  polymarketUrl: string | null;
  isContrarian: boolean;
  isPriceContrarian: boolean;
  isAgainstTrend: boolean;
  isAgainstOfi: boolean;
  isAsymmetricBook: boolean;
  isNewWallet: boolean;
  sizePercentile: number | null;
}

const DEFAULT_CONFIG: AnalysisConfig = {
  lookbackDays: 30,
  minSizeUsd: 1000,
  windowMinutes: 60,
  contrarianMode: 'vs_both',
  requireAsymmetricBook: false,
  requireNewWallet: false,
  maxWalletAgeDays: 7,
  maxSpreadBps: 500,
  minDepthUsd: 100,
  categories: [],
  resolvedOnly: true,
};

// -----------------------------------------------------------------------------
// Analysis Service Class
// -----------------------------------------------------------------------------

export class AnalysisService {
  private readonly redis: Redis;
  private readonly pg: Pool | null;

  constructor(redis: Redis, pg?: Pool) {
    this.redis = redis;
    this.pg = pg ?? null;
  }

  /**
   * Get correlation summary for contrarian betting analysis
   */
  async getCorrelationSummary(
    config: Partial<AnalysisConfig> = {}
  ): Promise<CorrelationSummary> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      logger.warn('PostgreSQL not available, returning empty data');
      return this.getEmptySummary(cfg);
    }

    try {
      // Check if we have data in the new research tables
      const hasResearchData = await this.hasResearchData();

      if (!hasResearchData) {
        logger.info('No research data available, returning empty summary');
        return this.getEmptySummary(cfg);
      }

      // Get contrarian events from the research tables
      const events = await this.getContrarianEventsFromDB(cfg);

      if (events.length === 0) {
        return this.getEmptySummary(cfg);
      }

      // Filter events based on config
      const filteredEvents = this.filterEvents(events, cfg);

      if (filteredEvents.length === 0) {
        return this.getEmptySummary(cfg);
      }

      // Get unique markets count
      const uniqueMarkets = new Set(filteredEvents.map(e => e.conditionId));
      const marketsWithSignals = uniqueMarkets.size;

      // Calculate correlation
      const predictor = filteredEvents.map(e => this.isContrarianByMode(e, cfg.contrarianMode));
      const outcome = filteredEvents.map(e => e.outcomeWon === true);

      const { r, pValue, ci } = pointBiserialCorrelation(predictor, outcome);

      // Calculate win rate for signal events
      const signalEvents = filteredEvents.filter((e, i) => predictor[i]);
      const signalWinRate = signalEvents.length > 0
        ? signalEvents.filter(e => e.outcomeWon === true).length / signalEvents.length
        : 0;

      const baselineWinRate = 0.5;
      const lift = baselineWinRate > 0 ? (signalWinRate - baselineWinRate) / baselineWinRate : 0;

      // Calculate AUC if we have enough data
      let auc: number | undefined;
      if (signalEvents.length >= 10) {
        const predictions = filteredEvents.map(e => {
          // Use contrarian features as prediction score
          let score = 0;
          if (e.isPriceContrarian) score += 0.25;
          if (e.isAgainstTrend) score += 0.25;
          if (e.isAgainstOfi) score += 0.25;
          if (e.isTailTrade) score += 0.25;
          return score;
        });
        auc = calculateAUC(predictions, outcome);
      }

      // Time-split evaluation
      const timeSplit = await this.computeTimeSplit(filteredEvents, cfg);

      // Get total markets from resolved_markets table
      const totalMarketsResult = await this.pg.query<{ count: string }>(`
        SELECT COUNT(*) as count FROM resolved_markets
        WHERE end_date > NOW() - INTERVAL '1 day' * $1
      `, [cfg.lookbackDays]);
      const totalMarkets = parseInt(totalMarketsResult.rows[0]?.count || '0', 10);

      return {
        totalMarkets,
        marketsWithSignals,
        totalEvents: filteredEvents.length,
        signalWinRate,
        baselineWinRate,
        correlation: r,
        pValue,
        confidenceInterval: ci,
        lift,
        lookbackDays: cfg.lookbackDays,
        minSizeUsd: cfg.minSizeUsd,
        windowMinutes: cfg.windowMinutes,
        contrarianMode: cfg.contrarianMode,
        auc,
        timeSplit,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to compute correlation summary');
      return this.getEmptySummary(cfg);
    }
  }

  /**
   * Get recent contrarian signals
   */
  async getContrarianSignals(
    config: Partial<AnalysisConfig> = {},
    limit: number = 20
  ): Promise<ContrarianSignal[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      logger.warn('PostgreSQL not available');
      return [];
    }

    try {
      const hasResearchData = await this.hasResearchData();

      if (!hasResearchData) {
        return [];
      }

      const result = await this.pg.query<{
        id: number;
        condition_id: string;
        token_id: string;
        trade_timestamp: Date;
        minutes_before_close: string;
        trade_price: string;
        trade_size: string;
        trade_notional: string;
        taker_address: string | null;
        size_percentile: string | null;
        is_price_contrarian: boolean;
        is_against_trend: boolean;
        is_against_ofi: boolean;
        is_contrarian: boolean;
        is_asymmetric_book: boolean;
        is_new_wallet: boolean;
        traded_outcome: string;
        outcome_won: boolean | null;
        question: string;
        slug: string | null;
        end_date: Date;
      }>(`
        SELECT
          ce.id,
          ce.condition_id,
          ce.token_id,
          ce.trade_timestamp,
          ce.minutes_before_close::text,
          ce.trade_price::text,
          ce.trade_size::text,
          ce.trade_notional::text,
          ce.taker_address,
          ce.size_percentile::text,
          ce.is_price_contrarian,
          ce.is_against_trend,
          ce.is_against_ofi,
          ce.is_contrarian,
          ce.is_asymmetric_book,
          ce.is_new_wallet,
          ce.traded_outcome,
          ce.outcome_won,
          rm.question,
          rm.slug,
          rm.end_date
        FROM contrarian_events ce
        JOIN resolved_markets rm ON ce.condition_id = rm.condition_id
        WHERE ce.trade_notional >= $1
          AND ce.minutes_before_close <= $2
        ORDER BY ce.trade_timestamp DESC
        LIMIT $3
      `, [cfg.minSizeUsd, cfg.windowMinutes, limit]);

      return result.rows.map(row => ({
        conditionId: row.condition_id,
        question: row.question,
        tokenId: row.token_id,
        outcome: row.traded_outcome,
        price: parseFloat(row.trade_price),
        sizeUsd: parseFloat(row.trade_notional),
        timestamp: row.trade_timestamp,
        minutesBeforeClose: parseFloat(row.minutes_before_close),
        closeDate: row.end_date,
        result: row.outcome_won === null ? 'pending' : (row.outcome_won ? 'won' : 'lost'),
        polymarketUrl: row.slug ? `https://polymarket.com/event/${row.slug}` : null,
        isContrarian: row.is_contrarian,
        isPriceContrarian: row.is_price_contrarian,
        isAgainstTrend: row.is_against_trend,
        isAgainstOfi: row.is_against_ofi,
        isAsymmetricBook: row.is_asymmetric_book,
        isNewWallet: row.is_new_wallet,
        sizePercentile: row.size_percentile ? parseFloat(row.size_percentile) : null,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get contrarian signals');
      return [];
    }
  }

  /**
   * Get rolling correlation data for charting
   */
  async getRollingCorrelation(
    config: Partial<AnalysisConfig> = {},
    windowDays: number = 7
  ): Promise<RollingDataPoint[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      logger.warn('PostgreSQL not available');
      return [];
    }

    try {
      const hasResearchData = await this.hasResearchData();

      if (!hasResearchData) {
        return [];
      }

      // Get all events
      const events = await this.getContrarianEventsFromDB(cfg);
      const filteredEvents = this.filterEvents(events, cfg);

      if (filteredEvents.length < 10) {
        return [];
      }

      // Sort by date
      filteredEvents.sort((a, b) => a.tradeTimestamp.getTime() - b.tradeTimestamp.getTime());

      const dataPoints: RollingDataPoint[] = [];
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - cfg.lookbackDays * 24 * 60 * 60 * 1000);

      // Generate rolling windows
      const current = new Date(startDate);
      current.setDate(current.getDate() + windowDays); // Start after first window

      while (current <= endDate) {
        const windowEnd = new Date(current);
        const windowStart = new Date(current.getTime() - windowDays * 24 * 60 * 60 * 1000);

        // Get events in this window
        const windowEvents = filteredEvents.filter(e =>
          e.tradeTimestamp >= windowStart && e.tradeTimestamp <= windowEnd
        );

        if (windowEvents.length >= 5) {
          const predictor = windowEvents.map(e => this.isContrarianByMode(e, cfg.contrarianMode));
          const outcome = windowEvents.map(e => e.outcomeWon === true);

          const { r, ci } = pointBiserialCorrelation(predictor, outcome);

          const signalEvents = windowEvents.filter((_, i) => predictor[i]);
          const winRate = signalEvents.length > 0
            ? signalEvents.filter(e => e.outcomeWon === true).length / signalEvents.length
            : 0.5;

          dataPoints.push({
            date: windowEnd.toISOString().split('T')[0],
            correlation: r,
            winRate,
            sampleSize: windowEvents.length,
            ciLower: ci[0],
            ciUpper: ci[1],
          });
        }

        current.setDate(current.getDate() + 1); // Daily rolling
      }

      return dataPoints;
    } catch (error) {
      logger.error({ error }, 'Failed to compute rolling correlation');
      return [];
    }
  }

  /**
   * Get contrarian events with pagination
   */
  async getContrarianEvents(
    config: Partial<AnalysisConfig> = {},
    limit: number = 50,
    offset: number = 0
  ): Promise<{ events: ContrarianEvent[]; total: number }> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      return { events: [], total: 0 };
    }

    try {
      // Build parameterized WHERE clause
      const params: (number | string | boolean)[] = [cfg.minSizeUsd, cfg.windowMinutes];
      const conditions: string[] = [
        `ce.trade_notional >= $1`,
        `ce.minutes_before_close <= $2`,
      ];

      if (cfg.requireAsymmetricBook) {
        conditions.push('ce.is_asymmetric_book = true');
      }

      if (cfg.requireNewWallet) {
        conditions.push('ce.is_new_wallet = true');
      }

      if (cfg.categories.length > 0) {
        const placeholders = cfg.categories.map((_, i) => `$${params.length + i + 1}`);
        params.push(...cfg.categories);
        conditions.push(`rm.category IN (${placeholders.join(',')})`);
      }

      const whereClause = conditions.join(' AND ');

      // Get total count
      const countResult = await this.pg.query<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM contrarian_events ce
        JOIN resolved_markets rm ON ce.condition_id = rm.condition_id
        WHERE ${whereClause}
      `, params);
      const total = parseInt(countResult.rows[0]?.count || '0', 10);

      // Get events - add limit/offset as next params
      const eventsParams = [...params, limit, offset];
      const result = await this.pg.query<{
        id: number;
        condition_id: string;
        token_id: string;
        trade_timestamp: Date;
        minutes_before_close: string;
        trade_side: string;
        trade_price: string;
        trade_size: string;
        trade_notional: string;
        taker_address: string | null;
        size_percentile: string | null;
        size_z_score: string | null;
        is_tail_trade: boolean;
        is_price_contrarian: boolean;
        price_trend_30m: string | null;
        is_against_trend: boolean;
        ofi_30m: string | null;
        is_against_ofi: boolean;
        is_contrarian: boolean;
        book_imbalance: string | null;
        thin_opposite_ratio: string | null;
        spread_bps: string | null;
        is_asymmetric_book: boolean;
        wallet_age_days: string | null;
        wallet_trade_count: number | null;
        is_new_wallet: boolean;
        traded_outcome: string;
        outcome_won: boolean | null;
        drift_30m: string | null;
        drift_60m: string | null;
        question: string;
        category: string | null;
        slug: string | null;
      }>(`
        SELECT
          ce.*,
          rm.question,
          rm.category,
          rm.slug
        FROM contrarian_events ce
        JOIN resolved_markets rm ON ce.condition_id = rm.condition_id
        WHERE ${whereClause}
        ORDER BY ce.trade_timestamp DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, eventsParams);

      const events: ContrarianEvent[] = result.rows.map(row => ({
        id: row.id,
        conditionId: row.condition_id,
        tokenId: row.token_id,
        tradeTimestamp: row.trade_timestamp,
        minutesBeforeClose: parseFloat(row.minutes_before_close),
        tradeSide: row.trade_side,
        tradePrice: parseFloat(row.trade_price),
        tradeSize: parseFloat(row.trade_size),
        tradeNotional: parseFloat(row.trade_notional),
        takerAddress: row.taker_address,
        sizePercentile: row.size_percentile ? parseFloat(row.size_percentile) : null,
        sizeZScore: row.size_z_score ? parseFloat(row.size_z_score) : null,
        isTailTrade: row.is_tail_trade,
        isPriceContrarian: row.is_price_contrarian,
        priceTrend30m: row.price_trend_30m ? parseFloat(row.price_trend_30m) : null,
        isAgainstTrend: row.is_against_trend,
        ofi30m: row.ofi_30m ? parseFloat(row.ofi_30m) : null,
        isAgainstOfi: row.is_against_ofi,
        isContrarian: row.is_contrarian,
        bookImbalance: row.book_imbalance ? parseFloat(row.book_imbalance) : null,
        thinOppositeRatio: row.thin_opposite_ratio ? parseFloat(row.thin_opposite_ratio) : null,
        spreadBps: row.spread_bps ? parseFloat(row.spread_bps) : null,
        isAsymmetricBook: row.is_asymmetric_book,
        walletAgeDays: row.wallet_age_days ? parseFloat(row.wallet_age_days) : null,
        walletTradeCount: row.wallet_trade_count,
        isNewWallet: row.is_new_wallet,
        tradedOutcome: row.traded_outcome,
        outcomeWon: row.outcome_won,
        drift30m: row.drift_30m ? parseFloat(row.drift_30m) : null,
        drift60m: row.drift_60m ? parseFloat(row.drift_60m) : null,
        question: row.question,
        category: row.category ?? undefined,
        slug: row.slug ?? undefined,
      }));

      return { events, total };
    } catch (error) {
      logger.error({ error }, 'Failed to get contrarian events');
      return { events: [], total: 0 };
    }
  }

  /**
   * Get breakdown by a specific factor
   */
  async getBreakdown(
    factor: 'liquidity' | 'time_to_close' | 'category' | 'new_wallet',
    config: Partial<AnalysisConfig> = {}
  ): Promise<BreakdownRow[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      return [];
    }

    try {
      const events = await this.getContrarianEventsFromDB(cfg);
      const filteredEvents = this.filterEvents(events, cfg);

      if (filteredEvents.length === 0) {
        return [];
      }

      const groups: Map<string, ContrarianEvent[]> = new Map();

      switch (factor) {
        case 'liquidity':
          // Group by spread deciles
          const spreads = filteredEvents
            .filter(e => e.spreadBps !== null)
            .map(e => e.spreadBps!);
          if (spreads.length > 0) {
            spreads.sort((a, b) => a - b);
            const decileSize = Math.ceil(spreads.length / 10);
            for (const event of filteredEvents) {
              if (event.spreadBps !== null) {
                const decile = Math.min(9, Math.floor(spreads.indexOf(event.spreadBps) / decileSize));
                const label = `Decile ${decile + 1}`;
                if (!groups.has(label)) groups.set(label, []);
                groups.get(label)!.push(event);
              }
            }
          }
          break;

        case 'time_to_close':
          // Group by time buckets
          for (const event of filteredEvents) {
            let label: string;
            if (event.minutesBeforeClose <= 15) label = '0-15 min';
            else if (event.minutesBeforeClose <= 30) label = '15-30 min';
            else if (event.minutesBeforeClose <= 60) label = '30-60 min';
            else label = '60+ min';
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(event);
          }
          break;

        case 'category':
          // Group by category
          for (const event of filteredEvents) {
            const label = event.category || 'Unknown';
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(event);
          }
          break;

        case 'new_wallet':
          // Group by wallet age
          for (const event of filteredEvents) {
            const label = event.isNewWallet ? 'New Wallet (<7d)' : 'Established Wallet';
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(event);
          }
          break;
      }

      const baselineWinRate = 0.5;
      const breakdowns: BreakdownRow[] = [];

      for (const [label, groupEvents] of groups) {
        if (groupEvents.length < 3) continue;

        const wins = groupEvents.filter(e => e.outcomeWon === true).length;
        const winRate = wins / groupEvents.length;
        const lift = (winRate - baselineWinRate) / baselineWinRate;

        // Bootstrap CI for win rate
        const outcomes = groupEvents.map(e => e.outcomeWon === true ? 1 : 0);
        const ci = bootstrapCI(outcomes, arr => arr.reduce((a, b) => a + b, 0) / arr.length);

        breakdowns.push({
          label,
          n: groupEvents.length,
          winRate,
          lift,
          ci: ci as [number, number],
        });
      }

      // Sort by lift descending
      breakdowns.sort((a, b) => b.lift - a.lift);

      return breakdowns;
    } catch (error) {
      logger.error({ error }, 'Failed to compute breakdown');
      return [];
    }
  }

  /**
   * Get logistic regression model report
   */
  async getModelReport(config: Partial<AnalysisConfig> = {}): Promise<ModelReport | null> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (!this.pg) {
      return null;
    }

    try {
      const events = await this.getContrarianEventsFromDB(cfg);
      const filteredEvents = this.filterEvents(events, cfg);

      if (filteredEvents.length < 50) {
        return null;
      }

      // Build feature matrix
      const featureNames = [
        'is_price_contrarian',
        'is_against_trend',
        'is_against_ofi',
        'is_tail_trade',
        'is_asymmetric_book',
        'is_new_wallet',
        'size_percentile',
        'minutes_before_close',
      ];

      const X: number[][] = filteredEvents.map(e => [
        e.isPriceContrarian ? 1 : 0,
        e.isAgainstTrend ? 1 : 0,
        e.isAgainstOfi ? 1 : 0,
        e.isTailTrade ? 1 : 0,
        e.isAsymmetricBook ? 1 : 0,
        e.isNewWallet ? 1 : 0,
        (e.sizePercentile ?? 50) / 100,
        Math.min(e.minutesBeforeClose, 120) / 120,
      ]);

      const y = filteredEvents.map(e => e.outcomeWon === true);

      // Time-based split
      const sortedIndices = [...Array(filteredEvents.length).keys()].sort(
        (a, b) => filteredEvents[a].tradeTimestamp.getTime() - filteredEvents[b].tradeTimestamp.getTime()
      );

      const trainEnd = Math.floor(sortedIndices.length * 0.6);
      const validateEnd = Math.floor(sortedIndices.length * 0.8);

      const trainIndices = sortedIndices.slice(0, trainEnd);
      const validateIndices = sortedIndices.slice(trainEnd, validateEnd);
      const testIndices = sortedIndices.slice(validateEnd);

      // Train model on training set
      const XTrain = trainIndices.map(i => X[i]);
      const yTrain = trainIndices.map(i => y[i]);

      const model = logisticRegression(XTrain, yTrain, {
        learningRate: 0.1,
        iterations: 1000,
        lambda: 0.01,
      });

      // Compute predictions for each set
      const predict = (X: number[][]): number[] => {
        return X.map(row => {
          let z = model.intercept;
          for (let j = 0; j < row.length; j++) {
            z += model.coefficients[j] * row[j];
          }
          return 1 / (1 + Math.exp(-z));
        });
      };

      const trainPred = predict(XTrain);
      const validatePred = predict(validateIndices.map(i => X[i]));
      const testPred = predict(testIndices.map(i => X[i]));

      const trainAuc = calculateAUC(trainPred, yTrain);
      const validateAuc = calculateAUC(validatePred, validateIndices.map(i => y[i]));
      const testAuc = calculateAUC(testPred, testIndices.map(i => y[i]));

      // Build coefficients map
      const coefficients: Record<string, number> = {
        intercept: model.intercept,
      };
      for (let i = 0; i < featureNames.length; i++) {
        coefficients[featureNames[i]] = model.coefficients[i];
      }

      // Feature importance (absolute coefficient values normalized)
      const absCoeffs = model.coefficients.map(Math.abs);
      const totalAbs = absCoeffs.reduce((a, b) => a + b, 0) || 1;
      const featureImportance: Record<string, number> = {};
      for (let i = 0; i < featureNames.length; i++) {
        featureImportance[featureNames[i]] = absCoeffs[i] / totalAbs;
      }

      // Calibration curve on test set
      const calibrationData = calibrationCurve(testPred, testIndices.map(i => y[i]), 10);

      return {
        coefficients,
        featureImportance,
        trainAuc,
        validateAuc,
        testAuc,
        calibrationCurve: calibrationData,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to generate model report');
      return null;
    }
  }

  /**
   * Get backfill status
   */
  async getBackfillStatus(): Promise<BackfillStatus> {
    if (!this.pg) {
      return {
        isRunning: false,
        lastRunAt: null,
        jobId: null,
        status: null,
        itemsProcessed: 0,
        itemsTotal: null,
        errorMessage: null,
      };
    }

    try {
      const result = await this.pg.query<{
        id: number;
        status: string;
        started_at: Date | null;
        completed_at: Date | null;
        items_processed: number;
        items_total: number | null;
        error_message: string | null;
      }>(`
        SELECT id, status, started_at, completed_at, items_processed, items_total, error_message
        FROM backfill_jobs
        ORDER BY created_at DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return {
          isRunning: false,
          lastRunAt: null,
          jobId: null,
          status: null,
          itemsProcessed: 0,
          itemsTotal: null,
          errorMessage: null,
        };
      }

      const job = result.rows[0];
      return {
        isRunning: job.status === 'running',
        lastRunAt: job.completed_at ?? job.started_at,
        jobId: job.id,
        status: job.status,
        itemsProcessed: job.items_processed,
        itemsTotal: job.items_total,
        errorMessage: job.error_message,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get backfill status');
      return {
        isRunning: false,
        lastRunAt: null,
        jobId: null,
        status: 'error',
        itemsProcessed: 0,
        itemsTotal: null,
        errorMessage: String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  private async hasResearchData(): Promise<boolean> {
    if (!this.pg) return false;

    try {
      const result = await this.pg.query<{ exists: boolean }>(`
        SELECT EXISTS(SELECT 1 FROM resolved_markets LIMIT 1) as exists
      `);
      return result.rows[0]?.exists ?? false;
    } catch {
      return false;
    }
  }

  private async getContrarianEventsFromDB(cfg: AnalysisConfig): Promise<ContrarianEvent[]> {
    if (!this.pg) return [];

    const result = await this.pg.query<{
      id: number;
      condition_id: string;
      token_id: string;
      trade_timestamp: Date;
      minutes_before_close: string;
      trade_side: string;
      trade_price: string;
      trade_size: string;
      trade_notional: string;
      taker_address: string | null;
      size_percentile: string | null;
      size_z_score: string | null;
      is_tail_trade: boolean;
      is_price_contrarian: boolean;
      price_trend_30m: string | null;
      is_against_trend: boolean;
      ofi_30m: string | null;
      is_against_ofi: boolean;
      is_contrarian: boolean;
      book_imbalance: string | null;
      thin_opposite_ratio: string | null;
      spread_bps: string | null;
      is_asymmetric_book: boolean;
      wallet_age_days: string | null;
      wallet_trade_count: number | null;
      is_new_wallet: boolean;
      traded_outcome: string;
      outcome_won: boolean | null;
      drift_30m: string | null;
      drift_60m: string | null;
      question: string;
      category: string | null;
      slug: string | null;
    }>(`
      SELECT
        ce.*,
        rm.question,
        rm.category,
        rm.slug
      FROM contrarian_events ce
      JOIN resolved_markets rm ON ce.condition_id = rm.condition_id
      WHERE rm.end_date > NOW() - INTERVAL '1 day' * $1
        AND ce.minutes_before_close <= $2
        AND ce.trade_notional >= $3
      ORDER BY ce.trade_timestamp DESC
    `, [cfg.lookbackDays, cfg.windowMinutes, cfg.minSizeUsd]);

    return result.rows.map(row => ({
      id: row.id,
      conditionId: row.condition_id,
      tokenId: row.token_id,
      tradeTimestamp: row.trade_timestamp,
      minutesBeforeClose: parseFloat(row.minutes_before_close),
      tradeSide: row.trade_side,
      tradePrice: parseFloat(row.trade_price),
      tradeSize: parseFloat(row.trade_size),
      tradeNotional: parseFloat(row.trade_notional),
      takerAddress: row.taker_address,
      sizePercentile: row.size_percentile ? parseFloat(row.size_percentile) : null,
      sizeZScore: row.size_z_score ? parseFloat(row.size_z_score) : null,
      isTailTrade: row.is_tail_trade,
      isPriceContrarian: row.is_price_contrarian,
      priceTrend30m: row.price_trend_30m ? parseFloat(row.price_trend_30m) : null,
      isAgainstTrend: row.is_against_trend,
      ofi30m: row.ofi_30m ? parseFloat(row.ofi_30m) : null,
      isAgainstOfi: row.is_against_ofi,
      isContrarian: row.is_contrarian,
      bookImbalance: row.book_imbalance ? parseFloat(row.book_imbalance) : null,
      thinOppositeRatio: row.thin_opposite_ratio ? parseFloat(row.thin_opposite_ratio) : null,
      spreadBps: row.spread_bps ? parseFloat(row.spread_bps) : null,
      isAsymmetricBook: row.is_asymmetric_book,
      walletAgeDays: row.wallet_age_days ? parseFloat(row.wallet_age_days) : null,
      walletTradeCount: row.wallet_trade_count,
      isNewWallet: row.is_new_wallet,
      tradedOutcome: row.traded_outcome,
      outcomeWon: row.outcome_won,
      drift30m: row.drift_30m ? parseFloat(row.drift_30m) : null,
      drift60m: row.drift_60m ? parseFloat(row.drift_60m) : null,
      question: row.question,
      category: row.category ?? undefined,
      slug: row.slug ?? undefined,
    }));
  }

  private filterEvents(events: ContrarianEvent[], cfg: AnalysisConfig): ContrarianEvent[] {
    return events.filter(e => {
      // Apply category filter
      if (cfg.categories.length > 0 && !cfg.categories.includes(e.category || '')) {
        return false;
      }

      // Apply asymmetric book filter
      if (cfg.requireAsymmetricBook && !e.isAsymmetricBook) {
        return false;
      }

      // Apply new wallet filter
      if (cfg.requireNewWallet && !e.isNewWallet) {
        return false;
      }

      // Apply spread filter
      if (cfg.maxSpreadBps > 0 && e.spreadBps !== null && e.spreadBps > cfg.maxSpreadBps) {
        return false;
      }

      return true;
    });
  }

  private isContrarianByMode(event: ContrarianEvent, mode: ContrarianMode): boolean {
    switch (mode) {
      case 'price_only':
        return event.isPriceContrarian;
      case 'vs_trend':
        return event.isAgainstTrend;
      case 'vs_ofi':
        return event.isAgainstOfi;
      case 'vs_both':
        return event.isContrarian; // Both trend AND OFI
      default:
        return event.isContrarian;
    }
  }

  private async computeTimeSplit(
    events: ContrarianEvent[],
    cfg: AnalysisConfig
  ): Promise<{ train: EvaluationMetrics; validate: EvaluationMetrics; test: EvaluationMetrics } | undefined> {
    if (events.length < 30) {
      return undefined;
    }

    // Sort by timestamp
    const sorted = [...events].sort((a, b) => a.tradeTimestamp.getTime() - b.tradeTimestamp.getTime());

    // Split 60/20/20
    const trainEnd = Math.floor(sorted.length * 0.6);
    const validateEnd = Math.floor(sorted.length * 0.8);

    const trainEvents = sorted.slice(0, trainEnd);
    const validateEvents = sorted.slice(trainEnd, validateEnd);
    const testEvents = sorted.slice(validateEnd);

    const computeMetrics = (evts: ContrarianEvent[]): EvaluationMetrics => {
      if (evts.length === 0) {
        return { n: 0, winRate: 0, correlation: 0, pValue: 1, ci: [0, 0] };
      }

      const predictor = evts.map(e => this.isContrarianByMode(e, cfg.contrarianMode));
      const outcome = evts.map(e => e.outcomeWon === true);

      const { r, pValue, ci } = pointBiserialCorrelation(predictor, outcome);

      const signalEvents = evts.filter((_, i) => predictor[i]);
      const winRate = signalEvents.length > 0
        ? signalEvents.filter(e => e.outcomeWon === true).length / signalEvents.length
        : 0;

      let auc: number | undefined;
      if (signalEvents.length >= 5) {
        const scores = evts.map(e => {
          let score = 0;
          if (e.isPriceContrarian) score += 0.25;
          if (e.isAgainstTrend) score += 0.25;
          if (e.isAgainstOfi) score += 0.25;
          if (e.isTailTrade) score += 0.25;
          return score;
        });
        auc = calculateAUC(scores, outcome);
      }

      return { n: evts.length, winRate, correlation: r, pValue, ci, auc };
    };

    return {
      train: computeMetrics(trainEvents),
      validate: computeMetrics(validateEvents),
      test: computeMetrics(testEvents),
    };
  }

  private getEmptySummary(cfg: AnalysisConfig): CorrelationSummary {
    return {
      totalMarkets: 0,
      marketsWithSignals: 0,
      totalEvents: 0,
      signalWinRate: 0,
      baselineWinRate: 0.5,
      correlation: 0,
      pValue: 1,
      confidenceInterval: [0, 0],
      lift: 0,
      lookbackDays: cfg.lookbackDays,
      minSizeUsd: cfg.minSizeUsd,
      windowMinutes: cfg.windowMinutes,
      contrarianMode: cfg.contrarianMode,
    };
  }
}

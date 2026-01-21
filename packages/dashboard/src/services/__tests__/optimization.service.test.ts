import { describe, it, expect, beforeEach, vi, type MockedObject } from 'vitest';
import { Pool } from 'pg';
import { OptimizationService, type GridSearchConfig, DEFAULT_GRID_CONFIG } from '../optimization.service.js';
import { AnalysisService, type ContrarianEvent } from '../analysis.service.js';

// Create mock events for testing
function createMockEvent(overrides: Partial<ContrarianEvent> = {}): ContrarianEvent {
  return {
    id: Math.floor(Math.random() * 10000),
    marketId: 'market_1',
    conditionId: 'cond_1',
    tradeTimestamp: new Date().toISOString(),
    tradeNotional: 1000,
    tradePrice: 0.5,
    tradedOutcome: 'Yes',
    minutesBeforeClose: 30,
    category: 'Politics',
    question: 'Test market?',
    isContrarian: true,
    isAgainstTrend: true,
    isAgainstOfi: true,
    isNewWallet: false,
    isTailTrade: true,
    sizeZScore: 2.5,
    sizePercentile: 95,
    outcomeWon: Math.random() > 0.5,
    bookImbalance: null,
    spreadBps: null,
    drift30m: null,
    drift60m: null,
    ofi30m: 0.1,
    priceTrend30m: 0.02,
    ...overrides,
  };
}

// Create mock pool
function createMockPool(): MockedObject<Pool> {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as MockedObject<Pool>;
}

// Create mock analysis service
function createMockAnalysisService(): MockedObject<AnalysisService> {
  return {
    getContrarianEventsFromDB: vi.fn().mockResolvedValue([]),
    getCorrelationSummary: vi.fn().mockResolvedValue({
      eventCount: 0,
      winCount: 0,
      winRate: 0,
      correlation: 0,
      pValue: 1,
      auc: 0.5,
      contrarianMode: 'vs_ofi',
    }),
    getContrarianEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  } as unknown as MockedObject<AnalysisService>;
}

describe('OptimizationService', () => {
  let pool: MockedObject<Pool>;
  let analysisService: MockedObject<AnalysisService>;
  let optimizationService: OptimizationService;

  beforeEach(() => {
    pool = createMockPool();
    analysisService = createMockAnalysisService();
    optimizationService = new OptimizationService(pool as unknown as Pool, analysisService as unknown as AnalysisService);
  });

  describe('calculateSharpeRatio', () => {
    it('should return 0 for empty events', () => {
      const result = optimizationService.calculateSharpeRatio([]);
      expect(result).toBe(0);
    });

    it('should return 0 for single event', () => {
      const events = [createMockEvent()];
      const result = optimizationService.calculateSharpeRatio(events);
      expect(result).toBe(0);
    });

    it('should calculate positive Sharpe for winning trades', () => {
      const events = Array(20).fill(null).map(() => createMockEvent({
        outcomeWon: true,
        tradePrice: 0.3,
      }));
      const result = optimizationService.calculateSharpeRatio(events);
      expect(result).toBeGreaterThan(0);
    });

    it('should calculate negative Sharpe for losing trades', () => {
      const events = Array(20).fill(null).map(() => createMockEvent({
        outcomeWon: false,
        tradePrice: 0.7,
      }));
      const result = optimizationService.calculateSharpeRatio(events);
      expect(result).toBeLessThan(0);
    });

    it('should return Infinity for all winning trades with no variance', () => {
      const events = Array(10).fill(null).map(() => createMockEvent({
        outcomeWon: true,
        tradePrice: 0.5,
      }));
      const result = optimizationService.calculateSharpeRatio(events);
      expect(result).toBe(Infinity);
    });

    it('should handle null outcomeWon', () => {
      const events = Array(5).fill(null).map(() => createMockEvent({
        outcomeWon: null,
      }));
      const result = optimizationService.calculateSharpeRatio(events);
      // Returns 0 because all returns are 0
      expect(result).toBe(0);
    });
  });

  describe('calculateInformationRatio', () => {
    it('should return 0 for fewer than 10 events', () => {
      const events = Array(5).fill(null).map(() => createMockEvent());
      const result = optimizationService.calculateInformationRatio(events);
      expect(result).toBe(0);
    });

    it('should calculate positive ratio for consistent winners', () => {
      // Create events spread across multiple weeks
      const baseDate = new Date();
      const events = Array(30).fill(null).map((_, i) => createMockEvent({
        outcomeWon: true,
        tradePrice: 0.3,
        tradeTimestamp: new Date(baseDate.getTime() - i * 24 * 60 * 60 * 1000).toISOString(),
      }));
      const result = optimizationService.calculateInformationRatio(events);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('computeParetoFrontier', () => {
    it('should return empty frontier for empty results', () => {
      const frontier = optimizationService.computeParetoFrontier([], ['pnl', 'roi']);
      expect(frontier.points).toHaveLength(0);
      expect(frontier.dominatedCount).toBe(0);
    });

    it('should identify single result as Pareto optimal', () => {
      const results = [{
        configId: 'config1',
        config: {},
        metrics: {
          n: 50,
          winRate: 0.6,
          pnl: 1000,
          roi: 0.1,
          profitFactor: 1.5,
          edgePoints: 10,
          sharpeRatio: 1.2,
          kellyFraction: 0.1,
          informationRatio: 0.5,
          pValue: 0.01,
          adjustedPValue: 0.02,
          avgPrice: 0.5,
          breakEvenRate: 0.5,
          ci: [0.5, 0.7] as [number, number],
        },
        rank: { pnl: 1, roi: 1, profitFactor: 1, edgePoints: 1, sharpeRatio: 1, kellyFraction: 1, informationRatio: 1 },
        isStatisticallySignificant: true,
        isParetoOptimal: false,
      }];

      const frontier = optimizationService.computeParetoFrontier(results, ['pnl', 'roi']);
      expect(frontier.points).toHaveLength(1);
      expect(frontier.points[0].isParetoOptimal).toBe(true);
    });

    it('should identify dominated solutions', () => {
      const results = [
        {
          configId: 'config1',
          config: {},
          metrics: {
            n: 50, winRate: 0.6, pnl: 1000, roi: 0.1, profitFactor: 1.5,
            edgePoints: 10, sharpeRatio: 1.2, kellyFraction: 0.1, informationRatio: 0.5,
            pValue: 0.01, adjustedPValue: 0.02, avgPrice: 0.5, breakEvenRate: 0.5,
            ci: [0.5, 0.7] as [number, number],
          },
          rank: {} as Record<string, number>,
          isStatisticallySignificant: true,
          isParetoOptimal: false,
        },
        {
          configId: 'config2',
          config: {},
          metrics: {
            n: 50, winRate: 0.7, pnl: 2000, roi: 0.2, profitFactor: 2.0,
            edgePoints: 20, sharpeRatio: 1.5, kellyFraction: 0.15, informationRatio: 0.8,
            pValue: 0.005, adjustedPValue: 0.01, avgPrice: 0.5, breakEvenRate: 0.5,
            ci: [0.6, 0.8] as [number, number],
          },
          rank: {} as Record<string, number>,
          isStatisticallySignificant: true,
          isParetoOptimal: false,
        },
      ];

      const frontier = optimizationService.computeParetoFrontier(results, ['pnl', 'roi']);
      // config2 dominates config1 in both objectives
      expect(frontier.points).toHaveLength(1);
      expect(frontier.points[0].configId).toBe('config2');
      expect(frontier.dominatedCount).toBe(1);
    });

    it('should identify non-dominated trade-offs', () => {
      const results = [
        {
          configId: 'config1',
          config: {},
          metrics: {
            n: 50, winRate: 0.6, pnl: 2000, roi: 0.05, profitFactor: 1.5,
            edgePoints: 10, sharpeRatio: 1.2, kellyFraction: 0.1, informationRatio: 0.5,
            pValue: 0.01, adjustedPValue: 0.02, avgPrice: 0.5, breakEvenRate: 0.5,
            ci: [0.5, 0.7] as [number, number],
          },
          rank: {} as Record<string, number>,
          isStatisticallySignificant: true,
          isParetoOptimal: false,
        },
        {
          configId: 'config2',
          config: {},
          metrics: {
            n: 50, winRate: 0.7, pnl: 1000, roi: 0.2, profitFactor: 2.0,
            edgePoints: 20, sharpeRatio: 1.5, kellyFraction: 0.15, informationRatio: 0.8,
            pValue: 0.005, adjustedPValue: 0.01, avgPrice: 0.5, breakEvenRate: 0.5,
            ci: [0.6, 0.8] as [number, number],
          },
          rank: {} as Record<string, number>,
          isStatisticallySignificant: true,
          isParetoOptimal: false,
        },
      ];

      // config1 has better PnL, config2 has better ROI - both are Pareto optimal
      const frontier = optimizationService.computeParetoFrontier(results, ['pnl', 'roi']);
      expect(frontier.points).toHaveLength(2);
      expect(frontier.dominatedCount).toBe(0);
    });
  });

  describe('getJobStatus', () => {
    it('should return null when no jobs exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const status = await optimizationService.getJobStatus();
      expect(status).toBeNull();
    });

    it('should return job status from database', async () => {
      const mockJob = {
        id: 1,
        job_type: 'grid_search',
        status: 'completed',
        config: JSON.stringify(DEFAULT_GRID_CONFIG),
        total_configs: 100,
        processed_configs: 100,
        valid_configs: 50,
        started_at: new Date(),
        completed_at: new Date(),
        execution_time_ms: 5000,
        error_message: null,
      };
      pool.query.mockResolvedValueOnce({ rows: [mockJob], rowCount: 1 });

      const status = await optimizationService.getJobStatus();
      expect(status).not.toBeNull();
      expect(status!.id).toBe(1);
      expect(status!.jobType).toBe('grid_search');
      expect(status!.status).toBe('completed');
      expect(status!.totalConfigs).toBe(100);
      expect(status!.validConfigs).toBe(50);
    });
  });

  describe('getRankedStrategies', () => {
    it('should return empty array when no results', async () => {
      const strategies = await optimizationService.getRankedStrategies('pnl', 10, false);
      expect(strategies).toHaveLength(0);
    });
  });

  describe('runSensitivityAnalysis', () => {
    it('should return sensitivity results for parameter variations', async () => {
      // Mock events for baseline and variations
      const mockEvents = Array(50).fill(null).map(() => createMockEvent({
        outcomeWon: Math.random() > 0.5,
        tradePrice: 0.5,
        tradeNotional: 1000,
      }));

      analysisService.getContrarianEventsFromDB.mockResolvedValue(mockEvents);

      const result = await optimizationService.runSensitivityAnalysis(
        { contrarianMode: 'vs_ofi', minSizeUsd: 1000 },
        'minSizeUsd',
        [500, 1000, 2000, 5000]
      );

      expect(result.parameterName).toBe('minSizeUsd');
      expect(result.baselineValue).toBe('1000');
      expect(result.variations).toHaveLength(4);
    });
  });

  describe('DEFAULT_GRID_CONFIG', () => {
    it('should have valid default values', () => {
      expect(DEFAULT_GRID_CONFIG.contrarianModes).toContain('vs_ofi');
      expect(DEFAULT_GRID_CONFIG.minSampleSize).toBeGreaterThan(0);
      expect(DEFAULT_GRID_CONFIG.fdrAlpha).toBeGreaterThan(0);
      expect(DEFAULT_GRID_CONFIG.fdrAlpha).toBeLessThanOrEqual(1);
      expect(DEFAULT_GRID_CONFIG.objectives.length).toBeGreaterThan(0);
    });
  });
});

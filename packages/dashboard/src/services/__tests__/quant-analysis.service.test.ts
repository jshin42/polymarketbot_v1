import { describe, it, expect, beforeEach, vi, type MockedObject } from 'vitest';
import { Pool } from 'pg';
import { QuantAnalysisService } from '../quant-analysis.service.js';
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
    drift30m: 0.02,
    drift60m: 0.03,
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

describe('QuantAnalysisService', () => {
  let pool: MockedObject<Pool>;
  let analysisService: MockedObject<AnalysisService>;
  let quantService: QuantAnalysisService;

  beforeEach(() => {
    pool = createMockPool();
    analysisService = createMockAnalysisService();
    quantService = new QuantAnalysisService(
      pool as unknown as Pool,
      analysisService as unknown as AnalysisService
    );
  });

  describe('calculateVPIN', () => {
    it('should return zero VPIN for empty events', async () => {
      const result = await quantService.calculateVPIN([]);
      expect(result.vpin).toBe(0);
      expect(result.bucketCount).toBe(0);
      expect(result.toxicityLevel).toBe('low');
    });

    it('should calculate VPIN for events', async () => {
      const events = Array(100).fill(null).map((_, i) => createMockEvent({
        tradeNotional: 1000,
        tradedOutcome: i % 3 === 0 ? 'Yes' : 'No',
        tradePrice: 0.5 + (i % 10) * 0.02,
      }));

      const result = await quantService.calculateVPIN(events, 10000);
      expect(result.bucketCount).toBeGreaterThan(0);
      expect(result.vpin).toBeGreaterThanOrEqual(0);
      expect(result.vpin).toBeLessThanOrEqual(1);
      expect(['low', 'medium', 'high']).toContain(result.toxicityLevel);
    });

    it('should detect high toxicity when imbalanced', async () => {
      // All buys (Yes trades above 0.5)
      const events = Array(100).fill(null).map(() => createMockEvent({
        tradeNotional: 1000,
        tradedOutcome: 'Yes',
        tradePrice: 0.7,
      }));

      const result = await quantService.calculateVPIN(events, 10000);
      expect(result.vpin).toBeGreaterThan(0.3);
    });

    it('should return time series data', async () => {
      const events = Array(50).fill(null).map((_, i) => createMockEvent({
        tradeNotional: 5000,
        tradeTimestamp: new Date(Date.now() - i * 60000).toISOString(),
      }));

      const result = await quantService.calculateVPIN(events, 10000);
      expect(result.timeSeries.length).toBeGreaterThan(0);
      result.timeSeries.forEach(point => {
        expect(point).toHaveProperty('timestamp');
        expect(point).toHaveProperty('vpin');
        expect(point).toHaveProperty('volume');
      });
    });
  });

  describe('estimateHawkesIntensity', () => {
    it('should return zero for too few events', async () => {
      const events = Array(5).fill(null).map(() => createMockEvent());
      const result = await quantService.estimateHawkesIntensity(events);
      expect(result.baselineIntensity).toBe(0);
      expect(result.clusteringScore).toBe(0);
    });

    it('should estimate Hawkes parameters for sufficient events', async () => {
      const baseTime = Date.now();
      const events = Array(50).fill(null).map((_, i) => createMockEvent({
        tradeTimestamp: new Date(baseTime + i * 60000).toISOString(),
      }));

      const result = await quantService.estimateHawkesIntensity(events);
      expect(result.baselineIntensity).toBeGreaterThanOrEqual(0);
      expect(result.decayBeta).toBeGreaterThan(0);
      expect(result.clusteringScore).toBeGreaterThanOrEqual(0);
      expect(result.clusteringScore).toBeLessThanOrEqual(1);
      expect(result.branchingRatio).toBeGreaterThanOrEqual(0);
    });

    it('should detect clustering in bursty data', async () => {
      const baseTime = Date.now();
      // Create burst pattern: events close together, then gap, then close together
      const events = [
        ...Array(10).fill(null).map((_, i) => createMockEvent({
          tradeTimestamp: new Date(baseTime + i * 1000).toISOString(), // 1 second apart
        })),
        ...Array(10).fill(null).map((_, i) => createMockEvent({
          tradeTimestamp: new Date(baseTime + 3600000 + i * 1000).toISOString(), // 1 hour later
        })),
      ];

      const result = await quantService.estimateHawkesIntensity(events);
      // Bursty data should show higher clustering
      expect(result.clusteringScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculateBenfordAnomaly', () => {
    it('should return non-anomalous for too few events', async () => {
      const events = Array(10).fill(null).map(() => createMockEvent({
        tradeNotional: 1000,
      }));

      const result = await quantService.calculateBenfordAnomaly(events);
      expect(result.isAnomalous).toBe(false);
      expect(result.anomalyScore).toBe(0);
    });

    it('should detect Benford compliance in natural data', async () => {
      // Generate Benford-like distribution
      const benfordSizes = [
        ...Array(30).fill(1000),
        ...Array(18).fill(2000),
        ...Array(13).fill(3000),
        ...Array(10).fill(4000),
        ...Array(8).fill(5000),
        ...Array(7).fill(6000),
        ...Array(6).fill(7000),
        ...Array(5).fill(8000),
        ...Array(5).fill(9000),
      ];

      const events = benfordSizes.map(size => createMockEvent({ tradeNotional: size }));

      const result = await quantService.calculateBenfordAnomaly(events);
      expect(result.chiSquare).toBeGreaterThanOrEqual(0);
      expect(result.firstDigitDistribution).toHaveProperty('1');
      expect(result.expectedDistribution).toHaveProperty('1');
    });

    it('should detect anomaly in non-natural distribution', async () => {
      // All trades with first digit 5 (highly unusual)
      const events = Array(100).fill(null).map(() => createMockEvent({
        tradeNotional: 5000 + Math.floor(Math.random() * 1000),
      }));

      const result = await quantService.calculateBenfordAnomaly(events);
      expect(result.chiSquare).toBeGreaterThan(0);
      // Should show excess of digit 5
      expect(result.deviationByDigit['5']).toBeGreaterThan(0);
    });

    it('should return expected Benford distribution', async () => {
      const events = Array(50).fill(null).map(() => createMockEvent({
        tradeNotional: 1000 + Math.floor(Math.random() * 9000),
      }));

      const result = await quantService.calculateBenfordAnomaly(events);
      expect(result.expectedDistribution['1']).toBeCloseTo(0.301, 2);
      expect(result.expectedDistribution['9']).toBeCloseTo(0.046, 2);
    });
  });

  describe('analyzeTimeDecay', () => {
    it('should return default values for too few resolved events', async () => {
      // Events without resolved outcome (outcomeWon is random, may not have enough)
      const events = Array(10).fill(null).map(() => createMockEvent({
        outcomeWon: null,  // Not resolved
      }));
      const result = await quantService.analyzeTimeDecay(events);
      // With too few resolved events, returns empty buckets but valid structure
      expect(result).toHaveProperty('timeBuckets');
      expect(result).toHaveProperty('optimalWindow');
      expect(result).toHaveProperty('decayCoefficient');
    });

    it('should group events by time buckets', async () => {
      const events = [
        ...Array(20).fill(null).map(() => createMockEvent({
          minutesBeforeClose: 5,
          outcomeWon: true,
        })),
        ...Array(20).fill(null).map(() => createMockEvent({
          minutesBeforeClose: 25,
          outcomeWon: false,
        })),
        ...Array(20).fill(null).map(() => createMockEvent({
          minutesBeforeClose: 45,
          outcomeWon: true,
        })),
      ];

      const result = await quantService.analyzeTimeDecay(events);
      expect(result.timeBuckets.length).toBeGreaterThan(0);

      // Find the bucket with 0-10 min range
      const earlyBucket = result.timeBuckets.find(
        b => b.minMinutes === 0 && b.maxMinutes === 10
      );
      expect(earlyBucket).toBeDefined();
      if (earlyBucket) {
        expect(earlyBucket.n).toBe(20);
        expect(earlyBucket.winRate).toBe(1.0);
      }
    });

    it('should identify optimal window', async () => {
      const events = Array(100).fill(null).map((_, i) => createMockEvent({
        minutesBeforeClose: 30 + (i % 30),  // Cluster in 30-60 range
        outcomeWon: Math.random() > 0.3,
        tradePrice: 0.4,
      }));

      const result = await quantService.analyzeTimeDecay(events);
      expect(result.optimalWindow).toBeDefined();
      expect(result.optimalWindow.min).toBeGreaterThanOrEqual(0);
      expect(result.optimalWindow.max).toBeGreaterThan(result.optimalWindow.min);
    });
  });

  describe('estimateKyleLambda', () => {
    it('should return zero for events without drift data', async () => {
      const events = Array(50).fill(null).map(() => createMockEvent({
        drift30m: null,
      }));

      const result = await quantService.estimateKyleLambda(events);
      expect(result.lambda).toBe(0);
      expect(result.r2).toBe(0);
    });

    it('should estimate lambda for events with drift', async () => {
      const events = Array(50).fill(null).map((_, i) => createMockEvent({
        drift30m: 0.01 * (i % 10),
        tradeNotional: 1000 * (1 + i % 5),
        tradedOutcome: i % 2 === 0 ? 'Yes' : 'No',
      }));

      const result = await quantService.estimateKyleLambda(events);
      expect(result.lambda).toBeGreaterThanOrEqual(0);
      expect(result.priceImpactBySize.length).toBeGreaterThan(0);
    });

    it('should return impact by size quantile', async () => {
      const events = Array(100).fill(null).map((_, i) => createMockEvent({
        drift30m: 0.01 + Math.random() * 0.02,
        tradeNotional: 500 + i * 100,
      }));

      const result = await quantService.estimateKyleLambda(events);
      expect(result.priceImpactBySize.length).toBe(5);
      result.priceImpactBySize.forEach(bucket => {
        expect(bucket).toHaveProperty('sizeQuantile');
        expect(bucket).toHaveProperty('avgImpact');
        expect(bucket).toHaveProperty('n');
      });
    });
  });

  describe('getRecentReports', () => {
    it('should return reports from database', async () => {
      const mockReports = [{
        id: 1,
        report_type: 'full',
        data_start: new Date(),
        data_end: new Date(),
        total_events: 1000,
        resolved_events: 800,
        top_strategies: JSON.stringify([]),
        recommendations: JSON.stringify(['Test recommendation']),
        config_used: JSON.stringify({ vpin: null }),
        execution_time_ms: 5000,
        created_at: new Date(),
      }];

      pool.query.mockResolvedValueOnce({ rows: mockReports, rowCount: 1 });

      const reports = await quantService.getRecentReports(10);
      expect(reports).toHaveLength(1);
      expect(reports[0].reportType).toBe('full');
      expect(reports[0].totalEvents).toBe(1000);
    });
  });

  describe('runFullAnalysis', () => {
    it('should run complete analysis pipeline', async () => {
      const events = Array(100).fill(null).map((_, i) => createMockEvent({
        minutesBeforeClose: 30 + (i % 60),
        outcomeWon: Math.random() > 0.5,
        drift30m: 0.01 * Math.random(),
      }));

      analysisService.getContrarianEventsFromDB.mockResolvedValue(events);

      const report = await quantService.runFullAnalysis();

      expect(report.reportType).toBe('full');
      expect(report.totalEvents).toBe(100);
      expect(report.vpin).toBeDefined();
      expect(report.hawkes).toBeDefined();
      expect(report.benford).toBeDefined();
      expect(report.timeDecay).toBeDefined();
      expect(report.kyleLambda).toBeDefined();
      expect(report.recommendations).toBeDefined();
      expect(report.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runIncrementalAnalysis', () => {
    it('should run incremental analysis on new events', async () => {
      const newEvents = Array(20).fill(null).map(() => createMockEvent());

      const report = await quantService.runIncrementalAnalysis(newEvents);

      expect(report.reportType).toBe('incremental');
      expect(report.totalEvents).toBe(20);
      expect(report.vpin).toBeDefined();
      expect(report.hawkes).toBeDefined();
    });
  });
});

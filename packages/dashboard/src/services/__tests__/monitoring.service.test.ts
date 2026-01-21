import { describe, it, expect, beforeEach, vi, type MockedObject } from 'vitest';
import { Pool } from 'pg';
import { MonitoringService, type CUSUMResult, DEFAULT_MONITORING_CONFIG } from '../monitoring.service.js';
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
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
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

describe('MonitoringService', () => {
  let pool: MockedObject<Pool>;
  let analysisService: MockedObject<AnalysisService>;
  let monitoringService: MonitoringService;

  beforeEach(() => {
    pool = createMockPool();
    analysisService = createMockAnalysisService();
    monitoringService = new MonitoringService(
      pool as unknown as Pool,
      analysisService as unknown as AnalysisService
    );
  });

  describe('detectChangePoint (CUSUM)', () => {
    it('should return no change for empty values', () => {
      const result = monitoringService.detectChangePoint([]);
      expect(result.changeDetected).toBe(false);
      expect(result.changePointIndex).toBeNull();
    });

    it('should return no change for too few values', () => {
      const result = monitoringService.detectChangePoint([0.5, 0.5, 0.5]);
      expect(result.changeDetected).toBe(false);
    });

    it('should detect change point for sudden shift', () => {
      // Stable baseline then sudden increase
      const values = [
        ...Array(20).fill(0.3),  // Baseline
        ...Array(20).fill(0.7),  // Sudden shift up
      ];
      const result = monitoringService.detectChangePoint(values, 5.0, 0.1);
      expect(result.changeDetected).toBe(true);
      expect(result.changePointIndex).toBeGreaterThan(15);
      // Change point is detected after cumulative sum exceeds threshold, may be later in sequence
      expect(result.changePointIndex).toBeLessThan(40);
    });

    it('should not detect change for stable values', () => {
      const values = Array(40).fill(0.5);
      const result = monitoringService.detectChangePoint(values, 10.0, 0.5);
      expect(result.changeDetected).toBe(false);
    });

    it('should return correct CUSUM arrays', () => {
      const values = [0.5, 0.6, 0.7, 0.4, 0.5, 0.6, 0.7, 0.8, 0.5, 0.6];
      const result = monitoringService.detectChangePoint(values);
      expect(result.cumsumPositive).toHaveLength(values.length);
      expect(result.cumsumNegative).toHaveLength(values.length);
    });
  });

  describe('recalibrateKelly', () => {
    it('should keep baseline Kelly when sample size is low', () => {
      const baseline = { winRate: 0.55, kellyFraction: 0.1 };
      const current = { winRate: 0.7, n: 5 };  // n < minSampleSizeForAlert (20)

      const result = monitoringService.recalibrateKelly(baseline, current);
      expect(result).toBe(baseline.kellyFraction);
    });

    it('should adjust Kelly up when performance improves', () => {
      const baseline = { winRate: 0.55, kellyFraction: 0.1 };
      const current = { winRate: 0.65, n: 50 };

      const result = monitoringService.recalibrateKelly(baseline, current);
      // Should increase but be capped
      expect(result).toBeGreaterThan(0);
    });

    it('should adjust Kelly down when performance degrades', () => {
      const baseline = { winRate: 0.55, kellyFraction: 0.2 };
      const current = { winRate: 0.45, n: 50 };

      const result = monitoringService.recalibrateKelly(baseline, current);
      expect(result).toBeLessThanOrEqual(baseline.kellyFraction);
    });

    it('should not go negative', () => {
      const baseline = { winRate: 0.55, kellyFraction: 0.1 };
      const current = { winRate: 0.3, n: 50 };

      const result = monitoringService.recalibrateKelly(baseline, current);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should respect max adjustment constraint', () => {
      const baseline = { winRate: 0.5, kellyFraction: 0.1 };
      const current = { winRate: 0.9, n: 100 };

      const result = monitoringService.recalibrateKelly(baseline, current);
      // Should not exceed 150% of baseline (maxKellyAdjustment = 0.5)
      expect(result).toBeLessThanOrEqual(baseline.kellyFraction * 1.5);
    });
  });

  describe('startMonitoring', () => {
    it('should create monitored strategy with baseline metrics', async () => {
      const mockEvents = Array(50).fill(null).map((_, i) => createMockEvent({
        outcomeWon: i % 2 === 0,
        tradePrice: 0.5,
        tradeNotional: 1000,
      }));

      analysisService.getContrarianEventsFromDB.mockResolvedValue(mockEvents);
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const strategy = await monitoringService.startMonitoring(
        { contrarianMode: 'vs_ofi', minSizeUsd: 1000 },
        'Test Strategy',
        'A test strategy description'
      );

      expect(strategy.name).toBe('Test Strategy');
      expect(strategy.isActive).toBe(true);
      expect(strategy.isHealthy).toBe(true);
      expect(strategy.baselineSampleSize).toBe(50);
    });
  });

  describe('stopMonitoring', () => {
    it('should update strategy to inactive', async () => {
      await monitoringService.stopMonitoring('test_strategy_id');
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('is_active = false'),
        ['test_strategy_id']
      );
    });
  });

  describe('getMonitoredStrategies', () => {
    it('should return active strategies', async () => {
      const mockRows = [{
        id: 1,
        strategy_id: 'strat_1',
        name: 'Test Strategy',
        description: 'Test',
        config: JSON.stringify({ contrarianMode: 'vs_ofi' }),
        baseline_win_rate: '0.55',
        baseline_roi: '0.10',
        baseline_edge_points: '5.0',
        baseline_kelly: '0.1',
        baseline_sample_size: 100,
        baseline_date: new Date(),
        current_win_rate: '0.60',
        current_roi: '0.12',
        current_edge_points: '10.0',
        current_sample_size: 30,
        recommended_kelly: '0.12',
        is_active: true,
        is_healthy: true,
        last_check_at: new Date(),
        check_interval_minutes: 60,
      }];

      pool.query.mockResolvedValueOnce({ rows: mockRows, rowCount: 1 });

      const strategies = await monitoringService.getMonitoredStrategies(true);
      expect(strategies).toHaveLength(1);
      expect(strategies[0].strategyId).toBe('strat_1');
      expect(strategies[0].baselineWinRate).toBe(0.55);
    });
  });

  describe('getRecentAlerts', () => {
    it('should return alerts from database', async () => {
      const mockAlerts = [{
        id: 1,
        strategy_id: 'strat_1',
        alert_type: 'drift',
        metric: 'win_rate',
        expected_value: '0.55',
        observed_value: '0.45',
        deviation_sigma: '2.5',
        severity: 'warning',
        message: 'Win rate drifted',
        recommendation: 'Monitor closely',
        acknowledged: false,
        acknowledged_at: null,
        acknowledged_by: null,
        created_at: new Date(),
      }];

      pool.query.mockResolvedValueOnce({ rows: mockAlerts, rowCount: 1 });

      const alerts = await monitoringService.getRecentAlerts(10, undefined, false);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe('drift');
      expect(alerts[0].severity).toBe('warning');
    });
  });

  describe('acknowledgeAlert', () => {
    it('should update alert acknowledgment', async () => {
      await monitoringService.acknowledgeAlert(123, 'test_user');
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('acknowledged = true'),
        ['test_user', 123]
      );
    });
  });

  describe('DEFAULT_MONITORING_CONFIG', () => {
    it('should have valid default values', () => {
      expect(DEFAULT_MONITORING_CONFIG.warningSigma).toBeGreaterThan(0);
      expect(DEFAULT_MONITORING_CONFIG.criticalSigma).toBeGreaterThan(DEFAULT_MONITORING_CONFIG.warningSigma);
      expect(DEFAULT_MONITORING_CONFIG.cusumThreshold).toBeGreaterThan(0);
      expect(DEFAULT_MONITORING_CONFIG.minSampleSizeForAlert).toBeGreaterThan(0);
      expect(DEFAULT_MONITORING_CONFIG.defaultCheckIntervalMinutes).toBeGreaterThan(0);
    });
  });
});

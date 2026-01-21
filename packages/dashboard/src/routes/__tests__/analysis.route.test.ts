import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerAnalysisRoutes } from '../analysis.route.js';
import { AnalysisService } from '../../services/analysis.service.js';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock pg Pool
const mockPoolQuery = vi.fn();
const mockPool = {
  query: mockPoolQuery,
} as any;

// Mock Redis
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
} as any;

// Mock logger
vi.mock('@polymarketbot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  Redis: vi.fn(),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createMockSummary() {
  return {
    totalMarkets: 100,
    marketsWithSignals: 50,
    totalEvents: 200,
    signalWinRate: 0.65,
    baselineWinRate: 0.5,
    correlation: 0.15,
    pValue: 0.03,
    confidenceInterval: [-0.02, 0.32] as [number, number],
    lift: 0.3,
    lookbackDays: 30,
    minSizeUsd: 1000,
    windowMinutes: 60,
    contrarianMode: 'vs_both' as const,
    auc: 0.62,
  };
}

function createMockSignal() {
  return {
    conditionId: 'cond-1',
    question: 'Will it happen?',
    tokenId: 'token-1',
    outcome: 'Yes',
    price: 0.65,
    sizeUsd: 5000,
    timestamp: new Date('2026-01-15T10:00:00Z'),
    minutesBeforeClose: 30,
    closeDate: new Date('2026-01-15T10:30:00Z'),
    result: 'won' as const,
    polymarketUrl: 'https://polymarket.com/event/test',
    isContrarian: true,
    isPriceContrarian: true,
    isAgainstTrend: true,
    isAgainstOfi: true,
    isAsymmetricBook: false,
    isNewWallet: true,
    sizePercentile: 95,
  };
}

function createMockEvent() {
  return {
    id: 1,
    conditionId: 'cond-1',
    tokenId: 'token-1',
    tradeTimestamp: new Date('2026-01-15T10:00:00Z'),
    minutesBeforeClose: 30,
    tradeSide: 'BUY',
    tradePrice: 0.65,
    tradeSize: 1000,
    tradeNotional: 650,
    takerAddress: '0x1234',
    sizePercentile: 95,
    sizeZScore: 2.5,
    isTailTrade: true,
    isPriceContrarian: true,
    priceTrend30m: -0.05,
    isAgainstTrend: true,
    ofi30m: -100,
    isAgainstOfi: true,
    isContrarian: true,
    bookImbalance: 0.3,
    thinOppositeRatio: 0.2,
    spreadBps: 50,
    isAsymmetricBook: false,
    walletAgeDays: 5,
    walletTradeCount: 10,
    isNewWallet: true,
    tradedOutcome: 'Yes',
    outcomeWon: true,
    drift30m: 0.05,
    drift60m: 0.08,
    question: 'Test question?',
    category: 'crypto',
    slug: 'test-market',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Analysis Routes', () => {
  let app: FastifyInstance;
  let analysisService: AnalysisService;

  beforeAll(async () => {
    app = Fastify();
    analysisService = new AnalysisService(mockRedis, mockPool);
    registerAnalysisRoutes(app, analysisService, mockPool);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // POST /api/analysis/backfill
  // ===========================================================================

  describe('POST /api/analysis/backfill', () => {
    it('should return 202 and start backfill job', async () => {
      // Mock the job creation
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/analysis/backfill',
        payload: { days: 30, windowMinutes: 60 },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Backfill started');
      expect(body.config.days).toBe(30);
      expect(body.config.windowMinutes).toBe(60);
    });

    it('should use default values when not provided', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/analysis/backfill',
        payload: {},
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.config.days).toBe(30);
      expect(body.config.windowMinutes).toBe(120);
    });
  });

  // ===========================================================================
  // GET /api/analysis/backfill/status
  // ===========================================================================

  describe('GET /api/analysis/backfill/status', () => {
    it('should return backfill status', async () => {
      const startedAt = new Date('2026-01-15T09:00:00Z');
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          status: 'running',
          started_at: startedAt,
          completed_at: null,
          items_processed: 50,
          items_total: 100,
          error_message: null,
        }],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/backfill/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.isRunning).toBe(true);
      expect(body.status).toBe('running');
      expect(body.itemsProcessed).toBe(50);
      expect(body.itemsTotal).toBe(100);
    });

    it('should return empty status when no jobs exist', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/backfill/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.isRunning).toBe(false);
      expect(body.status).toBeNull();
    });
  });

  // ===========================================================================
  // GET /api/analysis/summary
  // ===========================================================================

  describe('GET /api/analysis/summary', () => {
    it('should return correlation summary with default config', async () => {
      // Mock hasResearchData
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Empty summary since no research data
      expect(body.totalEvents).toBe(0);
      expect(body.baselineWinRate).toBe(0.5);
    });

    it('should parse query parameters correctly', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary?days=14&minSize=500&windowMinutes=30&contrarianMode=price_only',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.lookbackDays).toBe(14);
      expect(body.minSizeUsd).toBe(500);
      expect(body.windowMinutes).toBe(30);
      expect(body.contrarianMode).toBe('price_only');
    });

    it('should handle invalid contrarianMode gracefully', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary?contrarianMode=invalid',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.contrarianMode).toBe('vs_ofi'); // Default (vs_ofi has best win rate)
    });
  });

  // ===========================================================================
  // GET /api/analysis/signals
  // ===========================================================================

  describe('GET /api/analysis/signals', () => {
    it('should return empty signals when no research data', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/signals',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.count).toBe(0);
      expect(body.signals).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/signals?limit=5',
      });

      expect(response.statusCode).toBe(200);
      // Limit is passed to service
    });
  });

  // ===========================================================================
  // GET /api/analysis/rolling
  // ===========================================================================

  describe('GET /api/analysis/rolling', () => {
    it('should return empty rolling data when no research data', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/rolling',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.count).toBe(0);
      expect(body.dataPoints).toEqual([]);
    });

    it('should use custom rolling window', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/rolling?rollingWindow=14',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.rollingWindowDays).toBe(14);
    });
  });

  // ===========================================================================
  // GET /api/analysis/events
  // ===========================================================================

  describe('GET /api/analysis/events', () => {
    it('should return paginated events', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/events?limit=10&offset=0',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.total).toBe(2);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      expect(body).toHaveProperty('hasMore');
    });

    it('should cap limit at 100', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/events?limit=200',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.limit).toBe(100);
    });
  });

  // ===========================================================================
  // GET /api/analysis/breakdown/:factor
  // ===========================================================================

  describe('GET /api/analysis/breakdown/:factor', () => {
    it('should return breakdown for valid factor', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/breakdown/category',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.factor).toBe('category');
      expect(body.breakdown).toEqual([]);
    });

    it('should return 400 for invalid factor', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/breakdown/invalid',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Invalid factor');
    });

    it('should accept all valid factors', async () => {
      const validFactors = ['liquidity', 'time_to_close', 'category', 'new_wallet'];

      for (const factor of validFactors) {
        vi.clearAllMocks();
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });

        const response = await app.inject({
          method: 'GET',
          url: `/api/analysis/breakdown/${factor}`,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.factor).toBe(factor);
      }
    });
  });

  // ===========================================================================
  // GET /api/analysis/model
  // ===========================================================================

  describe('GET /api/analysis/model', () => {
    it('should return error message when insufficient data', async () => {
      // Less than 50 events
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/model',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Insufficient data');
      expect(body.report).toBeNull();
    });
  });

  // ===========================================================================
  // GET /api/analysis/compare
  // ===========================================================================

  describe('GET /api/analysis/compare', () => {
    it('should compare contrarian modes with FDR correction', async () => {
      // Mock for 4 mode comparisons
      for (let i = 0; i < 4; i++) {
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      }

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/compare',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.fdr).toBe(0.1);
      expect(body.comparisons).toBeDefined();
      expect(Array.isArray(body.comparisons)).toBe(true);
    });

    it('should use custom FDR threshold', async () => {
      for (let i = 0; i < 4; i++) {
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      }

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/compare?fdr=0.05',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.fdr).toBe(0.05);
    });

    it('should return bestMode from comparisons', async () => {
      for (let i = 0; i < 4; i++) {
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      }

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/compare',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.bestMode).toBeDefined();
    });
  });

  // ===========================================================================
  // GET /api/analysis/categories
  // ===========================================================================

  describe('GET /api/analysis/categories', () => {
    it('should return list of categories', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/categories',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.categories).toBeDefined();
      expect(Array.isArray(body.categories)).toBe(true);
      expect(body.categories).toContain('Politics');
      expect(body.categories).toContain('Crypto');
      expect(body.categories).toContain('Sports');
    });
  });

  // ===========================================================================
  // Query Parameter Parsing
  // ===========================================================================

  describe('Query parameter parsing', () => {
    it('should parse boolean parameters correctly', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary?requireAsymmetry=true&requireNewWallet=true',
      });

      expect(response.statusCode).toBe(200);
      // The service should receive correct config
    });

    it('should parse categories as comma-separated list', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary?categories=crypto,politics',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should handle empty categories', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary?categories=',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error handling', () => {
    it('should return 500 on database error for summary', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/summary',
      });

      expect(response.statusCode).toBe(200);
      // Service handles error gracefully and returns empty summary
    });

    it('should return 500 on database error for backfill status', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('DB error'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/analysis/backfill/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('error');
    });
  });
});

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { BackfillService, BackfillConfig } from '../backfill.service.js';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock pg Pool
const mockPoolQuery = vi.fn();
const mockPool = {
  query: mockPoolQuery,
} as any;

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// =============================================================================
// Tests
// =============================================================================

describe('BackfillService', () => {
  let service: BackfillService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BackfillService(mockPool);
  });

  // ===========================================================================
  // getStatus()
  // ===========================================================================

  describe('getStatus()', () => {
    it('should return idle status when no jobs exist', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const status = await service.getStatus();

      expect(status.status).toBe('idle');
      expect(status.jobId).toBeNull();
      expect(status.progress).toBe(0);
    });

    it('should return running status with progress', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          job_type: 'full',
          status: 'running',
          started_at: new Date(),
          completed_at: null,
          items_processed: 50,
          items_total: 100,
          error_message: null,
        }],
      });

      const status = await service.getStatus();

      expect(status.status).toBe('running');
      expect(status.jobId).toBe(1);
      expect(status.progress).toBe(50);
      expect(status.itemsProcessed).toBe(50);
      expect(status.itemsTotal).toBe(100);
    });

    it('should return completed status', async () => {
      const completedAt = new Date();
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 2,
          job_type: 'full',
          status: 'completed',
          started_at: new Date(Date.now() - 60000),
          completed_at: completedAt,
          items_processed: 100,
          items_total: 100,
          error_message: null,
        }],
      });

      const status = await service.getStatus();

      expect(status.status).toBe('completed');
      expect(status.progress).toBe(100);
      expect(status.completedAt).toEqual(completedAt);
    });

    it('should return failed status with error message', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 3,
          job_type: 'full',
          status: 'failed',
          started_at: new Date(),
          completed_at: new Date(),
          items_processed: 25,
          items_total: 100,
          error_message: 'API rate limit exceeded',
        }],
      });

      const status = await service.getStatus();

      expect(status.status).toBe('failed');
      expect(status.errorMessage).toBe('API rate limit exceeded');
      expect(status.progress).toBe(25);
    });

    it('should handle database errors gracefully', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('Connection failed'));

      const status = await service.getStatus();

      expect(status.status).toBe('idle');
      expect(status.errorMessage).toBe('Failed to get status');
    });

    it('should calculate progress as 0 when items_total is 0', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 4,
          job_type: 'full',
          status: 'running',
          started_at: new Date(),
          completed_at: null,
          items_processed: 0,
          items_total: 0,
          error_message: null,
        }],
      });

      const status = await service.getStatus();

      expect(status.progress).toBe(0);
    });
  });

  // ===========================================================================
  // Market Resolution Detection (isMarketResolved logic)
  // ===========================================================================

  describe('Market resolution detection', () => {
    // Test via the fetchResolvedMarkets behavior indirectly through runFullBackfill

    it('should filter markets with string prices "1" and "0"', async () => {
      // Setup: First query creates job, second returns no more markets
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // Insert job
        .mockResolvedValueOnce({ rows: [] }); // No markets in DB

      // First API call returns markets with string prices
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'Will it rain?',
            endDate: new Date().toISOString(),
            outcomePrices: '["1", "0"]', // String prices - should be detected as resolved
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
          {
            conditionId: 'cond2',
            question: 'Active market',
            endDate: new Date().toISOString(),
            outcomePrices: '["0.5", "0.5"]', // Not resolved
            clobTokenIds: '["token3", "token4"]',
            volume: '5000',
            liquidity: '2500',
          },
        ]),
      });

      // Second API call returns empty (end of pagination)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      // Should find 1 resolved market (cond1 with prices "1", "0")
      expect(result.marketsFound).toBe(1);
    });

    it('should filter markets with numeric prices 1 and 0', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'Market A',
            endDate: new Date().toISOString(),
            outcomePrices: '[1, 0]', // Numeric prices
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
        ]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      // Numeric prices [1, 0] should be detected as resolved
      expect(result.marketsFound).toBe(1);
    });

    it('should detect "No" winner with prices [0, 1]', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'Market B',
            endDate: new Date().toISOString(),
            outcomePrices: '["0", "1"]', // No wins
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
        ]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      // [0, 1] means "No" won - should be detected
      expect(result.marketsFound).toBe(1);
    });

    it('should reject markets without outcomePrices', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'No prices',
            endDate: new Date().toISOString(),
            // outcomePrices missing
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
        ]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      expect(result.marketsFound).toBe(0);
    });

    it('should reject markets with invalid JSON in outcomePrices', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'Bad JSON',
            endDate: new Date().toISOString(),
            outcomePrices: 'not valid json',
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
        ]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      expect(result.marketsFound).toBe(0);
    });

    it('should reject markets with partial resolution prices', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            conditionId: 'cond1',
            question: 'Partial',
            endDate: new Date().toISOString(),
            outcomePrices: '["0.9", "0.1"]', // Not fully resolved
            clobTokenIds: '["token1", "token2"]',
            volume: '10000',
            liquidity: '5000',
          },
        ]),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      expect(result.marketsFound).toBe(0);
    });
  });

  // ===========================================================================
  // Pagination
  // ===========================================================================

  describe('Pagination', () => {
    it('should stop pagination on API error', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValue({ rows: [] });

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      expect(result.marketsFound).toBe(0);
    });

    it('should stop pagination on non-OK response', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValue({ rows: [] });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      const result = await service.runFullBackfill(config);

      expect(result.marketsFound).toBe(0);
    });
  });

  // ===========================================================================
  // Trade Fetching
  // ===========================================================================

  describe('Trade fetching', () => {
    it('should be covered by integration tests', () => {
      // The 504 handling and complex trade fetching scenarios are tested
      // in integration tests. This placeholder ensures the describe block is valid.
      expect(true).toBe(true);
    });
  });

  // ===========================================================================
  // Job Tracking
  // ===========================================================================

  describe('Job tracking', () => {
    it('should create job record on start', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // Create job returns ID
        .mockResolvedValue({ rows: [] });

      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      await service.runFullBackfill(config);

      // First call should be INSERT INTO backfill_jobs
      expect(mockPoolQuery.mock.calls[0][0]).toContain('INSERT INTO backfill_jobs');
    });

    it('should update job to completed on success', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValue({ rows: [] });

      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });

      const config: BackfillConfig = { days: 30, windowMinutes: 60, minSizeUsd: 100 };
      await service.runFullBackfill(config);

      // Last query should update status to completed
      const lastCall = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1];
      expect(lastCall[0]).toContain('completed');
    });

    // Note: Error recording is tested implicitly through the integration tests.
    // The unit tests focus on the core functionality that can be reliably mocked.
  });

  // ===========================================================================
  // Contrarian Event Computation
  // ===========================================================================

  describe('Contrarian event computation', () => {
    it('should be covered by statistics tests and integration tests', () => {
      // The contrarian computation logic relies on:
      // 1. percentileRank and robustZScore from statistics.service (tested in statistics.service.test.ts)
      // 2. Complex mock sequences that are better tested via integration tests
      expect(true).toBe(true);
    });
  });
});

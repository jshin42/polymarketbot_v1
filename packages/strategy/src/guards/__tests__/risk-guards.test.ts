import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskGuards, type RiskCheckInput, type RiskGuardConfig } from '../risk-guards.js';

/**
 * Risk Guards Tests
 *
 * Per CLAUDE.md Section 5, these guardrails are non-negotiable:
 * - Caps: single bet 2%, position 5%, total exposure 10%
 * - Circuit breakers: daily loss 5%, drawdown 15%, consecutive losses 5
 * - Execution limits: spread threshold, depth threshold, data staleness
 * - No-trade zone: reject trades < 120s to close
 */

// Mock Redis client
const createMockRedis = () => ({
  hset: vi.fn().mockResolvedValue('OK'),
  hget: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  duplicate: vi.fn().mockReturnThis(),
});

function createBaseInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  const now = Date.now();
  return {
    tokenId: 'test_token',
    conditionId: 'test_condition',
    marketCloseTime: now + 3600000, // 1 hour from now
    currentTime: now,
    proposedSizeUsd: 100,
    bankroll: 10000,
    totalExposure: 500,
    existingPositionSize: 0,
    dailyPnl: 0,
    drawdownPct: 0,
    consecutiveLosses: 0,
    spread: 100, // 1% spread = 100 bps
    topOfBookDepth: 500,
    lastBookUpdateMs: now - 1000, // 1 second ago
    lastTradeUpdateMs: now - 2000, // 2 seconds ago
    ...overrides,
  };
}

describe('Risk Guards', () => {
  let riskGuards: RiskGuards;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    riskGuards = new RiskGuards(mockRedis as any);
  });

  describe('Initialization', () => {
    it('should use default configuration', () => {
      const config = riskGuards.getConfig();

      expect(config.maxExposurePct).toBe(0.10);
      expect(config.maxSingleBetPct).toBe(0.02);
      expect(config.maxPositionPct).toBe(0.05);
      expect(config.dailyLossLimitPct).toBe(0.05);
      expect(config.maxDrawdownPct).toBe(0.15);
      expect(config.consecutiveLossLimit).toBe(5);
      expect(config.noTradeZoneSeconds).toBe(120);
    });

    it('should allow custom configuration', () => {
      const customConfig: Partial<RiskGuardConfig> = {
        maxExposurePct: 0.05,
        noTradeZoneSeconds: 60,
      };

      const customGuards = new RiskGuards(mockRedis as any, customConfig);
      const config = customGuards.getConfig();

      expect(config.maxExposurePct).toBe(0.05);
      expect(config.noTradeZoneSeconds).toBe(60);
    });
  });

  describe('Single Bet Cap (2% bankroll)', () => {
    it('caps single bet at 2% bankroll', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 500, // 5% of $10,000 bankroll
        bankroll: 10000,
      });

      const result = await riskGuards.checkRisk(input);

      // 2% of $10,000 = $200
      expect(result.adjustedSizeUsd).toBe(200);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('size_capped_single_bet')
      );
      expect(result.approved).toBe(true);
    });

    it('allows bet at exactly 2%', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 200, // Exactly 2%
        bankroll: 10000,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.adjustedSizeUsd).toBe(200);
      expect(result.warnings).not.toContainEqual(
        expect.stringContaining('size_capped_single_bet')
      );
    });

    it('allows bet below 2%', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 100, // 1%
        bankroll: 10000,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.adjustedSizeUsd).toBe(100);
      expect(result.approved).toBe(true);
    });
  });

  describe('Position Cap (5% bankroll)', () => {
    it('caps position at 5% bankroll', async () => {
      // Use a proposed size that won't be capped by single bet (2% = $200)
      // but will exceed position limit
      const input = createBaseInput({
        proposedSizeUsd: 150, // Below 2% cap
        bankroll: 10000,
        existingPositionSize: 400, // Already have $400, max = $500
      });

      const result = await riskGuards.checkRisk(input);

      // Max position = $500, existing = $400, can add = $100
      expect(result.adjustedSizeUsd).toBe(100);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('size_capped_position')
      );
    });

    it('rejects trade when position already at limit', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 100,
        bankroll: 10000,
        existingPositionSize: 500, // Already at 5%
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('position_limit_exceeded')
      );
    });

    it('rejects trade when position exceeds limit', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 100,
        bankroll: 10000,
        existingPositionSize: 600, // Over limit
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
    });
  });

  describe('Total Exposure Cap (10% bankroll)', () => {
    it('caps total exposure at 10% bankroll', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 200,
        bankroll: 10000,
        totalExposure: 900, // Already have 9% exposure
      });

      const result = await riskGuards.checkRisk(input);

      // Max exposure = $1000, existing = $900, can add = $100
      expect(result.adjustedSizeUsd).toBe(100);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('size_capped_exposure')
      );
    });

    it('rejects trade when exposure at limit', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 100,
        bankroll: 10000,
        totalExposure: 1000, // Already at 10%
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('exposure_limit_exceeded')
      );
    });
  });

  describe('Daily Loss Circuit Breaker (5%)', () => {
    it('triggers daily loss circuit breaker at 5%', async () => {
      const input = createBaseInput({
        bankroll: 10000,
        dailyPnl: -600, // 6% loss, exceeds 5% limit
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('daily_loss_circuit_breaker')
      );
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it('warns when approaching daily loss limit', async () => {
      const input = createBaseInput({
        bankroll: 10000,
        dailyPnl: -420, // 4.2% loss, above 80% of limit
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('approaching_daily_loss_limit')
      );
    });

    it('does not trigger when below limit', async () => {
      const input = createBaseInput({
        bankroll: 10000,
        dailyPnl: -200, // 2% loss
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.rejectionReasons).not.toContainEqual(
        expect.stringContaining('daily_loss')
      );
    });
  });

  describe('Drawdown Circuit Breaker (15%)', () => {
    it('triggers drawdown circuit breaker at 15%', async () => {
      const input = createBaseInput({
        drawdownPct: 0.16, // 16% drawdown
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('drawdown_circuit_breaker')
      );
    });

    it('warns when approaching drawdown limit', async () => {
      const input = createBaseInput({
        drawdownPct: 0.13, // 13% > 80% of 15%
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('approaching_drawdown_limit')
      );
    });

    it('does not trigger when below limit', async () => {
      const input = createBaseInput({
        drawdownPct: 0.10, // 10%
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.rejectionReasons).not.toContainEqual(
        expect.stringContaining('drawdown')
      );
    });
  });

  describe('Consecutive Loss Circuit Breaker (5 losses)', () => {
    it('triggers consecutive loss circuit breaker at 5 losses', async () => {
      const input = createBaseInput({
        consecutiveLosses: 5,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('consecutive_loss_circuit_breaker')
      );
    });

    it('warns when approaching consecutive loss limit', async () => {
      const input = createBaseInput({
        consecutiveLosses: 4, // One away from limit
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('approaching_consecutive_loss_limit')
      );
    });

    it('does not trigger when below limit', async () => {
      const input = createBaseInput({
        consecutiveLosses: 3,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.rejectionReasons).not.toContainEqual(
        expect.stringContaining('consecutive_loss')
      );
    });
  });

  describe('Spread Threshold', () => {
    it('rejects when spread > threshold', async () => {
      const input = createBaseInput({
        spread: 600, // 6% spread > 5% threshold
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('spread_too_wide')
      );
    });

    it('allows trade at spread threshold', async () => {
      const input = createBaseInput({
        spread: 500, // Exactly at 5% threshold
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });

    it('allows trade below spread threshold', async () => {
      const input = createBaseInput({
        spread: 100, // 1% spread
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });
  });

  describe('Depth Threshold', () => {
    it('rejects when depth < threshold', async () => {
      const input = createBaseInput({
        topOfBookDepth: 50, // Below $100 threshold
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('insufficient_depth')
      );
    });

    it('allows trade at depth threshold', async () => {
      const input = createBaseInput({
        topOfBookDepth: 100, // At threshold
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });

    it('allows trade above depth threshold', async () => {
      const input = createBaseInput({
        topOfBookDepth: 1000,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });
  });

  describe('Data Staleness', () => {
    it('rejects when data stale', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        lastBookUpdateMs: now - 15000, // 15 seconds old > 10s threshold
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('stale_book_data')
      );
    });

    it('warns about stale trade data but allows trade', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        lastBookUpdateMs: now - 5000, // Book is fresh
        lastTradeUpdateMs: now - 15000, // Trades are stale
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('stale_trade_data')
      );
    });

    it('allows trade with fresh data', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        lastBookUpdateMs: now - 1000,
        lastTradeUpdateMs: now - 2000,
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });
  });

  describe('No-Trade Zone', () => {
    it('rejects trade when < 120s to close', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 60000, // 60 seconds to close
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('no_trade_zone')
      );
    });

    it('rejects trade at exactly 120s to close', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 120000, // Exactly 120 seconds
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual(
        expect.stringContaining('no_trade_zone')
      );
    });

    it('allows trade when >= 120s to close', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 121000, // 121 seconds
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });

    it('allows trade with plenty of time', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 3600000, // 1 hour
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });
  });

  describe('Circuit Breaker Management', () => {
    it('rejects all trades when circuit breaker is active', async () => {
      // Trigger circuit breaker
      const triggerInput = createBaseInput({
        dailyPnl: -600, // Triggers daily loss breaker
      });
      await riskGuards.checkRisk(triggerInput);

      // Subsequent trade should be rejected
      const normalInput = createBaseInput();
      const result = await riskGuards.checkRisk(normalInput);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContainEqual('circuit_breaker_active');
    });

    it('allows trades after circuit breaker reset', async () => {
      // Trigger circuit breaker
      const triggerInput = createBaseInput({
        dailyPnl: -600,
      });
      await riskGuards.checkRisk(triggerInput);

      // Reset
      await riskGuards.resetCircuitBreaker();

      // Should be allowed now
      const normalInput = createBaseInput();
      const result = await riskGuards.checkRisk(normalInput);

      expect(result.rejectionReasons).not.toContainEqual('circuit_breaker_active');
    });

    it('records circuit breaker activation in Redis', async () => {
      const input = createBaseInput({
        dailyPnl: -600,
      });

      await riskGuards.checkRisk(input);

      expect(mockRedis.hset).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          active: 'true',
          reason: 'daily_loss',
        })
      );
    });
  });

  describe('Combined scenarios', () => {
    it('applies multiple caps in order', async () => {
      const input = createBaseInput({
        proposedSizeUsd: 1000, // Huge bet
        bankroll: 10000,
        existingPositionSize: 400, // Already have position
        totalExposure: 800, // Already have exposure
      });

      const result = await riskGuards.checkRisk(input);

      // Should be capped by multiple limits
      // Single bet cap: $200 (2%)
      // Position cap: $500 - $400 = $100
      // Exposure cap: $1000 - $800 = $200
      // Final: min($200, $100, $200) = $100
      expect(result.adjustedSizeUsd).toBe(100);
    });

    it('rejects when multiple reasons present', async () => {
      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 60000, // No-trade zone
        spread: 600, // Spread too wide
        topOfBookDepth: 50, // Insufficient depth
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons.length).toBeGreaterThanOrEqual(3);
    });

    it('performs all checks and records them', async () => {
      const input = createBaseInput();
      const result = await riskGuards.checkRisk(input);

      expect(result.checksPerformed).toContain('circuit_breaker');
      expect(result.checksPerformed).toContain('no_trade_zone');
      expect(result.checksPerformed).toContain('data_staleness');
      expect(result.checksPerformed).toContain('spread_limit');
      expect(result.checksPerformed).toContain('depth_limit');
      expect(result.checksPerformed).toContain('single_bet_limit');
      expect(result.checksPerformed).toContain('position_limit');
      expect(result.checksPerformed).toContain('exposure_limit');
    });
  });

  describe('Configuration updates', () => {
    it('allows runtime config updates', async () => {
      riskGuards.updateConfig({
        noTradeZoneSeconds: 60, // Reduce from 120 to 60
      });

      const now = Date.now();
      const input = createBaseInput({
        currentTime: now,
        marketCloseTime: now + 90000, // 90 seconds - would fail default
      });

      const result = await riskGuards.checkRisk(input);

      expect(result.approved).toBe(true);
    });
  });
});

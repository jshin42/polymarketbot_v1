import { z } from 'zod';
import { FeatureVectorSchema } from './feature.schema.js';
import { CompositeScoreSchema, SignalStrengthSchema } from './score.schema.js';

// =============================================================================
// Decision Schemas
// =============================================================================

/**
 * Trading action enum
 */
export const TradingActionSchema = z.enum([
  'BUY',      // Buy the outcome (go long)
  'SELL',     // Sell the outcome (go short)
  'HOLD',     // No action, monitor
  'NO_TRADE', // Explicitly do not trade (risk/liquidity issues)
]);

export type TradingAction = z.infer<typeof TradingActionSchema>;

/**
 * Rejection reason enum
 */
export const RejectionReasonSchema = z.enum([
  'BELOW_ANOMALY_THRESHOLD',
  'BELOW_EXECUTION_THRESHOLD',
  'BELOW_EDGE_THRESHOLD',
  'INSUFFICIENT_LIQUIDITY',
  'SPREAD_TOO_WIDE',
  'IN_NO_TRADE_ZONE',
  'STALE_DATA',
  'CIRCUIT_BREAKER_ACTIVE',
  'EXPOSURE_LIMIT_REACHED',
  'POSITION_LIMIT_REACHED',
  'DAILY_LOSS_LIMIT',
  'MARKET_CLOSED',
  'MARKET_RESOLVED',
  'PAPER_MODE_FILL_FAILED',
  'RISK_CHECK_FAILED',
]);

export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

/**
 * Kelly sizing result
 */
export const KellySizingSchema = z.object({
  // Kelly calculation
  fullKellyFraction: z.number(),
  adjustedKellyFraction: z.number(), // After fractional Kelly applied
  betFraction: z.number().min(0).max(1),

  // Bet sizing
  betSizeUsd: z.number().nonnegative(),
  betSizeShares: z.number().nonnegative(),

  // Capping info
  capped: z.boolean(),
  cappedReason: z.string().nullable(),
  originalSize: z.number().nonnegative(),

  // Risk parameters used
  kellyFractionUsed: z.number(), // e.g., 0.25 for quarter-Kelly
  maxBetPct: z.number(),
  bankroll: z.number().positive(),
});

export type KellySizing = z.infer<typeof KellySizingSchema>;

/**
 * Trading decision output
 */
export const DecisionSchema = z.object({
  // Identifiers
  id: z.string().uuid(),
  tokenId: z.string(),
  conditionId: z.string(),
  timestamp: z.number().int().positive(),

  // Decision
  action: TradingActionSchema,
  side: z.enum(['YES', 'NO']).nullable(), // Which outcome to trade
  direction: z.enum(['BUY', 'SELL']).nullable(), // Buy or sell that outcome

  // Pricing
  targetPrice: z.number().min(0).max(1).nullable(),
  limitPrice: z.number().min(0).max(1).nullable(),
  currentMid: z.number().min(0).max(1),

  // Sizing
  sizing: KellySizingSchema.nullable(),
  targetSizeUsd: z.number().nonnegative().nullable(),
  targetSizeShares: z.number().nonnegative().nullable(),

  // Scores snapshot
  scores: CompositeScoreSchema,
  signalStrength: SignalStrengthSchema,

  // Features snapshot (for audit)
  features: FeatureVectorSchema,

  // Approval status
  approved: z.boolean(),
  rejectionReason: RejectionReasonSchema.nullable(),
  riskChecksPassed: z.boolean(),

  // Metadata
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(), // Decision validity window
  paperMode: z.boolean(),
});

export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Execution request sent to executor
 */
export const ExecutionRequestSchema = z.object({
  // Identifiers
  decisionId: z.string().uuid(),
  idempotencyKey: z.string().uuid(), // Prevent duplicate orders

  // Order details
  tokenId: z.string(),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().min(0).max(1),
  size: z.number().positive(),

  // Order type
  orderType: z.enum(['LIMIT', 'MARKET']),
  timeInForce: z.enum(['GTC', 'GTD', 'IOC', 'FOK']).default('GTC'),

  // Risk re-validation
  maxSlippageBps: z.number().nonnegative().default(100),
  requireRiskRecheck: z.boolean().default(true),

  // Expiry
  expiresAt: z.string().datetime(),

  // Mode
  paperMode: z.boolean(),

  // Timestamps
  createdAt: z.string().datetime(),
});

export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

/**
 * Execution result from executor
 */
export const ExecutionResultSchema = z.object({
  // Identifiers
  decisionId: z.string().uuid(),
  executionRequestId: z.string().uuid(),
  orderId: z.string().nullable(), // CLOB order ID (null for paper)

  // Status
  status: z.enum(['filled', 'partial', 'rejected', 'cancelled', 'expired', 'error']),

  // Fill details
  filledSize: z.number().nonnegative(),
  filledPrice: z.number().min(0).max(1).nullable(),
  averagePrice: z.number().min(0).max(1).nullable(),
  remainingSize: z.number().nonnegative(),

  // Slippage
  slippageBps: z.number().nullable(),
  slippageUsd: z.number().nullable(),

  // Costs
  feesUsd: z.number().nonnegative(),

  // Error info
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),

  // Mode
  paperMode: z.boolean(),

  // Timestamps
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

/**
 * Position opened after execution
 */
export const PositionSchema = z.object({
  // Identifiers
  id: z.string().uuid(),
  tokenId: z.string(),
  conditionId: z.string(),
  decisionId: z.string().uuid(),

  // Position details
  side: z.enum(['YES', 'NO']),
  direction: z.enum(['LONG', 'SHORT']),
  entryPrice: z.number().min(0).max(1),
  size: z.number().positive(),
  sizeUsd: z.number().positive(),

  // Current state
  currentPrice: z.number().min(0).max(1).nullable(),
  unrealizedPnl: z.number().nullable(),
  unrealizedPnlPct: z.number().nullable(),

  // Exit info
  exitPrice: z.number().min(0).max(1).nullable(),
  exitTime: z.string().datetime().nullable(),
  realizedPnl: z.number().nullable(),
  realizedPnlPct: z.number().nullable(),

  // Status
  status: z.enum(['open', 'closed', 'liquidated', 'resolved']),
  closeReason: z.enum(['manual', 'stop_loss', 'take_profit', 'market_close', 'resolution']).nullable(),

  // Mode
  paperMode: z.boolean(),

  // Timestamps
  entryTime: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Position = z.infer<typeof PositionSchema>;

/**
 * Decision thresholds configuration
 */
export const DecisionThresholdsSchema = z.object({
  minAnomalyScore: z.number().min(0).max(1).default(0.65),
  minExecutionScore: z.number().min(0).max(1).default(0.55),
  minEdgeScore: z.number().min(0).max(1).default(0.0), // Optional
  minCompositeScore: z.number().min(0).max(1).default(0.50),
  maxSpreadBps: z.number().positive().default(500),
  minDepthUsd: z.number().positive().default(100),
  noTradeZoneSeconds: z.number().nonnegative().default(120),
});

export type DecisionThresholds = z.infer<typeof DecisionThresholdsSchema>;

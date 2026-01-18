import { z } from 'zod';

// =============================================================================
// Scoring Schemas
// =============================================================================

/**
 * Anomaly score component breakdown
 */
export const AnomalyScoreComponentsSchema = z.object({
  // Trade size component (weight: 0.35)
  tradeSizeComponent: z.number().min(0).max(1),

  // Order book components (weight: 0.30 total)
  bookImbalanceComponent: z.number().min(0).max(1),
  thinOppositeComponent: z.number().min(0).max(1),
  orderbookComponent: z.number().min(0).max(1), // Combined

  // Wallet component (weight: 0.20)
  walletComponent: z.number().min(0).max(1),

  // Impact component (weight: 0.15)
  impactComponent: z.number().min(0).max(1),

  // Context components (contribute to final adjustment)
  burstComponent: z.number().min(0).max(1),
  changePointComponent: z.number().min(0).max(1),
});

export type AnomalyScoreComponents = z.infer<typeof AnomalyScoreComponentsSchema>;

/**
 * Anomaly score with components and metadata
 */
export const AnomalyScoreSchema = z.object({
  score: z.number().min(0).max(1),
  components: AnomalyScoreComponentsSchema,

  // Core score (without context adjustment)
  coreScore: z.number().min(0).max(1),

  // Context score (burst + change point)
  contextScore: z.number().min(0).max(1),

  // Confidence in the score (based on data completeness)
  confidence: z.number().min(0).max(1),

  // Triggered flag (score above threshold)
  triggered: z.boolean(),

  // Triple signal detection
  tripleSignal: z.boolean(), // Size + Book + Wallet all high
});

export type AnomalyScore = z.infer<typeof AnomalyScoreSchema>;

/**
 * Execution score measuring fillability and slippage risk
 */
export const ExecutionScoreSchema = z.object({
  score: z.number().min(0).max(1),

  // Component scores
  depthScore: z.number().min(0).max(1), // Sufficient liquidity
  spreadScore: z.number().min(0).max(1), // Narrow spread
  volatilityScore: z.number().min(0).max(1), // Low volatility
  timeScore: z.number().min(0).max(1), // Time to close penalty

  // Penalties (0 = no penalty, 1 = max penalty)
  spreadPenalty: z.number().min(0).max(1),
  slippagePenalty: z.number().min(0).max(1),
  timePenalty: z.number().min(0).max(1),

  // Estimates
  slippageEstimateBps: z.number().nonnegative(),
  fillProbability: z.number().min(0).max(1),

  // Available depth at limit price
  depthAtLimit: z.number().nonnegative(),
});

export type ExecutionScore = z.infer<typeof ExecutionScoreSchema>;

/**
 * Edge score measuring expected value
 */
export const EdgeScoreSchema = z.object({
  score: z.number().min(0).max(1),

  // Probability estimates
  impliedProbability: z.number().min(0).max(1), // From market price
  estimatedProbability: z.number().min(0).max(1), // Our estimate

  // Edge calculation
  edge: z.number(), // estimated - implied (can be negative)
  edgeAbs: z.number().nonnegative(),
  edgePct: z.number(), // edge / implied * 100

  // Confidence in edge estimate
  edgeConfidence: z.number().min(0).max(1),

  // Signal alignment (how many signals agree)
  alignedSignals: z.number().int().nonnegative(),
});

export type EdgeScore = z.infer<typeof EdgeScoreSchema>;

/**
 * Signal strength classification
 */
export const SignalStrengthSchema = z.enum([
  'none',
  'weak',
  'moderate',
  'strong',
  'extreme',
]);

export type SignalStrength = z.infer<typeof SignalStrengthSchema>;

/**
 * Information about a trade that triggered an anomaly.
 * Used to display specific transactions in the dashboard.
 */
export const TriggeringTradeSchema = z.object({
  /** Unique trade identifier */
  tradeId: z.string(),

  /** Trade timestamp in milliseconds */
  timestamp: z.number().int().positive(),

  /** Dollar value of the trade */
  sizeUsd: z.number().positive(),

  /** Trade price (0-1) */
  price: z.number().min(0).max(1),

  /** Trade side */
  side: z.enum(['BUY', 'SELL']),

  /** Percentile rank of the trade in rolling window */
  percentile: z.number().min(0).max(100),

  /** Wallet address of the taker */
  walletAddress: z.string(),

  /** Age of the wallet in days (null if unknown) */
  walletAgeDays: z.number().nonnegative().nullable(),

  /** Formatted wallet age string for display */
  walletAgeFormatted: z.string(),

  /** Dollar floor multiplier that was applied */
  dollarFloorMultiplier: z.number().min(0).max(1),

  /** Transaction hash for on-chain verification (optional - may not be available for all trades) */
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),

  /** Polygonscan URL for transaction verification */
  polygonscanUrl: z.string().url().optional(),
});

export type TriggeringTrade = z.infer<typeof TriggeringTradeSchema>;

/**
 * Complete composite score combining all scoring dimensions
 */
export const CompositeScoreSchema = z.object({
  // Identifiers
  tokenId: z.string(),
  timestamp: z.number().int().positive(),

  // Individual scores
  anomalyScore: AnomalyScoreSchema,
  executionScore: ExecutionScoreSchema,
  edgeScore: EdgeScoreSchema,

  // Final composite
  compositeScore: z.number().min(0).max(1),

  // Time ramp applied
  rampMultiplier: z.number().min(1),
  rampedScore: z.number().min(0).max(1), // compositeScore * rampMultiplier (capped at 1)

  // Classification
  signalStrength: SignalStrengthSchema,

  // Trades that triggered the anomaly (up to 3, sorted by significance)
  triggeringTrades: z.array(TriggeringTradeSchema).max(3).optional(),

  // Highest trade in last hour (always populated, no threshold gate)
  // Used to show trade data for ALL ranked markets, not just high-confidence triggers
  highestTrade1h: TriggeringTradeSchema.nullable().optional(),

  // Ranking for multiple opportunities
  rank: z.number().int().positive().optional(),

  // Metadata
  computedAt: z.number().int().positive(),
});

export type CompositeScore = z.infer<typeof CompositeScoreSchema>;

/**
 * Default scoring weights
 */
export const DEFAULT_ANOMALY_WEIGHTS = {
  tradeSize: 0.35,
  orderbook: 0.30, // Split: 0.6 imbalance + 0.4 thin opposite
  wallet: 0.20,
  impact: 0.15,
} as const;

export const DEFAULT_EXECUTION_WEIGHTS = {
  depth: 0.40,
  spread: 0.25,
  volatility: 0.25,
  time: 0.10,
} as const;

export const DEFAULT_COMPOSITE_WEIGHTS = {
  anomaly: 0.35,
  execution: 0.25,
  edge: 0.40,
} as const;

/**
 * Classify signal strength from composite score
 */
export function classifySignalStrength(score: number): SignalStrength {
  if (score >= 0.85) return 'extreme';
  if (score >= 0.75) return 'strong';
  if (score >= 0.55) return 'moderate';
  if (score >= 0.35) return 'weak';
  return 'none';
}

/**
 * Check if triple signal is detected
 * Triple signal = Size + Book + Wallet all above thresholds
 */
export function checkTripleSignal(
  sizeTailScore: number,
  bookImbalanceScore: number,
  thinOppositeScore: number,
  walletNewScore: number,
  walletActivityScore: number,
  thresholds = {
    size: 0.90,
    bookImbalance: 0.70,
    thinOpposite: 0.70,
    walletNew: 0.80,
    walletActivity: 0.70,
  }
): boolean {
  const sizeTriggered = sizeTailScore >= thresholds.size;
  const bookTriggered = bookImbalanceScore >= thresholds.bookImbalance &&
                       thinOppositeScore >= thresholds.thinOpposite;
  const walletTriggered = walletNewScore >= thresholds.walletNew ||
                         walletActivityScore >= thresholds.walletActivity;

  return sizeTriggered && bookTriggered && walletTriggered;
}

// =============================================================================
// Schema Exports
// =============================================================================

// Market schemas
export {
  OutcomeSchema,
  MarketStatusSchema,
  MarketMetadataSchema,
  MarketRefSchema,
  GammaMarketResponseSchema,
  transformGammaMarket,
  shouldFilterMarket,
  type Outcome,
  type MarketStatus,
  type MarketMetadata,
  type MarketRef,
  type GammaMarketResponse,
  type MarketFilterResult,
} from './market.schema.js';

// Order book schemas
export {
  PriceLevelSchema,
  OrderbookSnapshotSchema,
  OrderbookMetricsSchema,
  ClobOrderbookResponseSchema,
  transformClobOrderbook,
  computeOrderbookMetrics,
  type PriceLevel,
  type OrderbookSnapshot,
  type OrderbookMetrics,
  type ClobOrderbookResponse,
} from './orderbook.schema.js';

// Trade schemas
export {
  TradeSideSchema,
  TradeSchema,
  TradeWithMetricsSchema,
  TradeAggregateSchema,
  ClobTradeResponseSchema,
  WsTradeEventSchema,
  DataApiTradeResponseSchema,
  transformClobTrade,
  transformDataApiTrade,
  type TradeSide,
  type Trade,
  type TradeWithMetrics,
  type TradeAggregate,
  type ClobTradeResponse,
  type WsTradeEvent,
  type DataApiTradeResponse,
} from './trade.schema.js';

// Wallet schemas
export {
  EthAddressSchema,
  WalletEnrichmentSchema,
  WalletProfileSchema,
  PolygonscanTxResponseSchema,
  computeWalletAgeScore,
  computeActivityScore,
  computeWalletRiskScore,
  type EthAddress,
  type WalletEnrichment,
  type WalletProfile,
  type PolygonscanTxResponse,
} from './wallet.schema.js';

// Feature schemas
export {
  TimeToCloseFeatureSchema,
  TradeSizeFeatureSchema,
  OrderbookFeatureSchema,
  WalletFeatureSchema,
  ImpactFeatureSchema,
  BurstFeatureSchema,
  ChangePointFeatureSchema,
  FeatureVectorSchema,
  computeDollarFloorMultiplier,
  computeRawSizeTailScore,
  computeSizeTailScore,
  computeBookImbalanceScore,
  computeThinOppositeScore,
  computeSpreadScore,
  computeDepthScore,
  type TimeToCloseFeature,
  type TradeSizeFeature,
  type OrderbookFeature,
  type WalletFeature,
  type ImpactFeature,
  type BurstFeature,
  type ChangePointFeature,
  type FeatureVector,
} from './feature.schema.js';

// Score schemas
export {
  AnomalyScoreComponentsSchema,
  AnomalyScoreSchema,
  ExecutionScoreSchema,
  EdgeScoreSchema,
  SignalStrengthSchema,
  TriggeringTradeSchema,
  CompositeScoreSchema,
  DEFAULT_ANOMALY_WEIGHTS,
  DEFAULT_EXECUTION_WEIGHTS,
  DEFAULT_COMPOSITE_WEIGHTS,
  classifySignalStrength,
  checkTripleSignal,
  type AnomalyScoreComponents,
  type AnomalyScore,
  type ExecutionScore,
  type EdgeScore,
  type SignalStrength,
  type TriggeringTrade,
  type CompositeScore,
} from './score.schema.js';

// Decision schemas
export {
  TradingActionSchema,
  RejectionReasonSchema,
  KellySizingSchema,
  DecisionSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  PositionSchema,
  DecisionThresholdsSchema,
  type TradingAction,
  type RejectionReason,
  type KellySizing,
  type Decision,
  type ExecutionRequest,
  type ExecutionResult,
  type Position,
  type DecisionThresholds,
} from './decision.schema.js';

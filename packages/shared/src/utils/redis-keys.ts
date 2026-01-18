// =============================================================================
// Redis Key Patterns
// =============================================================================

/**
 * Centralized Redis key patterns for the entire system.
 * All keys should be generated through these functions to ensure consistency.
 */
export const RedisKeys = {
  // ===========================================================================
  // Rolling Windows (Sorted Sets with timestamp scores)
  // ===========================================================================

  /**
   * Rolling trade window for a token
   * Score: timestamp, Value: serialized trade
   */
  tradeWindow: (tokenId: string, windowMinutes: number) =>
    `trades:${tokenId}:window:${windowMinutes}m`,

  /**
   * Rolling book snapshot window
   * Score: timestamp, Value: serialized snapshot
   */
  bookWindow: (tokenId: string, windowMinutes: number) =>
    `book:${tokenId}:window:${windowMinutes}m`,

  // ===========================================================================
  // Current State (Hashes and Strings)
  // ===========================================================================

  /**
   * Current order book state for a token (Hash)
   */
  orderbookState: (tokenId: string) =>
    `orderbook:${tokenId}:state`,

  /**
   * Current feature vector for a token (Hash)
   */
  featureCache: (tokenId: string) =>
    `features:${tokenId}:latest`,

  /**
   * Latest composite score for a token (String - JSON)
   */
  scoreCache: (tokenId: string) =>
    `scores:${tokenId}:latest`,

  /**
   * Market metadata cache (Hash)
   */
  marketMetadata: (conditionId: string) =>
    `market:${conditionId}:metadata`,

  /**
   * Token to condition ID mapping
   */
  tokenToCondition: (tokenId: string) =>
    `token:${tokenId}:condition`,

  // ===========================================================================
  // Statistical State (Serialized Algorithms)
  // ===========================================================================

  /**
   * T-Digest for trade size quantiles (String - serialized)
   */
  tradeSizeDigest: (tokenId: string) =>
    `digest:${tokenId}:trade_size`,

  /**
   * FOCuS/CUSUM state for change point detection (String - serialized)
   */
  cpdState: (tokenId: string, metric: string) =>
    `cpd:${tokenId}:${metric}:state`,

  /**
   * Hawkes process intensity state (String - serialized)
   */
  hawkesState: (tokenId: string) =>
    `hawkes:${tokenId}:state`,

  /**
   * Rolling statistics (median, MAD, etc.) (Hash)
   */
  rollingStats: (tokenId: string, windowMinutes: number) =>
    `stats:${tokenId}:rolling:${windowMinutes}m`,

  // ===========================================================================
  // Wallet Data
  // ===========================================================================

  /**
   * Wallet enrichment cache (Hash with TTL)
   */
  walletCache: (address: string) =>
    `wallet:${address.toLowerCase()}:enriched`,

  /**
   * Wallet first-seen timestamp
   */
  walletFirstSeen: (address: string) =>
    `wallet:${address.toLowerCase()}:first_seen`,

  /**
   * Wallet profile cache (join date, username from Polymarket)
   */
  walletProfile: (address: string) =>
    `wallet:${address.toLowerCase()}:profile`,

  /**
   * Set of wallets seen in a token's recent trades
   */
  tokenWallets: (tokenId: string, windowMinutes: number) =>
    `wallets:${tokenId}:${windowMinutes}m`,

  // ===========================================================================
  // Staleness Tracking
  // ===========================================================================

  /**
   * Last update timestamp for a service/token combination
   */
  lastUpdate: (service: string, tokenId: string) =>
    `staleness:${service}:${tokenId}:last_update`,

  /**
   * Global staleness status
   */
  stalenessStatus: () =>
    `staleness:global:status`,

  // ===========================================================================
  // Risk & Circuit Breaker
  // ===========================================================================

  /**
   * Circuit breaker state (String - JSON)
   */
  circuitBreaker: () =>
    'risk:circuit_breaker',

  /**
   * Current exposure ledger (Hash)
   */
  exposureLedger: () =>
    'risk:exposure:current',

  /**
   * Daily PnL tracking (with date)
   */
  dailyPnlByDate: (date: string) =>
    `risk:pnl:daily:${date}`,

  /**
   * Current daily PnL (today)
   */
  dailyPnl: () =>
    `risk:pnl:daily:current`,

  /**
   * Current drawdown percentage
   */
  drawdownPct: () =>
    `risk:drawdown:current`,

  /**
   * Consecutive losses counter
   */
  consecutiveLosses: () =>
    `risk:consecutive_losses`,

  /**
   * Total exposure across all positions
   */
  totalExposure: () =>
    `risk:exposure:total`,

  /**
   * Paper trading bankroll
   */
  paperBankroll: () =>
    `paper:bankroll`,

  /**
   * Position size by token (Hash)
   */
  positionSize: () =>
    `positions:sizes`,

  /**
   * Position by token (Hash)
   */
  position: (tokenId: string) =>
    `positions:${tokenId}`,

  /**
   * All open positions (Set of token IDs)
   */
  openPositions: () =>
    'positions:open',

  // ===========================================================================
  // Decision & Execution
  // ===========================================================================

  /**
   * Pending decision for a token
   */
  pendingDecision: (tokenId: string) =>
    `decisions:${tokenId}:pending`,

  /**
   * Decision cache for a token
   */
  decisionCache: (tokenId: string) =>
    `decisions:${tokenId}:cache`,

  /**
   * Idempotency key tracking (Set)
   */
  idempotencyKeys: () =>
    'execution:idempotency_keys',

  /**
   * Execution request queue (List)
   */
  executionQueue: () =>
    'execution:queue',

  // ===========================================================================
  // BullMQ Queue Names (no colons allowed in queue names)
  // ===========================================================================
  queues: {
    /** Raw data normalization */
    normalize: 'polymarket-normalize',

    /** Wallet enrichment */
    enrich: 'polymarket-enrich',

    /** Feature computation */
    features: 'polymarket-features',

    /** Score calculation */
    score: 'polymarket-score',

    /** Strategy/decision */
    strategy: 'polymarket-strategy',

    /** Paper trading simulation */
    paper: 'polymarket-paper',

    /** Live execution */
    execute: 'polymarket-execute',

    /** Risk checks */
    risk: 'polymarket-risk',

    /** Audit logging */
    audit: 'polymarket-audit',

    /** Alerts */
    alerts: 'polymarket-alerts',
  },

  // ===========================================================================
  // Pub/Sub Channels
  // ===========================================================================
  channels: {
    /** New trade received */
    newTrade: (tokenId: string) =>
      `channel:trades:${tokenId}`,

    /** Order book update */
    bookUpdate: (tokenId: string) =>
      `channel:book:${tokenId}`,

    /** New score computed */
    newScore: (tokenId: string) =>
      `channel:scores:${tokenId}`,

    /** Decision made */
    newDecision: () =>
      'channel:decisions',

    /** Alert triggered */
    alert: () =>
      'channel:alerts',

    /** Circuit breaker status */
    circuitBreaker: () =>
      'channel:circuit_breaker',
  },

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Runtime configuration (Hash)
   */
  config: (namespace: string) =>
    `config:${namespace}`,

  /**
   * Feature flags
   */
  featureFlags: () =>
    'config:feature_flags',

  /**
   * Tracked tokens set
   */
  trackedTokens: () =>
    'config:tracked_tokens',
} as const;

/**
 * Default TTLs in seconds
 */
export const RedisTTL = {
  /** Wallet enrichment cache: 30 days (wallet age doesn't change frequently) */
  walletCache: 86400 * 30,

  /** Market metadata: 24 hours (refreshed by periodic job) */
  marketMetadata: 86400,

  /** Feature cache: 30 seconds */
  featureCache: 30,

  /** Score cache: 30 seconds */
  scoreCache: 30,

  /** T-Digest state: 24 hours */
  digest: 86400,

  /** CPD state: 24 hours */
  cpdState: 86400,

  /** Hawkes state: 24 hours */
  hawkesState: 86400,

  /** Rolling stats: 24 hours */
  rollingStats: 86400,

  /** Pending decision: 5 minutes */
  pendingDecision: 300,

  /** Idempotency key: 24 hours */
  idempotencyKey: 86400,
} as const;

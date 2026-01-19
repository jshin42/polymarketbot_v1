// =============================================================================
// System Constants
// =============================================================================

/**
 * Polymarket API endpoints
 */
export const POLYMARKET_ENDPOINTS = {
  CLOB_BASE: 'https://clob.polymarket.com',
  WS_BASE: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  GAMMA_BASE: 'https://gamma-api.polymarket.com',
  DATA_API_BASE: 'https://data-api.polymarket.com',
} as const;

/**
 * Blockchain endpoints
 */
export const BLOCKCHAIN_ENDPOINTS = {
  POLYGON_RPC: 'https://polygon-rpc.com',
  POLYGONSCAN_API: 'https://api.polygonscan.com/api',
} as const;

/**
 * Default feature engineering parameters
 */
export const FEATURE_DEFAULTS = {
  /** Rolling window for baseline statistics (minutes) */
  ROLLING_WINDOW_MINUTES: 60,

  /** T-Digest compression parameter */
  TDIGEST_COMPRESSION: 100,

  /** Hawkes process alpha (jump size) */
  HAWKES_ALPHA: 0.5,

  /** Hawkes process beta (decay rate) */
  HAWKES_BETA: 0.1,

  /** FOCuS change-point detection threshold */
  FOCUS_THRESHOLD: 5.0,

  /** Time ramp alpha */
  TIME_RAMP_ALPHA: 2.0,

  /** Time ramp beta */
  TIME_RAMP_BETA: 0.1,

  /** Maximum time ramp multiplier */
  TIME_RAMP_MAX: 5.0,
} as const;

/**
 * Default scoring thresholds
 */
export const SCORING_DEFAULTS = {
  /** Minimum anomaly score to consider trading */
  MIN_ANOMALY_SCORE: 0.65,

  /** Minimum execution score to consider trading */
  MIN_EXECUTION_SCORE: 0.55,

  /** Minimum edge score (optional) */
  MIN_EDGE_SCORE: 0.0,

  /** Minimum composite score */
  MIN_COMPOSITE_SCORE: 0.50,

  /** Triple signal thresholds */
  TRIPLE_SIGNAL: {
    SIZE_TAIL: 0.90,
    BOOK_IMBALANCE: 0.70,
    THIN_OPPOSITE: 0.70,
    WALLET_NEW: 0.80,
    WALLET_ACTIVITY: 0.70,
  },
} as const;

/**
 * Dollar floor thresholds for anomaly detection.
 * Trades must meet BOTH statistical anomaly AND minimum dollar size.
 */
export const DOLLAR_FLOOR_DEFAULTS = {
  /** Hard minimum: trades below this get 0 size tail score */
  MIN_ANOMALY_TRADE_USD: 5000,

  /** Tier 1: trades $5k-$10k get 50% of computed score */
  TIER_1_THRESHOLD_USD: 10000,

  /** Tier 2: trades $10k-$25k get 75% of computed score */
  TIER_2_THRESHOLD_USD: 25000,

  /** Above $25k: full 100% of computed score */
} as const;

/**
 * Default risk parameters
 */
export const RISK_DEFAULTS = {
  /** Maximum total exposure as percentage of bankroll */
  MAX_EXPOSURE_PCT: 0.10,

  /** Maximum single bet as percentage of bankroll */
  MAX_SINGLE_BET_PCT: 0.02,

  /** Maximum single position as percentage of bankroll */
  MAX_POSITION_PCT: 0.05,

  /** Maximum open positions */
  MAX_OPEN_POSITIONS: 10,

  /** Daily loss limit (circuit breaker) */
  DAILY_LOSS_LIMIT_PCT: 0.05,

  /** Maximum drawdown (circuit breaker) */
  MAX_DRAWDOWN_PCT: 0.15,

  /** No-trade zone before market close (seconds) */
  NO_TRADE_ZONE_SECONDS: 120,

  /** Consecutive loss limit */
  CONSECUTIVE_LOSS_LIMIT: 5,

  /** Circuit breaker cooldown (minutes) */
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: 60,
} as const;

/**
 * Default strategy parameters
 */
export const STRATEGY_DEFAULTS = {
  /** Kelly criterion fraction */
  KELLY_FRACTION: 0.25,

  /** Minimum bet size (USD) */
  MIN_BET_SIZE_USD: 5,

  /** Maximum spread to consider trading (basis points) */
  MAX_SPREAD_BPS: 500,

  /** Minimum order book depth required (USD) */
  MIN_DEPTH_USD: 100,
} as const;

/**
 * Default collection parameters
 */
export const COLLECTION_DEFAULTS = {
  /** Order book snapshot interval (ms) */
  ORDERBOOK_INTERVAL_MS: 1000,

  /** Trade poll interval (ms) */
  TRADE_POLL_INTERVAL_MS: 1000,

  /** Data staleness threshold (ms) */
  STALENESS_THRESHOLD_MS: 10000,

  /** Auto-track markets closing within N hours */
  AUTO_TRACK_HOURS: 24,
} as const;

/**
 * Wallet age score thresholds (days)
 */
export const WALLET_AGE_THRESHOLDS = {
  /** Very new (< 7 days): score = 1.0 */
  VERY_NEW: 7,

  /** New (< 30 days): score = 0.7 */
  NEW: 30,

  /** Moderate (< 180 days): score = 0.3 */
  MODERATE: 180,

  /** Old (>= 180 days): score = 0.0 */
} as const;

/**
 * Wallet activity score thresholds
 */
export const WALLET_ACTIVITY_THRESHOLDS = {
  /** Minimum trades for "normal" activity */
  MIN_TRADES: 100,

  /** Minimum markets for "normal" activity */
  MIN_MARKETS: 20,

  /** Minimum volume for "normal" activity (USD) */
  MIN_VOLUME: 10000,
} as const;

/**
 * Spread score parameters
 */
export const SPREAD_PARAMS = {
  /** Maximum acceptable spread (bps) for full score */
  MAX_SPREAD_BPS: 500,

  /** Narrow spread threshold (bps) */
  NARROW_SPREAD_BPS: 50,
} as const;

/**
 * Depth score parameters
 */
export const DEPTH_PARAMS = {
  /** Minimum depth for full score (USD) */
  MIN_DEPTH_USD: 100,

  /** Target depth for optimal execution (USD) */
  TARGET_DEPTH_USD: 1000,
} as const;

/**
 * Paper trading defaults
 */
export const PAPER_TRADING_DEFAULTS = {
  /** Initial bankroll (USD) */
  INITIAL_BANKROLL: 10000,

  /** Base slippage (bps) */
  BASE_SLIPPAGE_BPS: 10,

  /** Size impact factor for slippage */
  SIZE_IMPACT_FACTOR: 0.1,
} as const;

/**
 * Spread defaults for execution score computation.
 * Used by scorer to compute spread penalty.
 */
export const SPREAD_DEFAULTS = {
  /** Minimum acceptable spread in basis points (full score below this) */
  minAcceptableBps: 10,

  /** Maximum acceptable spread in basis points (zero score above this) */
  maxAcceptableBps: 500,
} as const;

/**
 * Depth defaults for execution score computation.
 * Used by scorer to compute liquidity score.
 */
export const DEPTH_DEFAULTS = {
  /** Minimum depth required for trading (USD) */
  minDepthUsd: 100,

  /** Target depth for optimal execution (USD) */
  targetDepthUsd: 1000,
} as const;

/**
 * Market filtering configuration.
 * Focus on markets where insider information could provide edge.
 * Filter out entertainment/sports markets where outcomes are publicly determined.
 */
export const MARKET_FILTERING = {
  /** Enable filtering (set false to track all markets) */
  ENABLED: true,

  /**
   * Category whitelist (case-insensitive).
   * Markets MUST have a category/tag/question matching one of these keywords.
   * Include both singular and plural forms where applicable.
   * Empty array = no whitelist (allow all categories).
   */
  CATEGORY_WHITELIST: [
    // Political
    'politic', // Matches "politics", "political"
    'election', // Matches "election", "elections"
    'president', // Matches "president", "presidential"
    'government',
    'congress',
    'parliament',
    'senate',
    'minister',
    'referendum',
    'vote',
    // Economic
    'economy',
    'economic',
    'finance',
    'inflation',
    'gdp',
    'federal reserve',
    'interest rate',
    'tariff',
    'trade war',
    'recession',
    'unemployment',
    // Legal/Regulatory
    'regulation',
    'legal',
    'court',
    'lawsuit',
    'indictment',
    'verdict',
    // Geopolitical
    'geopolitic',
    'war',
    'sanction',
    'diplomacy',
    'treaty',
    // Key figures (who might have insider info leaks)
    'trump',
    'biden',
    'musk',
    'elon',
    'doge',
    // Key countries/regions
    'china',
    'ukraine',
    'russia',
    'israel',
    'iran',
    'north korea',
    'taiwan',
    'eu ',
    'european union',
    // Cryptocurrency & Blockchain
    'crypto',
    'bitcoin',
    'btc',
    'ethereum',
    'eth',
    'blockchain',
    'defi',
    'nft',
    'stablecoin',
    'coinbase',
    'binance',
    // Technology & AI
    'tech',
    'technology',
    'artificial intelligence',
    'ai ', // trailing space to avoid "air"
    'chatgpt',
    'openai',
    'google',
    'apple',
    'microsoft',
    'nvidia',
    'tesla',
    'spacex',
    'starship',
    'rocket',
    // Science & Health
    'science',
    'fda',
    'vaccine',
    'clinical trial',
    'medical',
    'pandemic',
    'virus',
    // Weather & Climate
    'weather',
    'hurricane',
    'storm',
    'earthquake',
    'climate',
    'wildfire',
    'flood',
    // Markets & Business
    'stock',
    'dow',
    'nasdaq',
    's&p',
    'ipo',
    'bankruptcy',
    'merger',
    'acquisition',
    // Social Media
    'twitter',
    'x.com',
    'tiktok',
    'youtube',
    'reddit',
    'viral',
    'ban',
  ] as const,

  /**
   * Tag blacklist (case-insensitive).
   * Markets with ANY of these tags will be EXCLUDED.
   */
  TAG_BLACKLIST: [
    // Esports
    'Esports', 'Call of Duty', 'League of Legends', 'LoL', 'Counter-Strike',
    'CS2', 'CSGO', 'Dota', 'Valorant', 'Overwatch', 'Rocket League',
    'Fortnite', 'PUBG', 'Apex Legends', 'Rainbow Six',
    // Traditional sports
    'Sports', 'NFL', 'NBA', 'MLB', 'NHL', 'Soccer', 'Football', 'Basketball',
    'Baseball', 'Hockey', 'Tennis', 'Golf', 'MMA', 'UFC', 'Boxing', 'Cricket',
    'F1', 'Formula 1', 'NASCAR',
    // Entertainment
    'Entertainment', 'Movies', 'TV', 'Music', 'Awards', 'Oscars', 'Grammy',
    'Emmy', 'Reality TV', 'Celebrity',
    // Gaming
    'Gaming', 'Video Games', 'Twitch', 'Streaming',
  ] as const,

  /** Minimum total volume (USD) for a market to be tracked */
  MIN_VOLUME_USD: 1000,

  /** Minimum liquidity (USD) for a market to be tracked */
  MIN_LIQUIDITY_USD: 500,

  /** Log filtered markets for debugging */
  LOG_FILTERED_MARKETS: true,
} as const;

/**
 * Dashboard display defaults.
 * Configuration for dashboard UI filtering and display thresholds.
 */
export const DASHBOARD_DEFAULTS = {
  /** Minimum trade size to show in activity feed (USD) */
  MIN_ACTIVITY_USD: 1000,

  /** Minimum trade size to display as trigger in opportunities (USD) */
  MIN_TRIGGER_DISPLAY_USD: 500,
} as const;

/**
 * Opportunity filtering thresholds.
 * Used to filter out markets where there's no realistic edge.
 */
export const OPPORTUNITY_FILTERING = {
  /** Exclude markets where price is above this (almost certain YES, no edge) */
  MAX_PRICE_THRESHOLD: 0.95,

  /** Exclude markets where price is below this (almost certain NO, no edge) */
  MIN_PRICE_THRESHOLD: 0.05,
} as const;

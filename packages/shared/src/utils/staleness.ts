// =============================================================================
// Staleness Detection Utilities
// =============================================================================

/**
 * Staleness status enum
 */
export type StalenessStatus = 'fresh' | 'warning' | 'stale' | 'critical';

/**
 * Staleness check result
 */
export interface StalenessCheck {
  status: StalenessStatus;
  ageMs: number;
  threshold: number;
  isTradeSafe: boolean;
  message: string;
}

/**
 * Default staleness thresholds in milliseconds
 */
export const DEFAULT_STALENESS_THRESHOLDS = {
  /** Order book data - critical for trading */
  orderbook: {
    fresh: 2000,      // < 2s = fresh
    warning: 5000,    // < 5s = warning
    stale: 10000,     // < 10s = stale
    critical: 30000,  // >= 30s = critical
  },

  /** Trade data */
  trade: {
    fresh: 5000,
    warning: 10000,
    stale: 30000,
    critical: 60000,
  },

  /** Market metadata */
  market: {
    fresh: 60000,      // 1 min
    warning: 300000,   // 5 min
    stale: 600000,     // 10 min
    critical: 3600000, // 1 hour
  },

  /** Wallet enrichment */
  wallet: {
    fresh: 3600000,    // 1 hour
    warning: 7200000,  // 2 hours
    stale: 21600000,   // 6 hours
    critical: 86400000, // 24 hours
  },

  /** Feature computation */
  features: {
    fresh: 2000,
    warning: 5000,
    stale: 10000,
    critical: 30000,
  },

  /** Scores */
  scores: {
    fresh: 2000,
    warning: 5000,
    stale: 10000,
    critical: 30000,
  },
} as const;

export type DataType = keyof typeof DEFAULT_STALENESS_THRESHOLDS;

/**
 * Check staleness of a data point
 *
 * @param lastUpdateMs Timestamp of last update
 * @param dataType Type of data being checked
 * @param currentTime Current timestamp (defaults to now)
 */
export function checkStaleness(
  lastUpdateMs: number,
  dataType: DataType,
  currentTime: number = Date.now()
): StalenessCheck {
  const thresholds = DEFAULT_STALENESS_THRESHOLDS[dataType];
  const ageMs = currentTime - lastUpdateMs;

  let status: StalenessStatus;
  let isTradeSafe: boolean;
  let message: string;

  if (ageMs < thresholds.fresh) {
    status = 'fresh';
    isTradeSafe = true;
    message = `${dataType} data is fresh (${ageMs}ms old)`;
  } else if (ageMs < thresholds.warning) {
    status = 'warning';
    isTradeSafe = true;
    message = `${dataType} data is slightly old (${ageMs}ms)`;
  } else if (ageMs < thresholds.stale) {
    status = 'stale';
    isTradeSafe = false;
    message = `${dataType} data is stale (${ageMs}ms) - NO TRADE`;
  } else {
    status = 'critical';
    isTradeSafe = false;
    message = `${dataType} data is critically stale (${ageMs}ms) - NO TRADE`;
  }

  return {
    status,
    ageMs,
    threshold: thresholds.stale,
    isTradeSafe,
    message,
  };
}

/**
 * Check if data is trade-safe (not stale)
 */
export function isTradeSafe(
  lastUpdateMs: number,
  dataType: DataType,
  currentTime: number = Date.now()
): boolean {
  return checkStaleness(lastUpdateMs, dataType, currentTime).isTradeSafe;
}

/**
 * Combined staleness check for multiple data sources
 */
export interface CombinedStalenessCheck {
  overallStatus: StalenessStatus;
  isTradeSafe: boolean;
  checks: Record<string, StalenessCheck>;
  staleDataTypes: string[];
  message: string;
}

/**
 * Check staleness across multiple data sources
 */
export function checkCombinedStaleness(
  updates: Record<string, { lastUpdate: number; dataType: DataType }>,
  currentTime: number = Date.now()
): CombinedStalenessCheck {
  const checks: Record<string, StalenessCheck> = {};
  const staleDataTypes: string[] = [];
  let worstStatus: StalenessStatus = 'fresh';

  const statusPriority: Record<StalenessStatus, number> = {
    fresh: 0,
    warning: 1,
    stale: 2,
    critical: 3,
  };

  for (const [key, { lastUpdate, dataType }] of Object.entries(updates)) {
    const check = checkStaleness(lastUpdate, dataType, currentTime);
    checks[key] = check;

    if (statusPriority[check.status] > statusPriority[worstStatus]) {
      worstStatus = check.status;
    }

    if (!check.isTradeSafe) {
      staleDataTypes.push(key);
    }
  }

  const isTradeSafe = staleDataTypes.length === 0;
  let message: string;

  if (isTradeSafe) {
    message = 'All data sources are fresh - trading enabled';
  } else {
    message = `Stale data detected in: ${staleDataTypes.join(', ')} - NO TRADE`;
  }

  return {
    overallStatus: worstStatus,
    isTradeSafe,
    checks,
    staleDataTypes,
    message,
  };
}

/**
 * Create a staleness tracker for real-time monitoring
 */
export function createStalenessTracker() {
  const lastUpdates: Map<string, { timestamp: number; dataType: DataType }> = new Map();

  return {
    /**
     * Record an update
     */
    recordUpdate(key: string, dataType: DataType, timestamp: number = Date.now()) {
      lastUpdates.set(key, { timestamp, dataType });
    },

    /**
     * Check a specific key
     */
    check(key: string, currentTime: number = Date.now()): StalenessCheck | null {
      const record = lastUpdates.get(key);
      if (!record) return null;
      return checkStaleness(record.timestamp, record.dataType, currentTime);
    },

    /**
     * Check all tracked keys
     */
    checkAll(currentTime: number = Date.now()): CombinedStalenessCheck {
      const updates: Record<string, { lastUpdate: number; dataType: DataType }> = {};

      for (const [key, { timestamp, dataType }] of lastUpdates.entries()) {
        updates[key] = { lastUpdate: timestamp, dataType };
      }

      return checkCombinedStaleness(updates, currentTime);
    },

    /**
     * Get all stale keys
     */
    getStaleKeys(currentTime: number = Date.now()): string[] {
      const stale: string[] = [];

      for (const [key, { timestamp, dataType }] of lastUpdates.entries()) {
        if (!isTradeSafe(timestamp, dataType, currentTime)) {
          stale.push(key);
        }
      }

      return stale;
    },

    /**
     * Check if trading is safe across all data
     */
    isTradingSafe(currentTime: number = Date.now()): boolean {
      return this.getStaleKeys(currentTime).length === 0;
    },

    /**
     * Clear a key
     */
    clear(key: string) {
      lastUpdates.delete(key);
    },

    /**
     * Clear all keys
     */
    clearAll() {
      lastUpdates.clear();
    },
  };
}

export type StalenessTracker = ReturnType<typeof createStalenessTracker>;

// =============================================================================
// Mock Polygonscan API Client
// =============================================================================
//
// Mock implementation of the Polygonscan client for testing purposes.
// Returns configurable wallet data without making actual API calls.

export interface WalletFirstSeenResult {
  firstSeenTimestamp: number | null;
  firstSeenBlockNumber: number | null;
  transactionCount: number;
}

export interface MockPolygonscanClientConfig {
  walletData?: Map<string, WalletFirstSeenResult>;
  defaultFirstSeenDaysAgo?: number;
  defaultTransactionCount?: number;
  shouldFail?: boolean;
  failureError?: Error;
}

/**
 * Mock Polygonscan API Client for testing
 */
export class MockPolygonscanClient {
  private config: MockPolygonscanClientConfig;
  private callHistory: Array<{ method: string; args: unknown[] }> = [];

  constructor(config: MockPolygonscanClientConfig = {}) {
    this.config = config;
  }

  /**
   * Update mock configuration
   */
  setConfig(config: Partial<MockPolygonscanClientConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get call history for verification
   */
  getCallHistory(): Array<{ method: string; args: unknown[] }> {
    return [...this.callHistory];
  }

  /**
   * Clear call history
   */
  clearCallHistory(): void {
    this.callHistory = [];
  }

  /**
   * Add wallet data for testing
   */
  addWalletData(address: string, data: WalletFirstSeenResult): void {
    if (!this.config.walletData) {
      this.config.walletData = new Map();
    }
    this.config.walletData.set(address.toLowerCase(), data);
  }

  /**
   * Get first transaction timestamp for a wallet
   */
  async getWalletFirstSeen(address: string): Promise<WalletFirstSeenResult> {
    this.callHistory.push({ method: 'getWalletFirstSeen', args: [address] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Polygonscan API error');
    }

    const normalizedAddress = address.toLowerCase();

    // Check if we have specific data for this wallet
    if (this.config.walletData?.has(normalizedAddress)) {
      return this.config.walletData.get(normalizedAddress)!;
    }

    // Return default data
    const daysAgo = this.config.defaultFirstSeenDaysAgo ?? 90;
    const txCount = this.config.defaultTransactionCount ?? 100;

    return {
      firstSeenTimestamp: Date.now() - daysAgo * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 50000000,
      transactionCount: txCount,
    };
  }

  /**
   * Get transaction count for a wallet
   */
  async getTransactionCount(address: string): Promise<number> {
    this.callHistory.push({ method: 'getTransactionCount', args: [address] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Polygonscan API error');
    }

    const normalizedAddress = address.toLowerCase();

    if (this.config.walletData?.has(normalizedAddress)) {
      return this.config.walletData.get(normalizedAddress)!.transactionCount;
    }

    return this.config.defaultTransactionCount ?? 100;
  }

  /**
   * Get wallet balance (in wei)
   */
  async getBalance(address: string): Promise<bigint> {
    this.callHistory.push({ method: 'getBalance', args: [address] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Polygonscan API error');
    }

    // Return a default balance of 1 MATIC
    return 1000000000000000000n;
  }

  /**
   * Check if address is a contract
   */
  async isContract(address: string): Promise<boolean> {
    this.callHistory.push({ method: 'isContract', args: [address] });

    if (this.config.shouldFail) {
      throw this.config.failureError ?? new Error('Mock Polygonscan API error');
    }

    // Most addresses in tests are EOAs
    return false;
  }
}

/**
 * Create a pre-configured mock client for common test scenarios
 */
export function createMockPolygonscanClient(scenario: 'normal' | 'new_wallets' | 'old_wallets' | 'error' = 'normal'): MockPolygonscanClient {
  switch (scenario) {
    case 'new_wallets':
      return new MockPolygonscanClient({
        defaultFirstSeenDaysAgo: 3, // Very new - < 7 days
        defaultTransactionCount: 5,
      });

    case 'old_wallets':
      return new MockPolygonscanClient({
        defaultFirstSeenDaysAgo: 365, // Old - > 180 days
        defaultTransactionCount: 1000,
      });

    case 'error':
      return new MockPolygonscanClient({
        shouldFail: true,
        failureError: new Error('Polygonscan API rate limited'),
      });

    default:
      return new MockPolygonscanClient({
        defaultFirstSeenDaysAgo: 90,
        defaultTransactionCount: 100,
      });
  }
}

/**
 * Pre-defined wallet scenarios for testing
 */
export const mockWalletScenarios = {
  /**
   * Very new wallet - created 2 days ago, 3 transactions
   * Should have high wallet_new_score (1.0)
   */
  veryNew: {
    address: '0x' + 'a'.repeat(40),
    data: {
      firstSeenTimestamp: Date.now() - 2 * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 55000000,
      transactionCount: 3,
    } as WalletFirstSeenResult,
  },

  /**
   * New wallet - created 15 days ago, 20 transactions
   * Should have wallet_new_score of 0.7
   */
  new: {
    address: '0x' + 'b'.repeat(40),
    data: {
      firstSeenTimestamp: Date.now() - 15 * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 53000000,
      transactionCount: 20,
    } as WalletFirstSeenResult,
  },

  /**
   * Moderate wallet - created 60 days ago, 100 transactions
   * Should have wallet_new_score of 0.3
   */
  moderate: {
    address: '0x' + 'c'.repeat(40),
    data: {
      firstSeenTimestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 48000000,
      transactionCount: 100,
    } as WalletFirstSeenResult,
  },

  /**
   * Established wallet - created 1 year ago, 1000 transactions
   * Should have wallet_new_score of 0.0
   */
  established: {
    address: '0x' + 'd'.repeat(40),
    data: {
      firstSeenTimestamp: Date.now() - 365 * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 30000000,
      transactionCount: 1000,
    } as WalletFirstSeenResult,
  },

  /**
   * Suspicious new wallet - very new with single large trade
   * Combination of new + low activity = high risk
   */
  suspicious: {
    address: '0x' + 'e'.repeat(40),
    data: {
      firstSeenTimestamp: Date.now() - 1 * 24 * 60 * 60 * 1000,
      firstSeenBlockNumber: 56000000,
      transactionCount: 1,
    } as WalletFirstSeenResult,
  },

  /**
   * Unknown wallet - never seen before
   */
  unknown: {
    address: '0x' + 'f'.repeat(40),
    data: {
      firstSeenTimestamp: null,
      firstSeenBlockNumber: null,
      transactionCount: 0,
    } as WalletFirstSeenResult,
  },
};

/**
 * Create a mock client pre-loaded with all wallet scenarios
 */
export function createMockPolygonscanClientWithScenarios(): MockPolygonscanClient {
  const client = new MockPolygonscanClient();

  Object.values(mockWalletScenarios).forEach(scenario => {
    client.addWalletData(scenario.address, scenario.data);
  });

  return client;
}

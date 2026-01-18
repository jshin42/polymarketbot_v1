import { PolygonscanTxResponseSchema, createLogger } from '@polymarketbot/shared';

// =============================================================================
// Polygonscan API Client
// =============================================================================

const POLYGONSCAN_BASE_URL = 'https://api.polygonscan.com/api';

interface PolygonscanConfig {
  apiKey: string;
  timeout?: number;
}

interface WalletFirstSeenResult {
  firstSeenTimestamp: number | null;
  firstSeenBlockNumber: number | null;
  transactionCount: number;
}

export class PolygonscanClient {
  private readonly logger = createLogger('polygonscan-client');
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(config: PolygonscanConfig) {
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Get first transaction timestamp for a wallet
   */
  async getWalletFirstSeen(address: string): Promise<WalletFirstSeenResult> {
    const normalizedAddress = address.toLowerCase();

    try {
      // Get normal transactions (first one)
      const params = new URLSearchParams({
        module: 'account',
        action: 'txlist',
        address: normalizedAddress,
        startblock: '0',
        endblock: '99999999',
        page: '1',
        offset: '1',
        sort: 'asc',
        apikey: this.apiKey,
      });

      const url = `${POLYGONSCAN_BASE_URL}?${params.toString()}`;
      const response = await this.request(url);

      const parsed = PolygonscanTxResponseSchema.parse(response);

      // Check if result is an error string
      if (typeof parsed.result === 'string') {
        this.logger.warn({ address, result: parsed.result }, 'Polygonscan returned error string');
        return {
          firstSeenTimestamp: null,
          firstSeenBlockNumber: null,
          transactionCount: 0,
        };
      }

      // Check if we got transactions
      if (parsed.result.length === 0) {
        // No transactions found - wallet has never been used
        return {
          firstSeenTimestamp: null,
          firstSeenBlockNumber: null,
          transactionCount: 0,
        };
      }

      const firstTx = parsed.result[0]!;
      const timestamp = parseInt(firstTx.timeStamp, 10) * 1000; // Convert to milliseconds
      const blockNumber = parseInt(firstTx.blockNumber, 10);

      // Get total transaction count
      const txCount = await this.getTransactionCount(normalizedAddress);

      return {
        firstSeenTimestamp: timestamp,
        firstSeenBlockNumber: blockNumber,
        transactionCount: txCount,
      };
    } catch (error) {
      this.logger.error({ error, address }, 'Failed to get wallet first seen');
      return {
        firstSeenTimestamp: null,
        firstSeenBlockNumber: null,
        transactionCount: 0,
      };
    }
  }

  /**
   * Get transaction count for a wallet
   */
  async getTransactionCount(address: string): Promise<number> {
    const normalizedAddress = address.toLowerCase();

    try {
      const params = new URLSearchParams({
        module: 'proxy',
        action: 'eth_getTransactionCount',
        address: normalizedAddress,
        tag: 'latest',
        apikey: this.apiKey,
      });

      const url = `${POLYGONSCAN_BASE_URL}?${params.toString()}`;
      const response = await this.request(url);

      const data = response as { result?: string };

      if (!data.result) {
        return 0;
      }

      // Result is hex string
      return parseInt(data.result, 16);
    } catch (error) {
      this.logger.error({ error, address }, 'Failed to get transaction count');
      return 0;
    }
  }

  /**
   * Get wallet balance (in wei)
   */
  async getBalance(address: string): Promise<bigint> {
    const normalizedAddress = address.toLowerCase();

    try {
      const params = new URLSearchParams({
        module: 'account',
        action: 'balance',
        address: normalizedAddress,
        tag: 'latest',
        apikey: this.apiKey,
      });

      const url = `${POLYGONSCAN_BASE_URL}?${params.toString()}`;
      const response = await this.request(url);

      const data = response as { status: string; result?: string };

      if (data.status !== '1' || !data.result) {
        return 0n;
      }

      return BigInt(data.result);
    } catch (error) {
      this.logger.error({ error, address }, 'Failed to get balance');
      return 0n;
    }
  }

  /**
   * Check if address is a contract
   */
  async isContract(address: string): Promise<boolean> {
    const normalizedAddress = address.toLowerCase();

    try {
      const params = new URLSearchParams({
        module: 'proxy',
        action: 'eth_getCode',
        address: normalizedAddress,
        tag: 'latest',
        apikey: this.apiKey,
      });

      const url = `${POLYGONSCAN_BASE_URL}?${params.toString()}`;
      const response = await this.request(url);

      const data = response as { result?: string };

      if (!data.result) {
        return false;
      }

      // If result is "0x", it's an EOA. Otherwise, it's a contract.
      return data.result !== '0x';
    } catch (error) {
      this.logger.error({ error, address }, 'Failed to check if contract');
      return false;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async request(url: string): Promise<unknown> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new PolygonscanApiError(
          response.status,
          `Polygonscan API error: ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof PolygonscanApiError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new PolygonscanApiError(408, `Request timeout after ${this.timeout}ms`);
      }

      this.logger.error({ error, url }, 'Polygonscan request failed');
      throw new PolygonscanApiError(500, `Request failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Polygonscan API Error
 */
export class PolygonscanApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'PolygonscanApiError';
  }
}

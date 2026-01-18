import {
  POLYMARKET_ENDPOINTS,
  DataApiTradeResponse,
  DataApiTradeResponseSchema,
  createLogger,
} from '@polymarketbot/shared';

// =============================================================================
// Data API Client
// =============================================================================

const DATA_API_BASE = POLYMARKET_ENDPOINTS.DATA_API_BASE;

interface GetTradesParams {
  market?: string; // conditionId
  asset?: string; // tokenId
  user?: string; // wallet address
  limit?: number; // 0-500, default 100
  offset?: number; // 0-10000
  start?: number; // Unix timestamp (seconds)
  end?: number; // Unix timestamp (seconds)
  side?: 'BUY' | 'SELL';
  sortBy?: 'TIMESTAMP' | 'SIZE' | 'PRICE';
  sortDirection?: 'ASC' | 'DESC';
}

export class DataApiClient {
  private readonly logger = createLogger('data-api-client');
  private readonly timeout: number;

  constructor(timeout: number = 30000) {
    this.timeout = timeout;
  }

  /**
   * Get trades for a market (by conditionId)
   * NO AUTHENTICATION REQUIRED
   */
  async getMarketTrades(
    conditionId: string,
    options: Omit<GetTradesParams, 'market'> = {}
  ): Promise<DataApiTradeResponse[]> {
    return this.getTrades({ market: conditionId, ...options });
  }

  /**
   * Get trades for a specific token (filters client-side by asset)
   */
  async getTokenTrades(
    conditionId: string,
    tokenId: string,
    options: Omit<GetTradesParams, 'market' | 'asset'> = {}
  ): Promise<DataApiTradeResponse[]> {
    const trades = await this.getTrades({ market: conditionId, ...options });
    return trades.filter((t) => t.asset === tokenId);
  }

  /**
   * Get recent platform-wide trades
   */
  async getRecentTrades(limit: number = 100): Promise<DataApiTradeResponse[]> {
    return this.getTrades({ limit, sortDirection: 'DESC' });
  }

  /**
   * Generic trade fetch with parameters
   */
  async getTrades(params: GetTradesParams = {}): Promise<DataApiTradeResponse[]> {
    const searchParams = new URLSearchParams();

    if (params.market) searchParams.set('market', params.market);
    if (params.asset) searchParams.set('asset', params.asset);
    if (params.user) searchParams.set('user', params.user);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));
    if (params.start) searchParams.set('start', String(params.start));
    if (params.end) searchParams.set('end', String(params.end));
    if (params.side) searchParams.set('side', params.side);
    if (params.sortBy) searchParams.set('sortBy', params.sortBy);
    if (params.sortDirection) searchParams.set('sortDirection', params.sortDirection);

    const url = `${DATA_API_BASE}/trades?${searchParams.toString()}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new DataApiError(
          response.status,
          `Data API error: ${response.statusText} - ${errorText}`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        this.logger.warn({ data }, 'Unexpected trades response format');
        return [];
      }

      const trades: DataApiTradeResponse[] = [];
      for (const trade of data) {
        try {
          trades.push(DataApiTradeResponseSchema.parse(trade));
        } catch (error) {
          this.logger.warn({ error, trade }, 'Failed to parse trade');
        }
      }

      return trades;
    } catch (error) {
      if (error instanceof DataApiError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new DataApiError(408, `Request timeout after ${this.timeout}ms`);
      }
      this.logger.error({ error, url }, 'Data API request failed');
      throw new DataApiError(500, `Request failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Data API Error
 */
export class DataApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'DataApiError';
  }
}

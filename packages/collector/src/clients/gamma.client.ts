import {
  POLYMARKET_ENDPOINTS,
  GammaMarketResponse,
  GammaMarketResponseSchema,
  createLogger,
} from '@polymarketbot/shared';

// =============================================================================
// Gamma API Client
// =============================================================================

const GAMMA_BASE_URL = POLYMARKET_ENDPOINTS.GAMMA_BASE;

interface GetMarketsParams {
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  limit?: number;
  offset?: number;
  endDateMin?: string;
  endDateMax?: string;
}

export class GammaClient {
  private readonly logger = createLogger('gamma-client');
  private readonly timeout: number;

  constructor(timeout: number = 30000) {
    this.timeout = timeout;
  }

  /**
   * Get markets with filters
   */
  async getMarkets(params: GetMarketsParams = {}): Promise<GammaMarketResponse[]> {
    const searchParams = new URLSearchParams();

    if (params.active !== undefined) searchParams.set('active', String(params.active));
    if (params.closed !== undefined) searchParams.set('closed', String(params.closed));
    if (params.archived !== undefined) searchParams.set('archived', String(params.archived));
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));
    if (params.endDateMin) searchParams.set('end_date_min', params.endDateMin);
    if (params.endDateMax) searchParams.set('end_date_max', params.endDateMax);

    const url = `${GAMMA_BASE_URL}/markets?${searchParams.toString()}`;
    const response = await this.request(url);

    if (!Array.isArray(response)) {
      this.logger.warn({ response }, 'Unexpected markets response format');
      return [];
    }

    const markets: GammaMarketResponse[] = [];
    for (const market of response) {
      try {
        markets.push(GammaMarketResponseSchema.parse(market));
      } catch (error) {
        this.logger.warn({ error, market }, 'Failed to parse market');
      }
    }

    return markets;
  }

  /**
   * Get a single market by condition ID
   */
  async getMarket(conditionId: string): Promise<GammaMarketResponse | null> {
    const url = `${GAMMA_BASE_URL}/markets/${encodeURIComponent(conditionId)}`;

    try {
      const response = await this.request(url);
      return GammaMarketResponseSchema.parse(response);
    } catch (error) {
      if (error instanceof GammaApiError && error.statusCode === 404) {
        this.logger.debug({ conditionId }, 'Market not found');
        return null;
      }
      throw error;
    }
  }

  /**
   * Get markets closing soon (within specified hours)
   * Uses pagination to fetch ALL matching markets, not just first 100
   */
  async getMarketsClosingSoon(withinHours: number): Promise<GammaMarketResponse[]> {
    const now = new Date();
    const endDateMax = new Date(now.getTime() + withinHours * 60 * 60 * 1000);

    const allMarkets: GammaMarketResponse[] = [];
    let offset = 0;
    const limit = 100;
    let totalFetched = 0;

    // Paginate through all results
    while (true) {
      const batch = await this.getMarkets({
        active: true,
        closed: false,
        archived: false,
        endDateMin: now.toISOString(),
        endDateMax: endDateMax.toISOString(),
        limit,
        offset,
      });

      allMarkets.push(...batch);
      totalFetched += batch.length;

      // If we got fewer than limit, we've reached the end
      if (batch.length < limit) {
        this.logger.debug(
          { totalFetched, pages: Math.ceil(totalFetched / limit) || 1, withinHours },
          'Finished paginating markets'
        );
        break;
      }

      offset += limit;

      // Safety limit to prevent infinite loops (max 5000 markets)
      if (offset >= 5000) {
        this.logger.warn({ totalFetched }, 'Hit safety limit on market pagination');
        break;
      }
    }

    // Sort by end date ascending (closest to closing first)
    return allMarkets.sort((a, b) => {
      const aEnd = new Date(a.endDate ?? a.endDateIso ?? '').getTime();
      const bEnd = new Date(b.endDate ?? b.endDateIso ?? '').getTime();
      return aEnd - bEnd;
    });
  }

  /**
   * Get all active markets
   */
  async getActiveMarkets(limit: number = 100): Promise<GammaMarketResponse[]> {
    return this.getMarkets({
      active: true,
      closed: false,
      archived: false,
      limit,
    });
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit: number = 20): Promise<GammaMarketResponse[]> {
    const url = `${GAMMA_BASE_URL}/search-markets?query=${encodeURIComponent(query)}&limit=${limit}`;

    try {
      const response = await this.request(url);

      if (!Array.isArray(response)) {
        this.logger.warn({ response }, 'Unexpected search response format');
        return [];
      }

      const markets: GammaMarketResponse[] = [];
      for (const market of response) {
        try {
          markets.push(GammaMarketResponseSchema.parse(market));
        } catch (error) {
          this.logger.warn({ error, market }, 'Failed to parse search result');
        }
      }

      return markets;
    } catch (error) {
      this.logger.error({ error, query }, 'Search markets failed');
      return [];
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
        headers: {
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new GammaApiError(
          response.status,
          `Gamma API error: ${response.statusText} - ${errorText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof GammaApiError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new GammaApiError(408, `Request timeout after ${this.timeout}ms`);
      }

      this.logger.error({ error, url }, 'Gamma API request failed');
      throw new GammaApiError(500, `Request failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Gamma API Error
 */
export class GammaApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'GammaApiError';
  }
}

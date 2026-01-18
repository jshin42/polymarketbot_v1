import {
  POLYMARKET_ENDPOINTS,
  createLogger,
  ClobOrderbookResponse,
  ClobOrderbookResponseSchema,
  ClobTradeResponse,
  ClobTradeResponseSchema,
} from '@polymarketbot/shared';
import crypto from 'crypto';

// =============================================================================
// CLOB REST Client
// =============================================================================

const CLOB_BASE_URL = POLYMARKET_ENDPOINTS.CLOB_BASE;

interface ClobClientConfig {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
  address?: string;
  timeout?: number;
}

interface MidpointResponse {
  mid: string;
}

interface PriceResponse {
  price: string;
}

interface OrderRequest {
  tokenID: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  feeRateBps?: string;
  nonce?: number;
  expiration?: number;
}

interface OrderResponse {
  orderID: string;
  status: string;
  [key: string]: unknown;
}

export class ClobRestClient {
  private readonly logger = createLogger('clob-rest-client');
  private readonly config: ClobClientConfig;
  private readonly timeout: number;

  constructor(config: ClobClientConfig = {}) {
    this.config = config;
    this.timeout = config.timeout ?? 30000;
  }

  // ===========================================================================
  // Public Endpoints (No Auth Required)
  // ===========================================================================

  /**
   * Get order book for a token
   */
  async getOrderbook(tokenId: string): Promise<ClobOrderbookResponse> {
    const url = `${CLOB_BASE_URL}/book?token_id=${encodeURIComponent(tokenId)}`;
    const response = await this.request('GET', url);
    return ClobOrderbookResponseSchema.parse(response);
  }

  /**
   * Get midpoint price for a token
   */
  async getMidpoint(tokenId: string): Promise<number> {
    const url = `${CLOB_BASE_URL}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const response = await this.request('GET', url);
    const data = response as MidpointResponse;
    return parseFloat(data.mid);
  }

  /**
   * Get best price for a side
   */
  async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number> {
    const url = `${CLOB_BASE_URL}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`;
    const response = await this.request('GET', url);
    const data = response as PriceResponse;
    return parseFloat(data.price);
  }

  /**
   * Get recent trades for a token
   * NOTE: As of 2025, Polymarket requires authentication for the /trades endpoint
   */
  async getTrades(tokenId: string, limit: number = 100): Promise<ClobTradeResponse[]> {
    const url = `${CLOB_BASE_URL}/trades?token_id=${encodeURIComponent(tokenId)}&limit=${limit}`;

    let response: unknown;

    // Use authenticated request if credentials are available (required as of 2025)
    if (this.hasAuthCredentials()) {
      response = await this.authenticatedRequest('GET', url);
    } else {
      // Fallback to unauthenticated (will likely fail on newer API versions)
      this.logger.warn('Fetching trades without authentication - this may fail');
      response = await this.request('GET', url);
    }

    if (!Array.isArray(response)) {
      this.logger.warn({ response }, 'Unexpected trades response format');
      return [];
    }

    return response.map(trade => ClobTradeResponseSchema.parse(trade));
  }

  /**
   * Get sampling markets (active markets for monitoring)
   */
  async getSamplingMarkets(): Promise<string[]> {
    const url = `${CLOB_BASE_URL}/sampling-markets`;
    const response = await this.request('GET', url);

    if (!Array.isArray(response)) {
      this.logger.warn({ response }, 'Unexpected sampling markets response');
      return [];
    }

    return response;
  }

  /**
   * Get sampling simplified markets
   */
  async getSamplingSimplifiedMarkets(next_cursor?: string): Promise<{
    limit: number;
    count: number;
    next_cursor: string;
    data: Array<{ condition_id: string; [key: string]: unknown }>;
  }> {
    let url = `${CLOB_BASE_URL}/sampling-simplified-markets`;
    if (next_cursor) {
      url += `?next_cursor=${encodeURIComponent(next_cursor)}`;
    }

    const response = await this.request('GET', url);
    return response as {
      limit: number;
      count: number;
      next_cursor: string;
      data: Array<{ condition_id: string; [key: string]: unknown }>;
    };
  }

  // ===========================================================================
  // Authenticated Endpoints (L2 Auth Required)
  // ===========================================================================

  /**
   * Place an order (requires authentication)
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    this.requireAuth();
    const url = `${CLOB_BASE_URL}/order`;
    const response = await this.authenticatedRequest('POST', url, order);
    return response as OrderResponse;
  }

  /**
   * Cancel an order (requires authentication)
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.requireAuth();
    const url = `${CLOB_BASE_URL}/order/${encodeURIComponent(orderId)}`;
    await this.authenticatedRequest('DELETE', url);
  }

  /**
   * Get active orders (requires authentication)
   */
  async getActiveOrders(): Promise<OrderResponse[]> {
    this.requireAuth();
    const url = `${CLOB_BASE_URL}/active-orders`;
    const response = await this.authenticatedRequest('GET', url);

    if (!Array.isArray(response)) {
      return [];
    }

    return response as OrderResponse[];
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async request(method: string, url: string): Promise<unknown> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new ClobApiError(
          response.status,
          `CLOB API error: ${response.statusText} - ${errorText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ClobApiError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new ClobApiError(408, `Request timeout after ${this.timeout}ms`);
      }

      this.logger.error({ error, url }, 'CLOB API request failed');
      throw new ClobApiError(500, `Request failed: ${(error as Error).message}`);
    }
  }

  private async authenticatedRequest(
    method: string,
    url: string,
    body?: unknown
  ): Promise<unknown> {
    // Subtract 5 seconds to compensate for clock skew between client and server
    // This is a common fix for Polymarket 401 Unauthorized errors
    const timestamp = Math.floor((Date.now() - 5000) / 1000).toString();
    const parsedUrl = new URL(url);
    // Include query string in the path for signature - Polymarket requires full path
    const path = parsedUrl.pathname + parsedUrl.search;
    const signature = this.signRequest(method, path, timestamp, body);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'POLY_ADDRESS': this.config.address!,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_API_KEY': this.config.apiKey!,
      'POLY_PASSPHRASE': this.config.passphrase!,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new ClobApiError(
          response.status,
          `Authenticated request failed: ${response.statusText} - ${errorText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ClobApiError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new ClobApiError(408, `Authenticated request timeout after ${this.timeout}ms`);
      }

      this.logger.error({ error, url }, 'Authenticated CLOB request failed');
      throw new ClobApiError(500, `Authenticated request failed: ${(error as Error).message}`);
    }
  }

  private signRequest(
    method: string,
    path: string,
    timestamp: string,
    body?: unknown
  ): string {
    const message = timestamp + method + path + (body ? JSON.stringify(body) : '');

    // Decode the secret from base64 (handle both standard and URL-safe base64)
    const secretBase64 = this.config.secret!.replace(/-/g, '+').replace(/_/g, '/');
    const hmac = crypto.createHmac('sha256', Buffer.from(secretBase64, 'base64'));
    hmac.update(message);

    // Return URL-safe base64 signature (replace + with - and / with _)
    const signature = hmac.digest('base64');
    return signature.replace(/\+/g, '-').replace(/\//g, '_');
  }

  private requireAuth(): void {
    if (!this.config.apiKey || !this.config.secret || !this.config.passphrase || !this.config.address) {
      throw new Error(
        'Authentication credentials required for this endpoint. Set apiKey, secret, passphrase, and address in config.'
      );
    }
  }

  private hasAuthCredentials(): boolean {
    return !!(
      this.config.apiKey &&
      this.config.secret &&
      this.config.passphrase &&
      this.config.address
    );
  }
}

/**
 * CLOB API Error
 */
export class ClobApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ClobApiError';
  }
}

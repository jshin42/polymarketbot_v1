import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { POLYMARKET_ENDPOINTS, WsTradeEventSchema, createLogger } from '@polymarketbot/shared';

// =============================================================================
// CLOB WebSocket Client
// =============================================================================

const WSS_BASE_URL = POLYMARKET_ENDPOINTS.WS_BASE;

interface WsMessage {
  event_type: string;
  asset_id?: string;
  market?: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface OrderbookEvent {
  assetId: string;
  market?: string;
  timestamp: number;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash?: string;
}

interface TradeEvent {
  assetId: string;
  market?: string;
  price: string;
  size: string;
  side: string;
  feeRateBps?: string;
  timestamp: number;
}

interface BestBidAskEvent {
  assetId: string;
  market?: string;
  bestBid: string;
  bestAsk: string;
  spread: string;
  timestamp: number;
}

interface PriceChangeEvent {
  market?: string;
  priceChanges: unknown;
  timestamp: number;
}

export interface ClobWebSocketEvents {
  orderbook: (event: OrderbookEvent) => void;
  trade: (event: TradeEvent) => void;
  bestBidAsk: (event: BestBidAskEvent) => void;
  priceChange: (event: PriceChangeEvent) => void;
  tickSizeChange: (event: WsMessage) => void;
  marketResolved: (event: WsMessage) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  maxReconnectAttempts: () => void;
}

export declare interface ClobWebSocketClient {
  on<E extends keyof ClobWebSocketEvents>(
    event: E,
    listener: ClobWebSocketEvents[E]
  ): this;
  emit<E extends keyof ClobWebSocketEvents>(
    event: E,
    ...args: Parameters<ClobWebSocketEvents[E]>
  ): boolean;
}

export class ClobWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly logger = createLogger('clob-ws-client');
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private subscribedAssets: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private isIntentionallyClosed = false;

  constructor(maxReconnectAttempts: number = 10) {
    super();
    this.maxReconnectAttempts = maxReconnectAttempts;
  }

  /**
   * Connect to WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isIntentionallyClosed = false;

      this.ws = new WebSocket(WSS_BASE_URL);

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.terminate();
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.logger.info('WebSocket connected');
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.startPingInterval();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as WsMessage;
          this.handleMessage(message);
        } catch (error) {
          this.logger.error({ error, data: data.toString() }, 'Failed to parse WebSocket message');
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.logger.warn({ code, reason: reason.toString() }, 'WebSocket disconnected');
        this.stopPingInterval();
        this.emit('disconnected');

        if (!this.isIntentionallyClosed) {
          this.handleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error({ error }, 'WebSocket error');
        this.emit('error', error);
        reject(error);
      });

      this.ws.on('ping', () => {
        this.ws?.pong();
      });
    });
  }

  /**
   * Subscribe to asset updates
   */
  subscribe(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const newAssets = assetIds.filter((id) => !this.subscribedAssets.has(id));
    if (newAssets.length === 0) {
      this.logger.debug('All assets already subscribed');
      return;
    }

    const message = {
      assets_ids: newAssets,
      type: 'MARKET',
    };

    this.ws.send(JSON.stringify(message));
    newAssets.forEach((id) => this.subscribedAssets.add(id));
    this.logger.info({ assetIds: newAssets, totalSubscribed: this.subscribedAssets.size }, 'Subscribed to assets');
  }

  /**
   * Unsubscribe from asset updates
   */
  unsubscribe(assetIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot unsubscribe: WebSocket not connected');
      return;
    }

    const subscribedToRemove = assetIds.filter((id) => this.subscribedAssets.has(id));
    if (subscribedToRemove.length === 0) {
      this.logger.debug('No subscribed assets to remove');
      return;
    }

    const message = {
      assets_ids: subscribedToRemove,
      operation: 'unsubscribe',
    };

    this.ws.send(JSON.stringify(message));
    subscribedToRemove.forEach((id) => this.subscribedAssets.delete(id));
    this.logger.info({ assetIds: subscribedToRemove, totalSubscribed: this.subscribedAssets.size }, 'Unsubscribed from assets');
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;
    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscribedAssets.clear();
    this.logger.info('WebSocket disconnected intentionally');
  }

  /**
   * Get subscribed assets
   */
  getSubscribedAssets(): string[] {
    return Array.from(this.subscribedAssets);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private handleMessage(message: WsMessage): void {
    const { event_type } = message;

    switch (event_type) {
      case 'book':
        this.emit('orderbook', {
          assetId: message.asset_id!,
          market: message.market,
          timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
          bids: message.buys as Array<{ price: string; size: string }>,
          asks: message.sells as Array<{ price: string; size: string }>,
          hash: message.hash as string | undefined,
        });
        break;

      case 'price_change':
        this.emit('priceChange', {
          market: message.market,
          priceChanges: message.price_changes,
          timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
        });
        break;

      case 'last_trade_price':
        // Validate with Zod schema
        try {
          const validated = WsTradeEventSchema.parse(message);
          this.emit('trade', {
            assetId: validated.asset_id,
            market: validated.market,
            price: validated.price,
            size: validated.size,
            side: validated.side,
            feeRateBps: validated.fee_rate_bps,
            timestamp: validated.timestamp ? new Date(validated.timestamp).getTime() : Date.now(),
          });
        } catch (error) {
          this.logger.warn({ error, message }, 'Invalid trade event');
        }
        break;

      case 'best_bid_ask':
        this.emit('bestBidAsk', {
          assetId: message.asset_id!,
          market: message.market,
          bestBid: message.best_bid as string,
          bestAsk: message.best_ask as string,
          spread: message.spread as string,
          timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
        });
        break;

      case 'tick_size_change':
        this.emit('tickSizeChange', message);
        break;

      case 'market_resolved':
        this.emit('marketResolved', message);
        break;

      default:
        this.logger.debug({ event_type }, 'Unknown WebSocket event type');
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        { attempts: this.reconnectAttempts },
        'Max reconnection attempts reached'
      );
      this.emit('maxReconnectAttempts');
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;

    this.logger.info(
      { delay, attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts },
      'Scheduling reconnection'
    );

    setTimeout(async () => {
      try {
        await this.connect();

        // Resubscribe to all assets
        if (this.subscribedAssets.size > 0) {
          const assets = Array.from(this.subscribedAssets);
          this.subscribedAssets.clear(); // Clear so subscribe() doesn't skip them
          this.subscribe(assets);
        }
      } catch (error) {
        this.logger.error({ error, attempt: this.reconnectAttempts }, 'Reconnection failed');
      }
    }, delay);
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // 30 seconds
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

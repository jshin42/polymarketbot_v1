// =============================================================================
// Mock CLOB WebSocket Client
// =============================================================================
//
// Mock implementation of the CLOB WebSocket client for testing purposes.
// Emits configurable events without establishing actual WebSocket connections.

import { EventEmitter } from 'events';

export interface OrderbookEvent {
  assetId: string;
  market?: string;
  timestamp: number;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash?: string;
}

export interface TradeEvent {
  assetId: string;
  market?: string;
  price: string;
  size: string;
  side: string;
  feeRateBps?: string;
  timestamp: number;
}

export interface BestBidAskEvent {
  assetId: string;
  market?: string;
  bestBid: string;
  bestAsk: string;
  spread: string;
  timestamp: number;
}

export interface MockClobWsClientConfig {
  autoConnect?: boolean;
  shouldFailConnect?: boolean;
  connectError?: Error;
}

/**
 * Mock CLOB WebSocket Client for testing
 */
export class MockClobWebSocketClient extends EventEmitter {
  private _isConnected = false;
  private _subscribedAssets: Set<string> = new Set();
  private config: MockClobWsClientConfig;
  private callHistory: Array<{ method: string; args: unknown[] }> = [];

  constructor(config: MockClobWsClientConfig = {}) {
    super();
    this.config = config;
    if (config.autoConnect) {
      this._isConnected = true;
    }
  }

  /**
   * Update mock configuration
   */
  setConfig(config: Partial<MockClobWsClientConfig>): void {
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
   * Connect to WebSocket (mock)
   */
  async connect(): Promise<void> {
    this.callHistory.push({ method: 'connect', args: [] });

    if (this.config.shouldFailConnect) {
      throw this.config.connectError ?? new Error('Mock WebSocket connection failed');
    }

    this._isConnected = true;
    this.emit('connected');
  }

  /**
   * Subscribe to asset updates
   */
  subscribe(assetIds: string[]): void {
    this.callHistory.push({ method: 'subscribe', args: [assetIds] });

    if (!this._isConnected) {
      throw new Error('WebSocket not connected');
    }

    assetIds.forEach(id => this._subscribedAssets.add(id));
  }

  /**
   * Unsubscribe from asset updates
   */
  unsubscribe(assetIds: string[]): void {
    this.callHistory.push({ method: 'unsubscribe', args: [assetIds] });

    assetIds.forEach(id => this._subscribedAssets.delete(id));
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    this.callHistory.push({ method: 'disconnect', args: [] });

    this._isConnected = false;
    this._subscribedAssets.clear();
    this.emit('disconnected');
  }

  /**
   * Get subscribed assets
   */
  getSubscribedAssets(): string[] {
    return Array.from(this._subscribedAssets);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._isConnected;
  }

  // ===========================================================================
  // Test Helper Methods
  // ===========================================================================

  /**
   * Simulate receiving an orderbook update
   */
  simulateOrderbook(event: OrderbookEvent): void {
    if (this._subscribedAssets.has(event.assetId)) {
      this.emit('orderbook', event);
    }
  }

  /**
   * Simulate receiving a trade event
   */
  simulateTrade(event: TradeEvent): void {
    if (this._subscribedAssets.has(event.assetId)) {
      this.emit('trade', event);
    }
  }

  /**
   * Simulate receiving a best bid/ask update
   */
  simulateBestBidAsk(event: BestBidAskEvent): void {
    if (this._subscribedAssets.has(event.assetId)) {
      this.emit('bestBidAsk', event);
    }
  }

  /**
   * Simulate a connection error
   */
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  /**
   * Simulate a disconnection
   */
  simulateDisconnect(): void {
    this._isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Simulate max reconnect attempts reached
   */
  simulateMaxReconnectAttempts(): void {
    this.emit('maxReconnectAttempts');
  }
}

/**
 * Create a pre-configured mock WebSocket client
 */
export function createMockClobWsClient(scenario: 'connected' | 'disconnected' | 'error' = 'connected'): MockClobWebSocketClient {
  switch (scenario) {
    case 'disconnected':
      return new MockClobWebSocketClient({ autoConnect: false });

    case 'error':
      return new MockClobWebSocketClient({
        shouldFailConnect: true,
        connectError: new Error('WebSocket connection refused'),
      });

    default:
      return new MockClobWebSocketClient({ autoConnect: true });
  }
}

/**
 * Generate a series of trade events for testing
 */
export function generateMockTradeEvents(
  assetId: string,
  count: number,
  basePrice: number = 0.55,
  baseSize: number = 100
): TradeEvent[] {
  const events: TradeEvent[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < count; i++) {
    events.push({
      assetId,
      price: (basePrice + (Math.random() - 0.5) * 0.1).toFixed(2),
      size: (baseSize + Math.random() * baseSize).toFixed(0),
      side: Math.random() > 0.5 ? 'BUY' : 'SELL',
      feeRateBps: '100',
      timestamp: baseTime + i * 1000,
    });
  }

  return events;
}

/**
 * Generate orderbook snapshot events for testing
 */
export function generateMockOrderbookEvents(
  assetId: string,
  count: number,
  basePrice: number = 0.55
): OrderbookEvent[] {
  const events: OrderbookEvent[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < count; i++) {
    const mid = basePrice + (Math.random() - 0.5) * 0.05;
    events.push({
      assetId,
      timestamp: baseTime + i * 1000,
      bids: [
        { price: (mid - 0.01).toFixed(2), size: (1000 + Math.random() * 1000).toFixed(0) },
        { price: (mid - 0.02).toFixed(2), size: (2000 + Math.random() * 1000).toFixed(0) },
        { price: (mid - 0.03).toFixed(2), size: (3000 + Math.random() * 1000).toFixed(0) },
      ],
      asks: [
        { price: (mid + 0.01).toFixed(2), size: (1000 + Math.random() * 1000).toFixed(0) },
        { price: (mid + 0.02).toFixed(2), size: (2000 + Math.random() * 1000).toFixed(0) },
        { price: (mid + 0.03).toFixed(2), size: (3000 + Math.random() * 1000).toFixed(0) },
      ],
      hash: `hash_${i}`,
    });
  }

  return events;
}

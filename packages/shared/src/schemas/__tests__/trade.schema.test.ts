import { describe, it, expect } from 'vitest';
import {
  TradeSchema,
  TradeSideSchema,
  DataApiTradeResponseSchema,
  ClobTradeResponseSchema,
  transformDataApiTrade,
  transformClobTrade,
} from '../trade.schema.js';

// =============================================================================
// Trade Schema Unit Tests
// =============================================================================

describe('TradeSideSchema', () => {
  it('should accept valid trade sides', () => {
    expect(TradeSideSchema.parse('BUY')).toBe('BUY');
    expect(TradeSideSchema.parse('SELL')).toBe('SELL');
  });

  it('should reject invalid trade sides', () => {
    expect(() => TradeSideSchema.parse('buy')).toThrow();
    expect(() => TradeSideSchema.parse('sell')).toThrow();
    expect(() => TradeSideSchema.parse('HOLD')).toThrow();
    expect(() => TradeSideSchema.parse('')).toThrow();
  });
});

describe('TradeSchema', () => {
  const validTrade = {
    tradeId: 'trade-123',
    tokenId: 'token-456',
    timestamp: 1705000000000,
    makerAddress: '0x1234567890123456789012345678901234567890',
    takerAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    side: 'BUY',
    price: 0.65,
    size: 1000,
  };

  it('should accept valid trade without optional fields', () => {
    const result = TradeSchema.parse(validTrade);
    expect(result.tradeId).toBe('trade-123');
    expect(result.transactionHash).toBeUndefined();
    expect(result.feeRateBps).toBeUndefined();
  });

  it('should accept valid trade with transactionHash', () => {
    const tradeWithTxHash = {
      ...validTrade,
      transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };
    const result = TradeSchema.parse(tradeWithTxHash);
    expect(result.transactionHash).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('should accept valid trade with feeRateBps', () => {
    const tradeWithFee = {
      ...validTrade,
      feeRateBps: 25,
    };
    const result = TradeSchema.parse(tradeWithFee);
    expect(result.feeRateBps).toBe(25);
  });

  it('should reject invalid Ethereum addresses', () => {
    expect(() => TradeSchema.parse({
      ...validTrade,
      makerAddress: '0x123', // Too short
    })).toThrow();

    expect(() => TradeSchema.parse({
      ...validTrade,
      takerAddress: 'invalid-address', // Not hex format
    })).toThrow();
  });

  it('should reject invalid transactionHash format', () => {
    expect(() => TradeSchema.parse({
      ...validTrade,
      transactionHash: '0x123', // Too short
    })).toThrow();

    expect(() => TradeSchema.parse({
      ...validTrade,
      transactionHash: 'invalid-hash', // Not hex format
    })).toThrow();
  });

  it('should reject invalid price values', () => {
    expect(() => TradeSchema.parse({
      ...validTrade,
      price: -0.5, // Negative
    })).toThrow();

    expect(() => TradeSchema.parse({
      ...validTrade,
      price: 1.5, // > 1 (invalid for prediction markets)
    })).toThrow();
  });

  it('should reject non-positive size', () => {
    expect(() => TradeSchema.parse({
      ...validTrade,
      size: 0,
    })).toThrow();

    expect(() => TradeSchema.parse({
      ...validTrade,
      size: -100,
    })).toThrow();
  });
});

describe('DataApiTradeResponseSchema', () => {
  const validDataApiResponse = {
    proxyWallet: '0x1234567890123456789012345678901234567890',
    side: 'BUY',
    asset: 'token-abc',
    conditionId: 'condition-123',
    size: 500,
    price: 0.75,
    timestamp: 1705000000,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  };

  it('should accept valid Data API response with transactionHash', () => {
    const result = DataApiTradeResponseSchema.parse(validDataApiResponse);
    expect(result.transactionHash).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('should accept response with null transactionHash', () => {
    const responseWithNullTx = {
      ...validDataApiResponse,
      transactionHash: null,
    };
    const result = DataApiTradeResponseSchema.parse(responseWithNullTx);
    expect(result.transactionHash).toBeNull();
  });

  it('should accept response without transactionHash', () => {
    const { transactionHash, ...responseWithoutTx } = validDataApiResponse;
    const result = DataApiTradeResponseSchema.parse(responseWithoutTx);
    expect(result.transactionHash).toBeUndefined();
  });
});

describe('transformDataApiTrade', () => {
  const validDataApiResponse = {
    proxyWallet: '0x1234567890123456789012345678901234567890',
    side: 'BUY' as const,
    asset: 'token-abc',
    conditionId: 'condition-123',
    size: 500,
    price: 0.75,
    timestamp: 1705000000,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  };

  it('should preserve transactionHash when present and valid', () => {
    const trade = transformDataApiTrade(validDataApiResponse);
    expect(trade.transactionHash).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('should use transactionHash as tradeId when available', () => {
    const trade = transformDataApiTrade(validDataApiResponse);
    expect(trade.tradeId).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('should use composite tradeId when transactionHash is null', () => {
    const responseWithNullTx = {
      ...validDataApiResponse,
      transactionHash: null,
    };
    const trade = transformDataApiTrade(responseWithNullTx);
    expect(trade.tradeId).toBe('condition-123-1705000000-0x1234567890123456789012345678901234567890');
    expect(trade.transactionHash).toBeUndefined();
  });

  it('should use composite tradeId when transactionHash is invalid format', () => {
    const responseWithInvalidTx = {
      ...validDataApiResponse,
      transactionHash: 'invalid-hash',
    };
    const trade = transformDataApiTrade(responseWithInvalidTx);
    expect(trade.tradeId).toBe('condition-123-1705000000-0x1234567890123456789012345678901234567890');
    expect(trade.transactionHash).toBeUndefined();
  });

  it('should convert timestamp from seconds to milliseconds', () => {
    const trade = transformDataApiTrade(validDataApiResponse);
    expect(trade.timestamp).toBe(1705000000 * 1000);
  });

  it('should lowercase wallet addresses', () => {
    const responseWithUppercase = {
      ...validDataApiResponse,
      proxyWallet: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    };
    const trade = transformDataApiTrade(responseWithUppercase);
    expect(trade.takerAddress).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });

  it('should set makerAddress to zero address (not available in Data API)', () => {
    const trade = transformDataApiTrade(validDataApiResponse);
    expect(trade.makerAddress).toBe('0x0000000000000000000000000000000000000000');
  });

  it('should preserve side, price, size, and tokenId', () => {
    const trade = transformDataApiTrade(validDataApiResponse);
    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.75);
    expect(trade.size).toBe(500);
    expect(trade.tokenId).toBe('token-abc');
  });
});

describe('ClobTradeResponseSchema', () => {
  const validClobResponse = {
    id: 'trade-xyz',
    asset_id: 'token-123',
    timestamp: '2024-01-12T10:30:00Z',
    maker_address: '0x1234567890123456789012345678901234567890',
    taker_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    side: 'buy',
    price: '0.65',
    size: '1000',
  };

  it('should accept valid CLOB trade response', () => {
    const result = ClobTradeResponseSchema.parse(validClobResponse);
    expect(result.id).toBe('trade-xyz');
    expect(result.price).toBe('0.65');
  });

  it('should accept response with optional fields', () => {
    const responseWithOptional = {
      ...validClobResponse,
      market: 'market-456',
      fee_rate_bps: '25',
      match_time: '2024-01-12T10:30:01Z',
      transaction_hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };
    const result = ClobTradeResponseSchema.parse(responseWithOptional);
    expect(result.transaction_hash).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });
});

describe('transformClobTrade', () => {
  const validClobResponse = {
    id: 'trade-xyz',
    asset_id: 'token-123',
    timestamp: '2024-01-12T10:30:00.000Z',
    maker_address: '0x1234567890123456789012345678901234567890',
    taker_address: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    side: 'buy',
    price: '0.65',
    size: '1000',
    fee_rate_bps: '25',
  };

  it('should transform CLOB response to canonical Trade format', () => {
    const trade = transformClobTrade(validClobResponse);
    expect(trade.tradeId).toBe('trade-xyz');
    expect(trade.tokenId).toBe('token-123');
    expect(trade.side).toBe('BUY');
    expect(trade.price).toBe(0.65);
    expect(trade.size).toBe(1000);
    expect(trade.feeRateBps).toBe(25);
  });

  it('should convert timestamp to milliseconds', () => {
    const trade = transformClobTrade(validClobResponse);
    expect(trade.timestamp).toBe(new Date('2024-01-12T10:30:00.000Z').getTime());
  });

  it('should lowercase wallet addresses', () => {
    const trade = transformClobTrade(validClobResponse);
    expect(trade.takerAddress).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(trade.makerAddress).toBe('0x1234567890123456789012345678901234567890');
  });

  it('should uppercase trade side', () => {
    const sellResponse = {
      ...validClobResponse,
      side: 'sell',
    };
    const trade = transformClobTrade(sellResponse);
    expect(trade.side).toBe('SELL');
  });

  it('should handle missing fee_rate_bps', () => {
    const { fee_rate_bps, ...responseWithoutFee } = validClobResponse;
    const trade = transformClobTrade(responseWithoutFee);
    expect(trade.feeRateBps).toBeUndefined();
  });
});

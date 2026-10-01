import type { SettledFundingRecord } from './exchange-funding-history.ts';

export type CexFundingExchange = 'binance' | 'bybit' | 'okx' | 'bitget';
type JsonObject = Record<string, unknown>;
type ReaderOptions = {
  request: (url: string, init?: RequestInit) => Promise<unknown>;
  clock?: () => number;
};
const PAGE_SIZE = 40;
const symbols: Record<CexFundingExchange, readonly string[]> = {
  binance: ['BZUSDT', 'CLUSDT'],
  bybit: ['BZUSDT', 'CLUSDT'],
  okx: ['BZ-USDT-SWAP', 'CL-USDT-SWAP'],
  bitget: ['BZUSDT', 'CLUSDT'],
};

function validateContract(exchange: CexFundingExchange, symbol: string) {
  if (!Object.hasOwn(symbols, exchange) || !symbols[exchange].includes(symbol)) throw new Error('Unsupported CEX oil funding contract');
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CEX funding response');
  return value as JsonObject;
}
function number(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new Error('Invalid CEX funding number');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid CEX funding number');
  return result;
}
function timestamp(value: unknown): number {
  const time = number(value);
  // These APIs use Unix milliseconds. A seconds timestamp must not become a
  // plausible-looking 1970 settlement, and sub-millisecond data is invalid.
  if (!Number.isSafeInteger(time) || time < 1_000_000_000_000) throw new Error('Invalid CEX funding timestamp');
  return time;
}
function rows(exchange: CexFundingExchange, input: unknown): unknown[] {
  if (exchange === 'binance') {
    if (!Array.isArray(input)) throw new Error('Binance funding history response failed');
    return input;
  }
  const response = object(input);
  if (exchange === 'bybit') {
    if (response.retCode !== 0) throw new Error('Bybit funding history response failed');
    const result = object(response.result);
    if (result.category !== undefined && result.category !== 'linear') throw new Error('Invalid Bybit funding category');
    if (!Array.isArray(result.list)) throw new Error('Invalid Bybit funding history list');
    return result.list;
  }
  if (response.code !== (exchange === 'okx' ? '0' : '00000') || !Array.isArray(response.data)) throw new Error('CEX funding history response failed');
  return response.data;
}

/** Rates are decimal amounts for the actual settlement, never hourly forecasts. */
export function parseCexFundingHistory(exchange: CexFundingExchange, symbol: string, input: unknown, now = Date.now()): SettledFundingRecord[] {
  validateContract(exchange, symbol);
  timestamp(now);
  const records = new Map<number, number>();
  for (const value of rows(exchange, input)) {
    const row = object(value), identity = exchange === 'okx' ? row.instId : row.symbol;
    if (identity !== undefined && identity !== symbol) throw new Error('CEX funding contract mismatch');
    if (exchange === 'binance' && row.rateType !== undefined && row.rateType !== 'Regular') throw new Error('Unsupported Binance funding rate type');
    if (exchange === 'okx' && row.instType !== undefined && row.instType !== 'SWAP') throw new Error('Invalid OKX funding instrument');
    const time = timestamp(exchange === 'bybit' ? row.fundingRateTimestamp : row.fundingTime);
    // OKX calls fundingRate predicted and realizedRate actual. A historical
    // next_period method still has an actual realizedRate; no forecast fallback.
    const rate = number(exchange === 'okx' ? row.realizedRate : row.fundingRate);
    if (Math.abs(rate) > 1) throw new Error('Invalid CEX funding rate');
    if (time > now) continue;
    if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
    records.set(time, rate);
  }
  return [...records].sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
}

/** One small public-history request per leg; transport owns HTTP checks/timeouts. */
export function createCexFundingHistoryReader({ request, clock = Date.now }: ReaderOptions) {
  return async (exchange: CexFundingExchange, symbol: string): Promise<SettledFundingRecord[]> => {
    validateContract(exchange, symbol);
    const now = timestamp(clock());
    let url: URL;
    if (exchange === 'binance') {
      url = new URL('https://fapi.binance.com/fapi/v1/fundingRate');
      url.search = new URLSearchParams({ symbol, limit: String(PAGE_SIZE), endTime: String(now) }).toString();
    } else if (exchange === 'bybit') {
      url = new URL('https://api.bybit.com/v5/market/funding/history');
      url.search = new URLSearchParams({ category: 'linear', symbol, limit: String(PAGE_SIZE), endTime: String(now) }).toString();
    } else if (exchange === 'okx') {
      url = new URL('https://www.okx.com/api/v5/public/funding-rate-history');
      url.search = new URLSearchParams({ instId: symbol, limit: String(PAGE_SIZE) }).toString();
    } else {
      url = new URL('https://api.bitget.com/api/v2/mix/market/history-fund-rate');
      url.search = new URLSearchParams({ symbol, productType: 'USDT-FUTURES', pageSize: String(PAGE_SIZE), pageNo: '1' }).toString();
    }
    return parseCexFundingHistory(exchange, symbol, await request(url.toString()), now);
  };
}

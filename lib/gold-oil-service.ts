import { GOLD_OIL_INTERVAL_MS, GOLD_OIL_STALE_MS, GOLD_OIL_SYMBOLS, validateGoldOilQuote, validateGoldOilHistory, type GoldOilHistory } from './gold-oil.ts';

function number(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw Error('Invalid Binance number');
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Binance response');
  return value as Record<string, unknown>;
}
export function validateGoldOilContracts(input: unknown) {
  const symbols = object(input).symbols;
  if (!Array.isArray(symbols)) throw Error('Missing Binance contracts');
  for (const [base, symbol] of Object.entries(GOLD_OIL_SYMBOLS)) {
    const matches = symbols.map(object).filter(item => item.symbol === symbol), spec = matches[0];
    if (matches.length !== 1 || spec.status !== 'TRADING' || !['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(String(spec.contractType)) || spec.baseAsset !== base.toUpperCase() || spec.quoteAsset !== 'USDT' || spec.marginAsset !== 'USDT') throw Error('Unsupported Binance gold/oil contract');
  }
}
export function parseGoldOilQuote(clInput: unknown, xauInput: unknown, now = Date.now()) {
  const leg = (input: unknown, symbol: string) => {
    const value = object(input), time = number(value.time);
    if (value.symbol !== symbol || !Number.isSafeInteger(time) || time < now - GOLD_OIL_STALE_MS || time > now + 1000) throw Error('Delayed or unexpected Binance quote');
    return { symbol, price: number(value.markPrice), updatedAt: new Date(time).toISOString() };
  };
  const cl = leg(clInput, GOLD_OIL_SYMBOLS.cl), xau = leg(xauInput, GOLD_OIL_SYMBOLS.xau);
  return validateGoldOilQuote({ source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(Math.min(Date.parse(cl.updatedAt), Date.parse(xau.updatedAt))).toISOString(), cl, xau });
}
export function parseGoldOilHistory(clInput: unknown, xauInput: unknown, now = Date.now(), previous: GoldOilHistory | null = null) {
  const end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS, start = end - 7 * 86_400_000;
  const candles = (input: unknown) => {
    if (!Array.isArray(input) || !input.length) throw Error('Missing Binance candles');
    const values = new Map<number, number>();
    for (const row of input) {
      if (!Array.isArray(row) || row.length < 7) throw Error('Invalid Binance candle');
      const time = number(row[0]), close = number(row[6]), price = number(row[4]);
      if (!Number.isSafeInteger(time) || time % GOLD_OIL_INTERVAL_MS || close !== time + GOLD_OIL_INTERVAL_MS - 1 || price <= 0 || values.has(time)) throw Error('Invalid Binance candle');
      if (time >= start && time < end) values.set(time, price);
    }
    return values;
  };
  const cl = candles(clInput), xau = candles(xauInput);
  // Keep genuine prior observations when an upstream page omits an older candle.
  if (previous) for (const row of validateGoldOilHistory(previous).points) {
    if (row.time < start || row.time >= end) continue;
    if (!cl.has(row.time) && row.cl !== null) cl.set(row.time, row.cl);
    if (!xau.has(row.time) && row.xau !== null) xau.set(row.time, row.xau);
  }
  const points = [...new Set([...cl.keys(), ...xau.keys()])].sort((a, b) => a - b).map(time => ({ time, cl: cl.get(time) ?? null, xau: xau.get(time) ?? null }));
  return validateGoldOilHistory({ source: 'Binance', currency: 'USDT', priceBasis: 'mark', interval: '15m', status: 'live', fetchedAt: new Date(now).toISOString(), points });
}

export function createGoldOilReader({ fetcher = fetch, clock = Date.now } = {}) {
  let metadataUntil = 0, pendingMetadata: Promise<void> | undefined;
  async function request(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, 'https://fapi.binance.com'); url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.href, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw Error(`Binance HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
  function metadata() {
    if (clock() < metadataUntil) return Promise.resolve();
    pendingMetadata ??= request('/fapi/v1/exchangeInfo').then(value => { validateGoldOilContracts(value); metadataUntil = clock() + 300_000; }).finally(() => { pendingMetadata = undefined; });
    return pendingMetadata;
  }
  return {
    async quote() {
      const [, cl, xau] = await Promise.all([metadata(), ...Object.values(GOLD_OIL_SYMBOLS).map(symbol => request('/fapi/v1/premiumIndex', { symbol }))]);
      return parseGoldOilQuote(cl, xau, clock());
    },
    async history(previous: GoldOilHistory | null = null) {
      const now = clock(), end = Math.floor(now / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
      const [, cl, xau] = await Promise.all([metadata(), ...Object.values(GOLD_OIL_SYMBOLS).map(symbol => request('/fapi/v1/markPriceKlines', { symbol, interval: '15m', startTime: String(end - 7 * 86_400_000), endTime: String(end - 1), limit: '1000' }))]);
      return parseGoldOilHistory(cl, xau, now, previous);
    },
  };
}
export const goldOilReader = createGoldOilReader();

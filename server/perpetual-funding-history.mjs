import { createPerpetualFundingReader } from './perpetual-funding-reader.mjs';
import { PERPETUAL_FUNDING_REFRESH_MS, PERPETUAL_FUNDING_LOOKBACK_MS } from '../lib/perpetual-funding-history.ts';

const WATCH_MS = 120_000;
const keyOf = quote => `${quote.exchange}:${quote.symbol}`;
const identityOf = quote => JSON.stringify([quote.exchange, quote.symbol, quote.base, quote.quoteCurrency, quote.marketId ?? null, quote.multiplier ?? 1, quote.contractUnit ?? null, quote.collateralCurrency ?? null]);
const hostOf = exchange => exchange === 'entropy' ? 'hyperliquid' : exchange;
const invalid = () => Object.assign(new Error('历史资金费请求必须包含至多 30 个有效的当前合约组合'), { status: 400 });

/** Shared, bounded on-demand settlement cache. HTTP reads never wait on an exchange. */
export function createPerpetualFundingHistoryService({ getSnapshot, getMarket = () => null, clock = Date.now, reader = createPerpetualFundingReader({ clock }), cacheLimit = 500, maxConcurrent = 3, hostSpacingMs = 350 } = {}) {
  const cache = new Map(), hostUntil = new Map(), busyHosts = new Set(), jobs = new Set();
  let running = false, timer;
  function prune() {
    if (cache.size < cacheLimit) return;
    const removable = [...cache].filter(([, entry]) => !entry.controller).sort((a, b) => a[1].watchedAt - b[1].watchedAt);
    while (cache.size >= cacheLimit && removable.length) cache.delete(removable.shift()[0]);
  }
  function empty(quote) {
    return { key: keyOf(quote), exchange: quote.exchange, symbol: quote.symbol, identity: identityOf(quote), status: 'pending', fetchedAt: null, coverage: null, records: [], error: '' };
  }
  function normalize(records, range) {
    if (!Array.isArray(records) || records.length > 2000) throw Error('历史结算记录格式异常');
    const values = new Map();
    for (const row of records) {
      if (!row || !Number.isSafeInteger(row.time) || row.time < range.from || row.time > range.to || typeof row.rate !== 'number' || !Number.isFinite(row.rate) || Math.abs(row.rate) > 1) throw Error('历史结算记录超出有效范围');
      if (values.has(row.time) && values.get(row.time) !== row.rate) throw Error('历史结算记录冲突');
      values.set(row.time, row.rate);
    }
    return [...values].sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
  }
  async function collect() {
    if (!running) return;
    const launched = [];
    for (const entry of cache.values()) {
      const now = clock(), host = hostOf(entry.market.exchange);
      if (jobs.size >= maxConcurrent) break;
      if (entry.controller || now - entry.watchedAt > WATCH_MS || now < entry.retryAt || busyHosts.has(host) || now < (hostUntil.get(host) ?? 0)) continue;
      const controller = new AbortController(), range = { from: now - PERPETUAL_FUNDING_LOOKBACK_MS, to: now };
      entry.controller = controller;
      busyHosts.add(host); hostUntil.set(host, now + hostSpacingMs);
      const job = Promise.resolve().then(() => reader(entry.market, range, { signal: controller.signal })).then(records => {
        if (!running || controller.signal.aborted || cache.get(entry.value.key) !== entry) return;
        entry.value = { ...entry.value, status: 'ready', fetchedAt: clock(), coverage: range, records: normalize(records, range), error: '' };
        entry.retryAt = clock() + PERPETUAL_FUNDING_REFRESH_MS;
        entry.failures = 0;
      }).catch(error => {
        if (!running || controller.signal.aborted || cache.get(entry.value.key) !== entry) return;
        const unsupported = error?.code === 'UNSUPPORTED';
        entry.value = { ...entry.value, status: unsupported ? 'unsupported' : 'error', error: unsupported ? error.message : '本合约历史读取失败，稍后重试' };
        entry.retryAt = clock() + (unsupported ? 3_600_000 : Math.min(300_000, 60_000 * 2 ** Math.min(entry.failures++, 3)));
        if (error?.status === 429 || error?.status === 418) {
          const retry = Number.isFinite(error.retryAfterMs) ? Math.max(60_000, Math.min(900_000, error.retryAfterMs)) : 60_000;
          hostUntil.set(host, Math.max(hostUntil.get(host) ?? 0, clock() + retry));
        }
      }).finally(() => {
        entry.controller = null; busyHosts.delete(host); jobs.delete(job);
      });
      jobs.add(job); launched.push(job);
    }
    await Promise.all(launched);
  }
  return {
    start() { if (running) return; running = true; timer = setInterval(() => { void collect(); }, 1000); timer.unref?.(); },
    async stop() { running = false; clearInterval(timer); for (const entry of cache.values()) entry.controller?.abort(); await Promise.allSettled([...jobs]); },
    collect,
    read(input) {
      if (!input || !Array.isArray(input.pairs) || input.pairs.length > 30) throw invalid();
      const quotes = new Map(getSnapshot().quotes.map(quote => [keyOf(quote), quote])), requested = new Map();
      // Validate the entire batch before changing watches or scheduling work.
      for (const pair of input.pairs) {
        if (!pair || typeof pair.base !== 'string' || pair.base.length > 100 || typeof pair.longKey !== 'string' || pair.longKey.length > 160 || typeof pair.shortKey !== 'string' || pair.shortKey.length > 160) throw invalid();
        const long = quotes.get(pair.longKey), short = quotes.get(pair.shortKey);
        if (!long || !short || long.exchange === short.exchange || long.base !== pair.base || short.base !== pair.base || long.comparable === false || short.comparable === false) throw invalid();
        for (const quote of [long, short]) {
          const catalog = getMarket(quote.exchange, quote.symbol);
          if (catalog && (catalog.exchange !== quote.exchange || catalog.symbol !== quote.symbol || catalog.base !== quote.base || catalog.quoteCurrency !== quote.quoteCurrency)) throw invalid();
          requested.set(keyOf(quote), { ...quote, ...catalog });
        }
      }
      const now = clock(), legs = Object.create(null);
      for (const [key, market] of requested) {
        let entry = cache.get(key);
        const identity = identityOf(market);
        if (entry && entry.identity !== identity) { entry.controller?.abort(); cache.delete(key); entry = null; }
        if (!entry) {
          prune();
          if (cache.size >= cacheLimit) { legs[key] = { ...empty(market), error: '历史查询队列繁忙，稍后重试' }; continue; }
          entry = { identity, market, value: empty(market), watchedAt: now, retryAt: 0, failures: 0, controller: null };
          cache.set(key, entry);
        }
        entry.watchedAt = now; entry.market = market;
        legs[key] = structuredClone(entry.value);
      }
      if (running) queueMicrotask(() => { void collect(); });
      return { schemaVersion: 1, generatedAt: now, legs };
    },
    metrics: () => ({ cached: cache.size, inFlight: jobs.size }),
  };
}

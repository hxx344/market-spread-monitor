import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { fundingWindowTotal, PERPETUAL_FUNDING_STALE_MS } from '../lib/perpetual-funding-history.ts';
import { createPerpetualFundingHistoryService } from '../server/perpetual-funding-history.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 6, 12);
const quote = (exchange, symbol = 'BTCUSDT', extra = {}) => ({ exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', comparable: true, ...extra });
const pair = (long, short) => ({ base: long.base, longKey: `${long.exchange}:${long.symbol}`, shortKey: `${short.exchange}:${short.symbol}` });
const settlements = (hours = 96, rate = 0.0001) => Array.from({ length: hours + 1 }, (_, index) => ({ time: NOW - index * HOUR, rate }));
const leg = (extra = {}) => ({ key: 'binance:BTCUSDT', exchange: 'binance', symbol: 'BTCUSDT', status: 'ready', fetchedAt: NOW, coverage: { from: NOW - 96 * HOUR, to: NOW }, records: settlements(), error: '', ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('rolling actual settlements exclude the left boundary and include the right, without 8h normalization', () => {
  const long = leg({ records: settlements(96, -0.0001) });
  const short = leg({ records: settlements(12, 0.0002).map((row, index) => ({ ...row, time: NOW - index * 8 * HOUR })) });
  const day = fundingWindowTotal(long, short, 24, NOW), three = fundingWindowTotal(long, short, 72, NOW);
  assert.equal(day.status, 'ready'); assert.equal(day.longCount, 24); assert.equal(day.shortCount, 3);
  near(day.netPercent, 0.30); near(three.netPercent, 0.90);
  near(fundingWindowTotal(short, long, 24, NOW).netPercent, -0.30);
});

test('two legs use the same successful coverage cutoff, excluding newer settlements on one leg', () => {
  const long = leg({ coverage: { from: NOW - 96 * HOUR, to: NOW - HOUR }, records: settlements().slice(1) });
  const short = leg({ records: [{ time: NOW, rate: 0.2 }, ...settlements(96, 0.0002).slice(1)] });
  const total = fundingWindowTotal(long, short, 24, NOW);
  assert.equal(total.asOf, NOW - HOUR); assert.equal(total.status, 'stale'); near(total.netPercent, 0.24);
});

test('one-day history may be complete while three days lack the preceding settlement', () => {
  const recent = leg({ records: settlements(40) });
  assert.equal(fundingWindowTotal(recent, leg(), 24, NOW).status, 'ready');
  const total = fundingWindowTotal(recent, leg(), 72, NOW);
  assert.equal(total.status, 'partial'); assert.equal(total.netPercent, null); assert.equal(total.longPercent, null);
});

test('missing, unsupported and empty histories never become zero; real settled zero is valid', () => {
  assert.equal(fundingWindowTotal(undefined, leg(), 24, NOW).status, 'pending');
  assert.equal(fundingWindowTotal(leg({ status: 'unsupported', error: '无法核实' }), leg(), 24, NOW).status, 'unsupported');
  assert.equal(fundingWindowTotal(leg({ records: [] }), leg(), 24, NOW).netPercent, null);
  assert.equal(fundingWindowTotal(leg({ records: settlements(96, 0) }), leg({ records: settlements(96, 0) }), 72, NOW).netPercent, 0);
  assert.equal(fundingWindowTotal(leg({ status: 'error', coverage: null, error: '读取失败' }), leg(), 24, NOW).status, 'error');
});

test('old coverage, failed updates and future clocks are explicitly marked while retaining old totals', () => {
  assert.equal(fundingWindowTotal(leg(), leg(), 24, NOW + PERPETUAL_FUNDING_STALE_MS + 1).status, 'stale');
  const failed = fundingWindowTotal(leg({ status: 'error', error: '读取失败', fetchedAt: NOW + 1000 }), leg(), 24, NOW + 1000);
  assert.equal(failed.status, 'error'); assert.equal(failed.asOf, NOW); assert.equal(failed.netPercent, 0);
  assert.equal(fundingWindowTotal(leg(), leg(), 24, NOW - 6000).status, 'stale');
});

function fixture(t, options = {}) {
  let now = NOW, calls = 0;
  const quotes = options.quotes ?? [quote('binance'), quote('bybit')], markets = new Map(quotes.map(row => [`${row.exchange}:${row.symbol}`, row]));
  const service = createPerpetualFundingHistoryService({ getSnapshot: () => ({ quotes }), getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => now,
    reader: async (...args) => { calls++; return options.reader ? options.reader(...args) : settlements(); }, hostSpacingMs: 0, ...options.service });
  service.start(); t.after(() => service.stop());
  return { service, quotes, markets, read: (pairs = [pair(quotes[0], quotes[1])]) => service.read({ pairs }), advance: ms => { now += ms; }, calls: () => calls };
}

test('cache returns pending immediately, merges concurrent watches, and refreshes only after TTL', async t => {
  const f = fixture(t);
  assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending'); assert.equal(f.calls(), 0);
  f.read(); await f.service.collect();
  assert.equal(f.calls(), 2); assert.equal(f.read().legs['binance:BTCUSDT'].status, 'ready');
  await f.service.collect(); assert.equal(f.calls(), 2);
  f.advance(300_001); f.read(); await f.service.collect(); assert.equal(f.calls(), 4);
});

test('failed refresh retains successful records and coverage and retries with backoff', async t => {
  let fail = false;
  const f = fixture(t, { reader: async () => { if (fail) throw Error('transport'); return settlements(); } });
  f.read(); await f.service.collect(); fail = true; f.advance(300_001); f.read(); await f.service.collect();
  const cached = f.read().legs['binance:BTCUSDT'];
  assert.equal(cached.status, 'error'); assert.equal(cached.coverage.to, NOW); assert.equal(cached.fetchedAt, NOW); assert.equal(cached.records.length, 97);
  await f.service.collect(); assert.equal(f.calls(), 4);
  f.advance(60_001); f.read(); await f.service.collect(); assert.equal(f.calls(), 6);
});

test('invalid batches cannot schedule arbitrary contracts, mismatched bases, or oversized reads', async t => {
  const f = fixture(t), good = pair(...f.quotes);
  for (const pairs of [[{ ...good, longKey: 'https://example.invalid' }], [{ ...good, base: 'ETH' }], Array(31).fill(good), [good, { ...good, shortKey: good.longKey }]]) assert.throws(() => f.read(pairs), /有效/);
  await f.service.collect(); assert.equal(f.calls(), 0); assert.equal(f.service.metrics().cached, 0);
});

test('contract directory identity changes invalidate records and malformed settlements are rejected', async t => {
  let malformed = false;
  const f = fixture(t, { reader: async () => malformed ? [{ time: NOW, rate: NaN }] : settlements() });
  f.read(); await f.service.collect();
  f.markets.set('binance:BTCUSDT', { ...f.quotes[0], marketId: 123 }); malformed = true;
  assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending'); await f.service.collect();
  const value = f.read().legs['binance:BTCUSDT'];
  assert.equal(value.status, 'error'); assert.equal(value.coverage, null); assert.deepEqual(value.records, []);
});

test('queue caps concurrency, shares Hyperliquid/Entropy host budget, and stops abandoned watches', async t => {
  const releases = [], quotes = ['hyperliquid', 'entropy', 'binance', 'bybit', 'gate'].map(exchange => quote(exchange));
  const f = fixture(t, { quotes, reader: () => new Promise(resolve => { releases.push(() => resolve(settlements())); }) });
  f.read(quotes.slice(1).map(other => pair(quotes[0], other)));
  const first = f.service.collect(); await turn();
  assert.equal(f.calls(), 3); assert.equal(f.service.metrics().inFlight, 3);
  releases.splice(0).forEach(release => release()); await first;
  f.advance(120_001); await f.service.collect(); assert.equal(f.calls(), 3);
});

test('rate limits defer all contracts on the same host; stopped jobs cannot publish', async t => {
  const quotes = [quote('hyperliquid'), quote('entropy'), quote('bybit')];
  const f = fixture(t, { quotes, reader: async market => {
    if (market.exchange === 'hyperliquid') throw Object.assign(Error('limit'), { status: 429, retryAfterMs: 180_000 });
    return settlements();
  } });
  f.read([pair(quotes[0], quotes[2]), pair(quotes[1], quotes[2])]); await f.service.collect();
  await f.service.collect(); assert.equal(f.calls(), 2);
  f.advance(60_000); f.read([pair(quotes[1], quotes[2])]); await f.service.collect(); assert.equal(f.calls(), 2);
  let aborted = false;
  const pending = fixture(t, { reader: (_market, _range, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }); }) });
  pending.read(); void pending.service.collect(); await turn(); await pending.service.stop();
  assert.equal(aborted, true); assert.equal(pending.read().legs['binance:BTCUSDT'].status, 'pending');
});

test('cache is bounded and requests after stop cannot start new work', async t => {
  const quotes = [quote('bybit'), ...Array.from({ length: 6 }, (_, index) => quote('binance', `BTC${index}USDT`))];
  const f = fixture(t, { quotes, service: { cacheLimit: 4 } });
  for (const other of quotes.slice(1)) { f.read([pair(quotes[0], other)]); await f.service.collect(); }
  assert.ok(f.service.metrics().cached <= 4);
  await f.service.stop(); const calls = f.calls(); f.read(); await f.service.collect(); assert.equal(f.calls(), calls);
});

test('perpetual runtime exposes the history action with existing service dispatch', async () => {
  const quotes = [quote('binance'), quote('bybit')];
  const service = createPerpetualService({ exchanges: quotes.map(row => ({ id: row.exchange, kind: 'cex' })), store: { load: () => quotes, close() {}, save() {} }, fundingHistoryOptions: { reader: async () => settlements() } });
  assert.deepEqual(service.actions['funding-history'], ['POST']);
  const report = service.handle('funding-history', 'POST', { pairs: [pair(...quotes)] });
  assert.equal(report.schemaVersion, 1); assert.equal(Object.keys(report.legs).length, 2);
  await service.stop();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInspectionBudget, createPerpetualExecutionService, estimateDepthPair, normalizeDepthLevels } from '../server/perpetual-depth.mjs';
import { quoteCurrencyFx } from '../lib/perpetual-fx.ts';
import { depthEstimateExpired } from '../lib/perpetual-execution.ts';

const NOW = 1_800_000_000_000;
const quote = (exchange, extra = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', ...extra });
const book = (exchange, extra = {}) => ({ ...quote(exchange), sourceTime: NOW, receivedAt: NOW, transport: 'rest', asks: [[100, 5], [110, 5]], bids: [[99, 20]], ...extra });
const response = data => ({ ok: true, json: async () => data });
const budget = () => createInspectionBudget({ spacingMs: 0, maxPerMinute: 60 });

test('depth normalizes coin multipliers and contract size without changing notional', () => {
  assert.deepEqual(normalizeDepthLevels([['1000', '2']], { multiplier: 1000, contractSize: 0.1 }), [[1, 200]]);
  assert.deepEqual(normalizeDepthLevels([{ p: '10', s: '3' }, { p: '10', s: '4' }, null, ['12', '0'], ['8', '2']], { side: 'bids' }), [[10, 7], [8, 2]]);
  assert.throws(() => normalizeDepthLevels([], { contractSize: 0 }));
});

test('depth spends target USDT through long levels then matches the same underlying quantity', () => {
  const result = estimateDepthPair(book('binance'), book('bybit', { bids: [[120, 20]], asks: [[121, 20]] }), 1050, null, NOW);
  assert.equal(result.complete, true); assert.equal(result.quantity, 10);
  assert.equal(result.long.vwap, 105); assert.equal(result.long.filledNotional, 1050);
  assert.equal(result.short.filledQuantity, 10); assert.equal(result.short.filledNotional, 1200);
  assert.ok(Math.abs(result.estimatedSpreadPct - 14.2857142857) < 1e-8);
  assert.ok(result.entrySlippagePct > 5);
});

test('insufficient depth never promotes a partial fill to a full opportunity', () => {
  const shortLimited = estimateDepthPair(book('binance'), book('bybit', { bids: [[101, 1]], asks: [[102, 1]] }), 500, null, NOW);
  assert.equal(shortLimited.complete, false); assert.equal(shortLimited.estimatedSpreadPct, null);
  assert.equal(shortLimited.short.filledQuantity, 1); assert.match(shortLimited.reasons.join(), /做空腿/);
  const longLimited = estimateDepthPair(book('binance'), book('bybit'), 5000, null, NOW);
  assert.equal(longLimited.complete, false); assert.equal(longLimited.estimatedSpreadPct, null);
  assert.equal(longLimited.long.filledNotional, 1050); assert.match(longLimited.reasons.join(), /做多腿/);
});

test('depth refuses stale, future, crossed and time-skewed books independently of recent receipt', () => {
  for (const extra of [{ sourceTime: NOW - 10_001 }, { sourceTime: null }, { sourceTime: NOW + 5_001 }, { bids: [[200, 1]] }]) {
    assert.equal(estimateDepthPair(book('binance', extra), book('bybit'), 100, null, NOW).complete, false);
  }
  assert.match(estimateDepthPair(book('binance', { sourceTime: NOW - 6000 }), book('bybit'), 100, null, NOW).reasons.join(), /相差/);
});

test('FX uses directional bid and ask; USD and stale rates are never silently one', () => {
  const fx = { baseCurrency: 'USDT', generatedAt: NOW, staleAfterMs: 180000, rates: { USDC: { bid: 0.98, ask: 1.02, at: NOW, source: 'fixture' } } };
  assert.equal(quoteCurrencyFx('USDT', null, NOW).bid, 1);
  assert.equal(quoteCurrencyFx('USD', fx, NOW), null);
  assert.equal(quoteCurrencyFx('USDC', fx, NOW + 180001), null);
  assert.equal(quoteCurrencyFx('USDC', { ...fx, rates: { USDC: { ...fx.rates.USDC, bid: 2 } } }, NOW), null);
  const result = estimateDepthPair(book('binance', { quoteCurrency: 'USDC', asks: [[100, 20]] }), book('bybit', { bids: [[110, 20]], asks: [[111, 20]] }), 1020, fx, NOW);
  assert.equal(result.quantity, 10); assert.equal(result.long.vwap, 102);
  assert.equal(estimateDepthPair(book('binance', { quoteCurrency: 'USD' }), book('bybit'), 100, fx, NOW).complete, false);
});

test('frozen browser estimates expire from the older source time', () => {
  const result = estimateDepthPair(book('binance', { sourceTime: NOW - 4000 }), book('bybit'), 100, null, NOW);
  assert.equal(depthEstimateExpired(result, NOW + 5000), false);
  assert.equal(depthEstimateExpired(result, NOW + 6001), true);
});

test('shared inspection budget limits in-flight work, queue size and minute starts', async () => {
  const limiter = createInspectionBudget({ spacingMs: 0, concurrency: 1, maxQueue: 1, maxPerMinute: 2 });
  let release; const first = limiter.run(() => new Promise(resolve => { release = resolve; }));
  const second = limiter.run(async () => 2);
  await assert.rejects(limiter.run(async () => 3), /繁忙/);
  assert.equal(limiter.metrics().inFlight, 1); release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await assert.rejects(limiter.run(async () => 4), /限额/); limiter.stop();
});

test('execution caches shared market requests, bounds active leases and validates symbols before network', async () => {
  let calls = 0, now = NOW;
  const quotes = [quote('binance'), quote('bybit'), quote('aster')], limiter = budget();
  const service = createPerpetualExecutionService({ clock: () => now, budget: limiter, maxMarkets: 2, getQuote: (exchange, symbol) => quotes.find(row => row.exchange === exchange && row.symbol === symbol), fetchImpl: async url => {
    calls++; return response(url.includes('bybit') ? { result: { s: 'BTCUSDT', ts: now, b: [['101', '20']], a: [['102', '20']] } } : { E: now, bids: [['99', '20']], asks: [['100', '20']] });
  } });
  try {
    const input = { long: quotes[0], short: quotes[1], notional: 100 };
    const results = await Promise.all([service.depth(input), service.depth(input)]);
    assert.ok(results.every(row => row.complete)); assert.equal(calls, 2);
    await service.depth({ ...input, notional: 500 }); assert.equal(calls, 2);
    const denied = await service.depth({ ...input, short: quotes[2] }); assert.equal(denied.complete, false); assert.match(denied.reasons.join(), /最多/);
    await assert.rejects(service.depth({ ...input, long: { exchange: 'binance', symbol: 'https://evil.example' } }), /有效/);
    await assert.rejects(service.depth({ ...input, notional: -1 }), /金额/); assert.equal(calls, 2);
    now += 31000; const released = await service.depth({ ...input, short: quotes[2] }); assert.equal(released.complete, true); assert.equal(calls, 4);
  } finally { service.stop(); limiter.stop(); }
});

test('Gate and OKX quantities use official contract multipliers and reject unknown units', async () => {
  const quotes = [quote('gate', { symbol: 'BTC_USDT' }), quote('okx', { symbol: 'BTC-USDT-SWAP' })], limiter = budget();
  let metadataCalls = 0;
  const service = createPerpetualExecutionService({ clock: () => NOW, budget: limiter, getQuote: exchange => quotes.find(row => row.exchange === exchange), fetchImpl: async url => {
    if (url.includes('/contracts/')) { metadataCalls++; return response({ name: 'BTC_USDT', type: 'direct', quanto_multiplier: '0.01' }); }
    if (url.includes('/instruments?')) { metadataCalls++; return response({ data: [{ instId: 'BTC-USDT-SWAP', ctValCcy: 'BTC', ctType: 'linear', ctVal: '0.1', ctMult: '1' }] }); }
    return response(url.includes('gateio') ? { current: NOW / 1000, asks: [{ p: '100', s: '100' }], bids: [{ p: '99', s: '100' }] } : { data: [{ ts: NOW, asks: [['102', '10']], bids: [['101', '10']] }] });
  } });
  try {
    const result = await service.depth({ long: quotes[0], short: quotes[1], notional: 100 });
    assert.equal(result.complete, true); assert.equal(result.quantity, 1); assert.equal(result.short.filledQuantity, 1); assert.equal(metadataCalls, 2);
  } finally { service.stop(); limiter.stop(); }
});

test('Lighter one-shot WS accepts a snapshot, ignores preceding deltas and closes after reading', async () => {
  const quotes = [quote('lighter', { symbol: 'BTC' }), quote('bybit')], limiter = budget(); let terminated = 0;
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(raw) { const request = JSON.parse(raw); if (request.type === 'subscribe') queueMicrotask(() => {
      this.emit('message', JSON.stringify({ type: 'update/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { asks: [{ price: '1', size: '100' }], bids: [{ price: '0.5', size: '100' }] } }));
      this.emit('message', JSON.stringify({ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { asks: [{ price: '100', size: '5' }], bids: [{ price: '99', size: '5' }] } }));
    }); }
    terminate() { terminated++; }
  }
  const service = createPerpetualExecutionService({ clock: () => NOW, budget: limiter, WebSocketImpl: Socket, getQuote: exchange => quotes.find(row => row.exchange === exchange), getMarket: () => ({ marketId: 1, multiplier: 1 }), fetchImpl: async () => response({ result: { s: 'BTCUSDT', ts: NOW, a: [['102', '10']], b: [['101', '10']] } }) });
  try { const result = await service.depth({ long: quotes[0], short: quotes[1], notional: 100 }); assert.equal(result.complete, true); assert.equal(result.long.vwap, 100); assert.equal(result.long.transport, 'ws'); assert.equal(terminated, 1); }
  finally { service.stop(); limiter.stop(); }
});

test('FX is one shared short cache and only publishes actual positive spot books', async () => {
  let calls = 0; const limiter = budget();
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, fetchImpl: async url => { calls++; return response(url.includes('USDG') ? { current: NOW, asks: [], bids: [] } : { current: NOW, bids: [['0.999', '10']], asks: [['1.001', '10']] }); } });
  try {
    const [a, b] = await Promise.all([service.fx(), service.fx()]); assert.deepEqual(a, b); assert.equal(calls, 3);
    assert.equal(a.rates.USDC.bid, 0.999); assert.equal(a.rates.USD, undefined); assert.equal(a.rates.USDG, undefined); assert.ok(a.reasons.USDG);
    await service.fx(); assert.equal(calls, 3);
  } finally { service.stop(); limiter.stop(); }
});

test('a temporary FX failure preserves original timestamps, then drops expired values', async () => {
  let now = NOW, failing = false; const limiter = budget();
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => now, fetchImpl: async () => { if (failing) throw new Error('temporary outage'); return response({ current: NOW, bids: [['0.999', '10']], asks: [['1.001', '10']] }); } });
  try {
    assert.equal((await service.fx()).rates.USDC.at, NOW);
    now += 60001; failing = true;
    const held = await service.fx(); assert.equal(held.rates.USDC.at, NOW); assert.equal(held.generatedAt, now); assert.match(held.reasons.USDC, /沿用/);
    now += 120001;
    const expired = await service.fx(); assert.equal(expired.rates.USDC, undefined); assert.equal(expired.rates.USD1, undefined);
  } finally { service.stop(); limiter.stop(); }
});

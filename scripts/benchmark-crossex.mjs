import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { createPerpetualOpportunitiesV2, createOpportunitiesV2Reader, CROSSEX_VENUES } from '../server/perpetual-opportunities-v2.mjs';

// Deterministic synthetic public quotes; no network, accounts or saved market data.
const now = 1790000000000;
const quotes = Array.from({ length: 700 }, (_, index) => CROSSEX_VENUES.map((exchange, venue) => ({
  exchange, symbol: `COIN${index}USDT`, base: `COIN${index}`, rawBase: `COIN${index}`, quoteCurrency: 'USDT', multiplier: 1,
  assetClass: 'crypto', identityVerified: true, crossexVerified: true, identitySource: 'official synthetic directory', comparable: true,
  delisting: false, delistingAt: null, bid: 100 + venue, ask: 100.5 + venue, bidAskAt: now, receivedAt: now, sourceTime: now,
  mark: 100.25 + venue, markAt: now, last: 100.1 + venue, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: now + 3600000, transport: 'ws', marketId: index,
}))).flat();
const directory = new Map(quotes.map(q => [`${q.exchange}:${q.symbol}`, q]));
const snapshot = { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, quotes, exchanges: CROSSEX_VENUES.map(id => ({ id, status: 'live' })) };
const fx = { baseCurrency: 'USDT', generatedAt: now, staleAfterMs: 180000, rates: { USDC: { bid: 0.999, ask: 1.001, at: now, source: 'synthetic FX' } } };
const market = (exchange, symbol) => directory.get(`${exchange}:${symbol}`);
const measure = (read, iterations) => { const started = performance.now(); let value; for (let i = 0; i < iterations; i++) value = read(i); return { averageMs: Number(((performance.now() - started) / iterations).toFixed(3)), value }; };
const full = measure(() => createPerpetualOpportunitiesV2(snapshot, now, market, fx), 10);
const read = createOpportunitiesV2Reader(); read(snapshot, now, market, fx, 'benchmark:1');
const reused = measure(index => read(snapshot, now + index, market, fx, 'benchmark:1'), 100);
const payload = Buffer.from(JSON.stringify(full.value));
const compression = measure(() => gzipSync(payload, { level: 4 }), 10);
console.log(JSON.stringify({ quotes: quotes.length, signals: full.value.signals.length, fullProjectionMs: full.averageMs, reusedProjectionMs: reused.averageMs, jsonBytes: payload.length, gzipBytes: compression.value.length, gzipMs: compression.averageMs, reductionPercent: Number((100 * (1 - compression.value.length / payload.length)).toFixed(2)), note: 'Reuse requires unchanged source revision and FX; all expiries retain original source times. Normal changed revisions recompute in full.' }, null, 2));

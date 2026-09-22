import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createHandler } from '../server/http.mjs';
import { createOpportunitiesV2Reader, createPerpetualOpportunitiesV2 } from '../server/perpetual-opportunities-v2.mjs';

const now = 1790000000000;
const timestamp = new Date(now).toISOString();
const oil = { fetchedAt: timestamp, status: 'live', brent: { markPx: 80, funding: 0 }, wti: { markPx: 76, funding: 0 } };
const services = (overrides = {}) => new Map(Object.entries({ oil: { handle: async () => oil }, hynix: { handle: async () => ({ fetchedAt: timestamp, status: 'live', premium: 1.2 }) }, perpetual: { summary: () => ({ state: 'online', updatedAt: now, quoteCount: 4900, message: '' }) }, ...overrides }));

test('selected module summaries preserve legacy keys, units and source time without cross-module failures', async () => {
  let hynixReads = 0;
  const cached = services({ hynix: { handle: async () => { hynixReads++; throw Error('hynix cache empty'); } } });
  const normal = await readHubSummary(cached, now);
  assert.equal(normal.health.state, 'online'); assert.equal(normal.updatedAt, timestamp); assert.equal(hynixReads, 0);
  assert.deepEqual(normal.metrics.map(item => [item.key, item.unit]), [['brent', 'USDT/桶'], ['wti', 'USDT/桶'], ['spread', 'USDT/桶'], ['modules', '个']]);
  assert.equal(normal.metrics[0].value, 80); assert.equal(normal.metrics[2].value, 4);
  const missing = await readHubSummary(cached, now, 'hynix'); assert.equal(missing.health.state, 'offline'); assert.equal(missing.updatedAt, null); assert.match(missing.health.message, /海力士/); assert.equal(hynixReads, 1);
  const hynix = await readHubSummary(services({ oil: { handle: async () => { throw Error('oil unavailable'); } }, hynix: { handle: async () => ({ fetchedAt: timestamp, status: 'live', premium: 1.2, spread: 0.5, funding: { annualizedRate: 0.15 } }) } }), now, 'hynix');
  assert.equal(hynix.health.state, 'online'); assert.deepEqual(hynix.metrics.map(item => [item.key, item.unit]), [['premium', '%'], ['spread', 'USD'], ['funding', '%'], ['modules', '个']]); assert.equal(hynix.metrics[2].value, 15);
  const absent = await readHubSummary(new Map(), now); assert.equal(absent.health.state, 'offline'); assert.equal(absent.updatedAt, null);
  const stale = await readHubSummary(services(), now + 100_000); assert.equal(stale.health.state, 'stale'); assert.match(stale.health.message, /原油/);
  const perpetual = await readHubSummary(services({ perpetual: { summary: () => ({ state: 'partial', updatedAt: now - 1000, quoteCount: 4900, exchangeCount: 7, liveExchangeCount: 6, message: 'gate 行情过期' }) } }), now, 'perpetual');
  assert.equal(perpetual.updatedAt, new Date(now - 1000).toISOString()); assert.equal(perpetual.health.state, 'partial'); assert.deepEqual(perpetual.metrics.map(item => item.key), ['exchanges', 'live_exchanges', 'quotes', 'modules']);
  await assert.rejects(readHubSummary(services(), now, 'unknown'), /不存在/);
});

test('v2 compression negotiates gzip and preserves the original full compatible JSON envelope', async t => {
  const payload = { schemaVersion: 2, quotes: Array.from({ length: 200 }, (_, i) => ({ symbol: `BTC${i}`, bid: 100, ask: 101 })), signals: [] };
  const server = createServer(createHandler({ services: new Map([['perpetual', { actions: { 'opportunities-v2': ['GET'] }, handle: async () => payload }]]), username: 'test', password: 'test-password', nextHandler: (_q, r) => r.end() }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/opportunities-v2`;
  const read = encoding => new Promise((resolve, reject) => get(url, { headers: { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}`, 'Accept-Encoding': encoding } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) })); }).on('error', reject));
  const zipped = await read('gzip'); assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), payload);
  const plain = await read('gzip;q=0, identity'); assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(JSON.parse(plain.body), payload);
  assert.ok(zipped.body.length < plain.body.length / 4);
});

test('same source projection is reused without extending signal expiry, and a changed revision or new reader recomputes', () => {
  const quote = (exchange, bid) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', rawBase: 'BTC', quoteCurrency: 'USDT', multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'official', crossexVerified: true, comparable: true, delisting: false, delistingAt: null, bid, ask: bid + 1, bidAskAt: now, receivedAt: now });
  const quotes = [quote('binance', 99), quote('bybit', 102)];
  const snapshot = { status: 'live', quotes, exchanges: quotes.map(q => ({ id: q.exchange, status: 'live' })) };
  const market = (e, symbol) => quotes.find(q => q.exchange === e && q.symbol === symbol);
  let calls = 0; const project = (...args) => { calls++; return createPerpetualOpportunitiesV2(...args); };
  const reader = createOpportunitiesV2Reader(project), first = reader(snapshot, now, market, null, 'epoch:1');
  const second = reader(snapshot, now + 5000, market, null, 'epoch:1');
  assert.equal(calls, 1); assert.equal(second.quotes, first.quotes); assert.equal(second.signals[0].expiresAt, first.signals[0].expiresAt);
  reader(snapshot, now + 9999, market, null, 'epoch:1'); assert.equal(calls, 1);
  const boundary = reader(snapshot, now + 10000, market, null, 'epoch:1'); assert.equal(calls, 2); assert.ok(boundary.signals.every(signal => signal.expiresAt === now + 10000));
  assert.equal(reader(snapshot, now + 10001, market, null, 'epoch:1').signals.length, 0);
  reader(snapshot, now + 10002, market, null, 'epoch:2'); assert.equal(calls, 3);
  createOpportunitiesV2Reader(project)(snapshot, now + 10003, market, null, 'new-epoch:1'); assert.equal(calls, 4);
});


test('authenticated HTTP summary selects the requested module and defaults to oil', async t => {
  const server = createServer(createHandler({ services: services({ hynix: { handle: async () => { throw Error('hynix failed'); } } }), username: 'test', password: 'test-password', nextHandler: (_q, r) => r.end() }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/hub/summary', headers = { Authorization: 'Basic ' + Buffer.from('test:test-password').toString('base64') };
  assert.equal((await fetch(base + '?schemaVersion=2')).status, 401);
  const oil = await (await fetch(base + '?schemaVersion=2', { headers })).json(); assert.equal(oil.schemaVersion, 2); assert.equal(oil.data.metrics[0].key, 'brent');
  const hynix = await (await fetch(base + '?schemaVersion=2&monitor=hynix', { headers })).json(); assert.equal(hynix.data.health.state, 'offline'); assert.equal(hynix.data.metrics[0].key, 'premium');
  const legacy = await (await fetch(base, { headers })).json(); assert.equal(legacy.schemaVersion, 1); assert.equal(legacy.data.health, undefined);
  assert.equal((await fetch(base + '?schemaVersion=2&monitor=unknown', { headers })).status, 400);
});

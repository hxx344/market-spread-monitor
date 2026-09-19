import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerpetualService, mergePerpetualQuote, createPerpetualDelta } from '../server/perpetual-service.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { createHandler } from '../server/http.mjs';

const update = (patch = {}) => ({ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100, ask: 101, sourceTime: 1000, ...patch });

test('incremental frames send changed values, pace time confirmations and remove delisted quotes', () => {
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map();
  const snapshot = quotes => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 2000, quotes });
  assert.deepEqual(createPerpetualDelta(snapshot([first]), previous).updates, [first]);
  const unchanged = mergePerpetualQuote(first, update({ sourceTime: 2000 }), 2000);
  assert.equal(createPerpetualDelta(snapshot([unchanged]), previous).updates.length, 0);
  const changed = mergePerpetualQuote(unchanged, update({ bid: 100.5, sourceTime: 2001 }), 2001);
  assert.deepEqual(createPerpetualDelta(snapshot([changed]), previous).updates, [changed]);
  const confirmed = mergePerpetualQuote(changed, update({ bid: 100.5, sourceTime: 5000 }), 5000);
  assert.equal(createPerpetualDelta(snapshot([confirmed]), previous).updates.length, 1);
  const removed = createPerpetualDelta(snapshot([]), previous);
  assert.deepEqual(removed.removed, ['test:BTCUSDT']); assert.equal(previous.size, 0);
});

test('price fields retain their own age across sparse funding and mark updates', () => {
  const first = mergePerpetualQuote(null, update(), 1000);
  const funding = mergePerpetualQuote(first, update({ bid: undefined, ask: undefined, fundingRate: 0, fundingIntervalHours: 4, sourceTime: 2000 }), 2000);
  assert.equal(funding.bidAskAt, 1000);
  assert.equal(funding.fundingRate, 0);
  assert.equal(funding.fundingAt, 2000);
  const mark = mergePerpetualQuote(funding, update({ bid: undefined, ask: undefined, mark: 102, sourceTime: 3000 }), 3000);
  assert.equal(mark.bidAskAt, 1000);
  assert.equal(mark.markAt, 3000);
  assert.equal(mergePerpetualQuote(mark, update({ bid: 99, sourceTime: 500 }), 3000), mark);
  assert.equal(mergePerpetualQuote(mark, update({ sourceTime: 999999 }), 3000), mark);
  const missing = mergePerpetualQuote(mark, update({ bid: null, ask: undefined, sourceTime: 4000 }), 4000);
  assert.equal(missing.bid, null);
  assert.equal(missing.ask, 101);
});

test('funding schedules do not refresh old rates and changed contract identities clear old prices', () => {
  const initial = mergePerpetualQuote(null, update({ fundingRate: 0.001, fundingIntervalHours: 8 }), 1000);
  const schedule = mergePerpetualQuote(initial, update({ bid: undefined, ask: undefined, fundingIntervalHours: 4, nextFundingAt: 3600000, sourceTime: 2000 }), 2000);
  assert.equal(schedule.fundingAt, 1000);
  assert.equal(schedule.fundingRate, null, 'An old 8-hour rate must not be relabeled as a new 4-hour rate');
  assert.equal(schedule.fundingIntervalHoursUpdatedAt, 2000);
  assert.equal(schedule.nextFundingAtUpdatedAt, 2000);
  const changed = mergePerpetualQuote(schedule, update({ base: 'DIFFERENT', quoteCurrency: 'USDC', multiplier: 1000, bid: undefined, ask: undefined, mark: 12, sourceTime: 3000 }), 3000);
  assert.equal(changed.base, 'DIFFERENT');
  assert.equal(changed.quoteCurrency, 'USDC');
  assert.equal(changed.multiplier, 1000);
  assert.equal(changed.bid, null);
  assert.equal(changed.ask, null);
  assert.equal(changed.fundingRate, null);
  assert.equal(changed.mark, 12);
});

test('latest quotes survive restart with original timestamps and delisted instruments are pruned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-test-'));
  let store;
  try {
    const filename = join(directory, 'market.sqlite');
    store = await openPerpetualStore(filename);
    const quote = mergePerpetualQuote(null, update(), 1000);
    store.save([quote]); store.close();
    store = await openPerpetualStore(filename);
    assert.deepEqual(store.load(), [quote]);
    store.prune('different', new Set()); assert.equal(store.load().length, 1);
    store.prune('test', new Set()); assert.equal(store.load().length, 0);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

function setup(overrides = {}) {
  const sockets = [], saved = [];
  class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const service = createPerpetualService({
    exchanges: [{ id: 'test', name: 'Test', kind: 'cex' }],
    discover: async () => [update()], subscriptions: (_id, markets) => [{ url: 'wss://example.invalid', subscribe: [{ subscribe: true }], markets }],
    parse: (_id, payload) => Array.isArray(payload) ? payload : [], control: () => null,
    WebSocketImpl: Socket, saveIntervalMs: 5, broadcastIntervalMs: 10, retryMs: 5,
    store: { load: () => [], save: values => saved.push(...values), prune() {}, close() {} }, ...overrides,
  });
  return { service, sockets, saved };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); } assert.fail('Condition did not become true'); }

test('discovered identity changes invalidate restored prices before the first new WS message', async t => {
  const previous = mergePerpetualQuote(null, update({ base: 'OLD-ASSET' }), 1000);
  const pruned = [];
  const { service, sockets } = setup({ clock: () => 1100, store: { load: () => [previous], prune: (_exchange, symbols) => pruned.push([...symbols]), close() {} } });
  t.after(() => service.stop());
  assert.equal(service.snapshot().quotes.length, 1);
  service.start(); await until(() => sockets.length === 1);
  assert.equal(service.snapshot().quotes.length, 0);
  assert.deepEqual(pruned, [[]]);
});

test('slow SSE clients resynchronize with a full frame after missing a delta', async t => {
  let now = 1000;
  const { service, sockets } = setup({ clock: () => now });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const response = Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  service.stream({ headers: {} }, response);
  assert.equal(response.packets[0].quotes[0].bid, 100);
  response.writableNeedDrain = true;
  now = 1100; sockets[0].message([update({ bid: 100.5, sourceTime: now })]);
  const before = service.metrics().frames; await until(() => service.metrics().frames > before);
  assert.equal(response.packets.length, 1);
  response.writableNeedDrain = false;
  await until(() => response.packets.length > 1);
  assert.equal(response.packets[1].type, undefined);
  assert.equal(response.packets[1].quotes[0].bid, 100.5);
  service.closeStreams(); assert.equal(service.metrics().clients, 0);
});

test('collector runs without readers, rejects bad clocks, persists updates and reconnects with fresh context', async t => {
  let now = 1000;
  const { service, sockets, saved } = setup({ clock: () => now });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  await until(() => saved.length === 1);
  assert.equal(service.snapshot().status, 'live');
  assert.equal(service.snapshot().quotes[0].bid, 100);
  now = 32000;
  sockets[0].message([update({ bid: undefined, ask: undefined, fundingRate: 0, sourceTime: now })]);
  assert.equal(service.snapshot().status, 'snapshot');
  sockets[0].close();
  await until(() => sockets.length === 2);
  sockets[1].open(); sockets[1].message([update({ sourceTime: now })]);
  assert.equal(service.snapshot().status, 'live');
  await service.stop();
  const count = sockets.length; await delay(30); assert.equal(sockets.length, count);
});

test('empty and crossed BBOs do not count as fresh market coverage', async t => {
  const { service, sockets } = setup({ clock: () => 1000 });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update({ bid: null, ask: null })]);
  assert.equal(service.snapshot().exchanges[0].quoteCount, 0);
  sockets[0].message([update({ bid: 103, ask: 101 })]);
  assert.equal(service.snapshot().exchanges[0].quoteCount, 0);
});

test('failed delisting cleanup retries even without new quote writes', async t => {
  let pruning = 0;
  const { service, sockets } = setup({ saveIntervalMs: 50, store: {
    load: () => [mergePerpetualQuote(null, update({ symbol: 'OLD' }), 1000)], save() {}, close() {},
    prune(_exchange, symbols) { pruning++; assert.equal(symbols.has('OLD'), false); if (pruning === 1) throw Error('temporarily locked'); },
  } });
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  assert.equal(service.healthy(), false);
  assert.equal(service.snapshot().quotes.length, 0);
  await until(() => pruning === 2);
  assert.equal(service.healthy(), true);
});

test('SSE uses existing authentication, validates methods and closes before HTTP shutdown drains', async t => {
  const { service } = setup();
  const services = new Map([['perpetual', service]]);
  const server = createServer(createHandler({ services, username: 'test', password: 'test-password', nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { service.closeStreams(); await service.stop(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); });
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/stream`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}` };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers, method: 'POST' })).status, 405);
  const response = await fetch(url, { headers });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"monitorId":"perpetual"/);
  service.closeStreams();
  assert.equal((await reader.read()).done, true);
});

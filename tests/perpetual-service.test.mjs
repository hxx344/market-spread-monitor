import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerpetualService, mergePerpetualQuote, createPerpetualDelta, createPerpetualPatch } from '../server/perpetual-service.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { createHandler } from '../server/http.mjs';

const update = (patch = {}) => ({ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100, ask: 101, sourceTime: 1000, ...patch });

test('field patches preserve independent prices and refresh unchanged book times without full quote payloads', () => {
  const snapshot = quotes => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 1000, quotes });
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map();
  assert.deepEqual(createPerpetualPatch(snapshot([first]), previous).patches, [['test:BTCUSDT', first]]);
  const repeated = mergePerpetualQuote(first, update({ sourceTime: 2000 }), 2000);
  assert.equal(createPerpetualPatch(snapshot([repeated]), previous).patches.length, 0);
  const changed = mergePerpetualQuote(repeated, update({ bid: 100.5, sourceTime: 2100 }), 2100);
  const patch = createPerpetualPatch(snapshot([changed]), previous).patches[0][1];
  assert.deepEqual(patch, { bid: 100.5, bidAt: 2100, bidAskAt: 2100, receivedAt: 2100, sourceTime: 2100 });
  assert.equal(previous.get('test:BTCUSDT').askAt, 1000, 'Unchanged confirmations have their own cadence');
  const confirmed = mergePerpetualQuote(changed, update({ bid: 100.5, sourceTime: 5000 }), 5000);
  const confirmation = createPerpetualPatch(snapshot([confirmed]), previous).patches[0][1];
  assert.equal(confirmation.bidAskAt, 5000);
  assert.equal(confirmation.receivedAt, 5000);
  assert.equal(Object.hasOwn(confirmation, 'base'), false);
  assert.equal(Object.hasOwn(confirmation, 'bid'), false);
  const fundingOnly = mergePerpetualQuote(confirmed, update({ bid: undefined, ask: undefined, fundingRate: 0.001, sourceTime: 6000 }), 6000);
  const fundingPatch = createPerpetualPatch(snapshot([fundingOnly]), previous).patches[0][1];
  assert.equal(fundingPatch.fundingAt, 6000);
  assert.equal(Object.hasOwn(fundingPatch, 'bidAskAt'), false);
  assert.deepEqual(createPerpetualPatch(snapshot([]), previous).removed, ['test:BTCUSDT']);
});

test('identity resets explicitly clear old wire price timestamps', () => {
  const first = mergePerpetualQuote(null, update(), 1000), previous = new Map([['test:BTCUSDT', first]]);
  const next = mergePerpetualQuote(first, update({ base: 'OTHER', bid: undefined, ask: undefined, mark: 12, sourceTime: 6000 }), 6000);
  const patch = createPerpetualPatch({ quotes: [next] }, previous).patches[0][1];
  assert.equal(patch.base, 'OTHER'); assert.equal(patch.bid, null); assert.equal(patch.bidAskAt, null);
  assert.equal(previous.get('test:BTCUSDT').bidAt, null);
});

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

test('repeated market updates reuse latest rows and bound retained SQLite journal space', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-test-'));
  let store, inspection;
  try {
    const filename = join(directory, 'market.sqlite');
    store = await openPerpetualStore(filename);
    const values = Array.from({ length: 1000 }, (_, index) => mergePerpetualQuote(null, update({ symbol: `ASSET${index}USDT`, sourceTime: 1800000000000 }), 1800000000000));
    store.save(values);
    inspection = new DatabaseSync(filename);
    inspection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const initialBytes = (await stat(filename)).size;
    for (let batch = 0; batch < 60; batch++) store.save(values.map(quote => ({ ...quote, bid: 101 + batch % 2, receivedAt: 1800000000000 + batch * 15000 })));
    assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM quotes').get().count, 1000);
    const journalBytes = (await stat(`${filename}-wal`)).size;
    assert.ok(journalBytes <= 4194304 + initialBytes * 2, `journal ${journalBytes} bytes exceeds checkpoint plus one batch`);
    inspection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok((await stat(filename)).size <= initialBytes * 2, 'Database must not grow with update count');
    assert.equal((await stat(`${filename}-wal`)).size, 0);
    store.prune('test', new Set(values.slice(0, 50).map(quote => quote.symbol)));
    assert.equal(store.load().length, 50);
  } finally {
    inspection?.close(); store?.close();
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
  assert.ok(response.packets[1].sequence > response.packets[0].sequence);
  assert.equal(response.packets[1].streamId, response.packets[0].streamId);
  service.closeStreams(); assert.equal(service.metrics().clients, 0);
});

test('new SSE clients align with the shared baseline after a price reverses before broadcast', async t => {
  let now = 1000;
  const { service, sockets } = setup({ clock: () => now, broadcastIntervalMs: 50 });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const reader = () => Object.assign(new EventEmitter(), {
    packets: [], writableLength: 0, writableNeedDrain: false, destroyed: false, writableEnded: false,
    writeHead() {}, write(message) { this.packets.push(JSON.parse(message.split('data: ')[1].trim())); },
    end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
  const existing = reader(), joining = reader();
  service.stream({ headers: {} }, existing);
  assert.equal(existing.packets[0].quotes[0].bid, 100);

  // All three operations happen in one event-loop turn, between broadcasts.
  now = 1100; sockets[0].message([update({ bid: 101, ask: 102, sourceTime: now })]);
  assert.equal(service.snapshot().quotes[0].bid, 101);
  service.stream({ headers: {} }, joining);
  assert.equal(joining.packets[0].quotes[0].bid, 100, 'New reader starts with the already-published baseline');
  assert.equal(joining.packets[0].quotes[0].bidAt, 1000, 'Retain the original quote time');
  now = 1200; sockets[0].message([update({ sourceTime: now })]);
  await until(() => existing.packets.length > 1 && joining.packets.length > 1);
  assert.equal(existing.packets[1].type, 'patch', 'First client needs no redundant full snapshot');
  assert.equal(joining.packets[1].type, 'patch');
  assert.equal(joining.packets[1].baseSequence, joining.packets[0].sequence);
  const changes = joining.packets[1].patches.find(([key]) => key === 'test:BTCUSDT')?.[1] ?? {};
  assert.equal({ ...joining.packets[0].quotes[0], ...changes }.bid, 100);
  assert.equal(joining.packets[1].sequence, existing.packets[1].sequence);
  assert.equal(service.metrics().fullFrames, 2, 'Only one full snapshot per reader');

  const before = joining.packets.length, baseline = joining.packets.at(-1).sequence;
  now = 1300; sockets[0].message([update({ bid: 100.5, sourceTime: now })]);
  await until(() => joining.packets.length > before);
  const patch = joining.packets[before];
  assert.equal(patch.type, 'patch'); assert.equal(patch.baseSequence, baseline);
  assert.equal(patch.patches.find(([key]) => key === 'test:BTCUSDT')[1].bid, 100.5);
});

test('WS snapshot requests are paced and REST confirmation cannot continue after connection disposal', async t => {
  let requests = 0, signal, resolveSnapshot;
  const { service, sockets } = setup({ subscriptions: (_id, markets) => [{
    url: 'wss://example.invalid', markets, poll: { messages: [{ request: 1 }, { request: 2 }], intervalMs: 20, sendIntervalMs: 5 },
    snapshot: options => { requests++; signal = options.signal; return new Promise(resolve => { resolveSnapshot = resolve; }); },
  }], saveIntervalMs: 10_000 });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  await delay(130);
  assert.deepEqual(sockets[0].sent.slice(0, 2).map(JSON.parse), [{ request: 1 }, { request: 2 }]);
  await until(() => requests === 1);
  await service.stop();
  assert.equal(signal.aborted, true);
  const sent = sockets[0].sent.length;
  resolveSnapshot([update()]); await delay(30);
  assert.equal(service.snapshot().quotes.length, 0);
  assert.equal(sockets[0].sent.length, sent);
  assert.equal(requests, 1);
});

test('optional book confirmations skip fresh quotes, share a host budget and back off 429 without disconnecting BBO', async t => {
  let now = 100_000;
  const info = symbol => ({ method: 'post', id: symbol, request: { type: 'info', payload: { type: 'l2Book', coin: symbol } } });
  const { service, sockets } = setup({ clock: () => now, saveIntervalMs: 10_000,
    subscriptions: (_id, markets) => [0, 1].map(() => ({
      url: 'wss://shared.example.invalid', markets, sendIntervalMs: 1,
      poll: { messages: [info('BTCUSDT'), info('MISSING')], intervalMs: 10, sendIntervalMs: 1, staleBookAfterMs: 15_000, maxPerMinute: 60 },
    })),
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 2);
  for (const socket of sockets) { socket.open(); socket.message([update({ sourceTime: now })]); }
  await until(() => sockets.some(socket => socket.sent.length));
  const sent = sockets.flatMap(socket => socket.sent).map(JSON.parse);
  assert.equal(sent.length, 1, 'Only one host-wide request is allowed in a one-second slot');
  assert.equal(sent[0].request.payload.coin, 'MISSING', 'Fresh BBO never needs a redundant info request');
  sockets[0].message({ channel: 'post', data: { response: { type: 'error', payload: '429 Too Many Requests' } } });
  now += 1000;
  for (const socket of sockets) socket.message([update({ sourceTime: now, bid: 100.5 })]);
  await delay(35);
  assert.equal(sockets.length, 2); assert.ok(sockets.every(socket => socket.readyState === 1));
  assert.equal(sockets.reduce((total, socket) => total + socket.sent.length, 0), 1);
  assert.equal(service.snapshot().quotes[0].bid, 100.5, 'Main BBO remains active during optional request backoff');
  assert.match(service.metrics().venues[0].lastProtocolError, /429/);
  assert.ok(service.metrics().auxiliary[0].retryAt > now);
});

test('healthy main WS cannot hide a failing whole-market REST confirmation', async t => {
  const { service, sockets } = setup({ subscriptions: (_id, markets) => [{ url: 'wss://example.invalid', markets,
    snapshot: async () => { throw Error('temporarily unreachable'); }, snapshotIntervalMs: 10_000,
  }] });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  await until(() => /快照/.test(service.snapshot().exchanges[0].error ?? ''));
  sockets[0].message([update({ sourceTime: Date.now() })]);
  assert.equal(service.snapshot().exchanges[0].status, 'live');
  assert.match(service.snapshot().exchanges[0].error, /盘口补充快照/);
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

test('restored quotes from a future server clock never count as live coverage', async t => {
  const future = mergePerpetualQuote(null, update({ sourceTime: 100_000 }), 100_000);
  const { service, sockets } = setup({ clock: () => 1000, store: { load: () => [future], prune() {}, close() {} } });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1); sockets[0].open();
  const view = service.snapshot().exchanges[0];
  assert.equal(view.quoteCount, 0); assert.equal(view.freshBookCount, 0); assert.equal(view.missingBookCount, 1);
  assert.equal(view.status, 'stale');
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

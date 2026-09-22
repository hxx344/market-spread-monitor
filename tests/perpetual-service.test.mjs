import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerpetualService, mergePerpetualQuote, createPerpetualDelta, createPerpetualPatch, createPerpetualChangedPatch } from '../server/perpetual-service.mjs';
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

test('dirty-only patches match full baseline semantics for additions, deletions, metadata and paced confirmations', () => {
  const a = mergePerpetualQuote(null, update(), 1000), b = mergePerpetualQuote(null, update({ symbol: 'ETHUSDT', base: 'ETH' }), 1000);
  const initial = new Map([['test:BTCUSDT', a], ['test:ETHUSDT', b]]), full = new Map(initial), incremental = new Map(initial);
  let quotes = new Map(initial);
  const check = keys => {
    const metadata = { schemaVersion: 1, monitorId: 'perpetual', generatedAt: 5000, sequence: 4, exchanges: [{ id: 'test', status: 'live' }] };
    const expected = createPerpetualPatch({ ...metadata, quotes: [...quotes.values()] }, full);
    const actual = createPerpetualChangedPatch(metadata, quotes, incremental, keys);
    assert.deepEqual(actual, expected); assert.deepEqual(incremental, full);
  };
  quotes.set('test:BTCUSDT', mergePerpetualQuote(a, update({ sourceTime: 1100 }), 1100)); check(new Set(['test:BTCUSDT']));
  quotes.set('test:BTCUSDT', { ...quotes.get('test:BTCUSDT'), delisting: true, takerFeeRate: 0.0005, takerFeeAt: 1200 }); check(new Set(['test:BTCUSDT']));
  quotes.delete('test:ETHUSDT'); check(new Set(['test:ETHUSDT']));
  quotes.set('test:BTCUSDT', mergePerpetualQuote(quotes.get('test:BTCUSDT'), update({ sourceTime: 5000 }), 5000)); check(new Set(['test:BTCUSDT']));
  const c = mergePerpetualQuote(null, update({ symbol: 'SOLUSDT', base: 'SOL', sourceTime: 5000 }), 5000); quotes.set('test:SOLUSDT', c); check(new Set(['test:SOLUSDT']));
  check(new Set());
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

test('late REST funding cannot revive an old rate after a newer WS funding interval change', () => {
  const initial = mergePerpetualQuote(null, update({ fundingRate: 0.001, fundingIntervalHours: 8 }), 1000);
  const schedule = mergePerpetualQuote(initial, update({ bid: undefined, ask: undefined, fundingIntervalHours: 4, sourceTime: 3000 }), 3000);
  assert.equal(schedule.fundingRate, null);
  assert.equal(schedule.fundingIntervalHours, 4);
  assert.equal(schedule.fundingIntervalHoursUpdatedAt, 3000);
  assert.equal(schedule.fundingAt, 1000, 'A new interval is not a new rate confirmation');

  const delayed = mergePerpetualQuote(schedule, update({ fundingRate: 0.002, fundingIntervalHours: 8, sourceTime: 2000, transport: 'rest' }), 3500);
  assert.equal(delayed.fundingRate, null, 'An earlier 8-hour REST rate must not be combined with the newer 4-hour interval');
  assert.equal(delayed.fundingIntervalHours, 4);
  assert.equal(delayed.fundingIntervalHoursUpdatedAt, 3000);
  assert.equal(delayed.fundingAt, 1000);
  assert.equal(delayed.bidAskAt, 2000, 'The delayed response may still confirm older independent book fields');

  const confirmed = mergePerpetualQuote(delayed, update({ fundingRate: 0.003, fundingIntervalHours: 4, sourceTime: 4000, transport: 'rest' }), 4500);
  assert.equal(confirmed.fundingRate, 0.003);
  assert.equal(confirmed.fundingIntervalHours, 4);
  assert.equal(confirmed.fundingIntervalHoursUpdatedAt, 4000);
  assert.equal(confirmed.fundingAt, 4000, 'Recovery keeps the actual confirmation time, not the local receipt time');
});

test('latest quotes survive restart with original timestamps and delisted instruments are pruned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-test-'));
  let store;
  try {
    const filename = join(directory, 'market.sqlite');
    store = await openPerpetualStore(filename);
    const quote = { ...mergePerpetualQuote(null, update(), 1000), delisting: true, delistingAt: 200000 };
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

test('CrossEx evidence enriches only its response and preserves existing restored quote identities', async t => {
  let now = 1100;
  let metadata = { assetClass: 'crypto', identitySource: 'symbolType=', identityVerified: true, collateralCurrency: 'USDT' };
  const previous = mergePerpetualQuote(null, update({ exchange: 'binance' }), 1000);
  const { service, sockets } = setup({ clock: () => now, discoveryIntervalMs: 20,
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }],
    discover: async () => [{ ...update({ exchange: 'binance', multiplier: 1 }), ...metadata }],
    store: { load: () => [previous], prune() {}, save() {}, close() {} },
  });
  assert.deepEqual(service.handle('opportunities', 'GET').quotes, [], 'Restored cache alone has no current directory evidence');
  t.after(() => service.stop()); service.start();
  await until(() => sockets.length === 1);
  const current = service.handle('opportunities', 'GET').quotes[0];
  assert.equal(current.identityVerified, true); assert.equal(current.assetClass, 'crypto');
  assert.equal(current.collateralCurrency, 'USDT'); assert.equal(current.bidAskAt, 1000); assert.equal(current.receivedAt, 1000);
  const retained = service.snapshot().quotes[0];
  assert.equal(retained.collateralCurrency, undefined); assert.equal(retained.identityVerified, undefined);
  now = 3000; metadata = { ...metadata, identityVerified: false };
  await until(() => service.handle('opportunities', 'GET').quotes.length === 0);
  assert.equal(service.snapshot().quotes[0], retained); assert.equal(sockets.length, 1);
});

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

test('lifecycle discovery updates, persists and clears notices without reconnecting or freshening prices', async t => {
  let now = 1000, catalog = { delisting: false, delistingAt: null }, fail = false, attempts = 0;
  const { service, sockets, saved } = setup({ clock: () => now, discoveryIntervalMs: 20,
    discover: async () => { attempts++; if (fail) throw Error('offline'); return [{ ...update(), ...catalog }]; },
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update()]);
  const original = service.snapshot().quotes[0];
  const baseline = new Map([['test:BTCUSDT', original]]);
  now = 32000; catalog = { delisting: true, delistingAt: 200000 };
  await until(() => service.snapshot().quotes[0].delisting === true);
  const announced = service.snapshot().quotes[0];
  assert.equal(announced.delistingAt, 200000);
  assert.equal(announced.receivedAt, original.receivedAt);
  assert.equal(announced.bidAskAt, original.bidAskAt);
  assert.equal(service.snapshot().exchanges[0].status, 'stale');
  assert.equal(sockets.length, 1, 'A metadata-only refresh must keep the existing WS connection');
  const patch = createPerpetualPatch(service.snapshot(), baseline).patches[0][1];
  assert.equal(patch.delisting, true); assert.equal(patch.delistingAt, 200000);
  assert.equal(Object.hasOwn(patch, 'bidAskAt'), false);
  await until(() => saved.some(quote => quote.delisting && quote.delistingAt === 200000));

  // Price parsers from old subscriptions must not override newer catalog data.
  sockets[0].message([update({ sourceTime: now, delisting: false, delistingAt: null })]);
  assert.equal(service.snapshot().quotes[0].delisting, true);
  fail = true; const before = attempts;
  await until(() => attempts > before);
  assert.equal(service.snapshot().quotes[0].delistingAt, 200000, 'A failed directory read retains the last official notice');

  fail = false; catalog = { delisting: false, delistingAt: null };
  await until(() => service.snapshot().quotes[0].delisting === false);
  assert.equal(service.snapshot().quotes[0].delistingAt, null);
  assert.equal(sockets.length, 1);
  const cleared = createPerpetualPatch(service.snapshot(), baseline).patches[0][1];
  assert.equal(cleared.delisting, false); assert.equal(cleared.delistingAt, null);
});

test('catalog taker fees update per contract and clear independently without reconnecting or confirming old prices', async t => {
  let now = 1000, fail = false, attempts = 0;
  let catalog = { takerFeeRate: 0.0006, takerFeeAt: now, takerFeeSource: 'bitget-contract' };
  const { service, sockets, saved } = setup({ clock: () => now, discoveryIntervalMs: 20,
    discover: async () => {
      attempts++; if (fail) throw Error('offline');
      return [{ ...update(), ...catalog }, update({ symbol: 'ETHUSDT', base: 'ETH', takerFeeRate: 0, takerFeeAt: 1000, takerFeeSource: 'bitget-contract' }), update({ symbol: 'UNKNOWNUSDT', base: 'UNKNOWN' })];
    },
  });
  t.after(() => service.stop()); service.start(); await until(() => sockets.length === 1);
  sockets[0].open(); sockets[0].message([update(), update({ symbol: 'ETHUSDT', base: 'ETH' }), update({ symbol: 'UNKNOWNUSDT', base: 'UNKNOWN' })]);
  const original = service.snapshot().quotes[0];
  assert.equal(original.takerFeeRate, 0.0006);
  assert.equal(service.snapshot().quotes[1].takerFeeRate, 0, 'An explicit zero is a real published fee');
  assert.equal(Object.hasOwn(service.snapshot().quotes[2], 'takerFeeRate'), false, 'Unrelated venues need no empty fee fields');
  const baseline = new Map([['test:BTCUSDT', original]]), deltaBaseline = new Map(baseline);

  now = 32000; catalog = { ...catalog, takerFeeRate: 0.0008, takerFeeAt: now };
  await until(() => service.snapshot().quotes[0].takerFeeRate === 0.0008);
  const changed = service.snapshot().quotes[0];
  assert.equal(changed.bidAskAt, original.bidAskAt); assert.equal(changed.receivedAt, original.receivedAt);
  assert.equal(changed.sourceTime, original.sourceTime);
  assert.equal(service.snapshot().exchanges[0].status, 'stale');
  assert.equal(sockets.length, 1);
  const patch = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.equal(patch.takerFeeRate, 0.0008); assert.equal(patch.takerFeeAt, now);
  assert.equal(Object.hasOwn(patch, 'bidAskAt'), false);
  assert.equal(createPerpetualDelta(service.snapshot(), deltaBaseline).updates.find(quote => quote.symbol === 'BTCUSDT').takerFeeRate, 0.0008);
  await until(() => saved.some(quote => quote.symbol === 'BTCUSDT' && quote.takerFeeRate === 0.0008));

  // Rechecking the same fee confirms only its own timestamp.
  now++; catalog = { ...catalog, takerFeeAt: now };
  await until(() => service.snapshot().quotes[0].takerFeeAt === now);
  const timePatch = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.deepEqual(timePatch, { takerFeeAt: now, receivedAt: 1000 });
  assert.equal(createPerpetualDelta(service.snapshot(), deltaBaseline).updates.find(quote => quote.symbol === 'BTCUSDT').takerFeeAt, now);
  assert.equal(sockets.length, 1);

  sockets[0].message([update({ sourceTime: now, takerFeeRate: 0.1, takerFeeAt: now + 1000 })]);
  assert.equal(service.snapshot().quotes[0].takerFeeRate, 0.0008, 'Old subscription contexts cannot override the current catalog');
  fail = true; const before = attempts;
  await until(() => attempts > before);
  assert.equal(service.snapshot().quotes[0].takerFeeAt, now, 'An unavailable directory cannot confirm a cached fee');

  fail = false; catalog = { takerFeeRate: null, takerFeeAt: null, takerFeeSource: 'bitget-contract' };
  await until(() => service.snapshot().quotes[0].takerFeeRate === null);
  const cleared = createPerpetualPatch(service.snapshot(), baseline).patches.find(([key]) => key === 'test:BTCUSDT')[1];
  assert.equal(cleared.takerFeeRate, null); assert.equal(cleared.takerFeeAt, null);
  assert.equal(sockets.length, 1);

  catalog = {};
  await until(() => service.snapshot().quotes[0].takerFeeSource === null);
  assert.equal(service.snapshot().quotes[0].takerFeeRate, null);
  assert.equal(sockets.length, 1, 'Removing all fee fields is also a metadata-only change');
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

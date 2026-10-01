import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { normalizeSettledFunding, validateExchangeFundingHistory, exchangeFundingAction, HISTORY_REFRESH_MS, HISTORY_STALE_MS, HISTORY_WINDOW_MS } from '../lib/exchange-funding-history.ts';
import { parseHyperliquidFundingHistory, parseLighterFundingHistory, createExchangeFundingReader } from '../lib/exchange-funding-service.ts';
import { comparisonExchanges, exchangeDefinition } from '../lib/exchange-quotes.ts';
import { createDataReader } from '../lib/monitor-service.ts';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector, marketJobs } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000;
function history(exchange = 'hyperliquid', now = NOW) {
  const definition = exchangeDefinition(exchange, 'oil'), fetchedAt = new Date(now).toISOString();
  return validateExchangeFundingHistory({ exchange, monitorId: 'oil', currency: definition.currency, fetchedAt, status: 'live', availability: exchange === 'variational' ? 'unsupported' : 'supported', reason: exchange === 'variational' ? 'No public settled history' : '',
    left: { symbol: definition.left, fetchedAt: exchange === 'variational' ? null : fetchedAt, error: '' }, right: { symbol: definition.right, fetchedAt: exchange === 'variational' ? null : fetchedAt, error: '' },
    rows: exchange === 'variational' ? [] : [{ time: now - HOUR + 21, leftRate: 0, rightRate: null }, { time: now - HOUR + 32, leftRate: null, rightRate: -0.0001 }],
  }, exchange);
}

test('history normalization preserves actual zero and milliseconds, rejects conflicts, limits each leg to latest 20 within seven days', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ time: NOW - index * HOUR, rate: index ? -0.0001 : 0 }));
  const parsed = normalizeSettledFunding([...rows, rows[0], { time: NOW + 1, rate: 0.01 }, { time: NOW - HISTORY_WINDOW_MS - 1, rate: 0.01 }], NOW);
  assert.equal(parsed.length, 20); assert.deepEqual(parsed[0], { time: NOW, rate: 0 });
  assert.equal(parsed.at(-1).time, NOW - 19 * HOUR);
  assert.throws(() => normalizeSettledFunding([{ time: NOW, rate: 0 }, { time: NOW, rate: 1 }], NOW), /Conflicting/);
  for (const value of [NaN, Infinity, null, '0', 1.1]) assert.throws(() => normalizeSettledFunding([{ time: NOW, rate: value }], NOW));
});

test('DEX parsers use settled fields, real source precision, Lighter payer direction and percentage units', () => {
  const hl = [{ coin: 'xyz:BRENTOIL', time: NOW - HOUR + 21, fundingRate: '0' }];
  assert.deepEqual(parseHyperliquidFundingHistory(hl, 'xyz:BRENTOIL', NOW), [{ time: NOW - HOUR + 21, rate: 0 }]);
  assert.throws(() => parseHyperliquidFundingHistory(hl, 'xyz:CL', NOW), /mismatch/);
  const funding = { code: 200, fundings: [{ timestamp: NOW / 1000 - 3600, rate: '0.0003', value: '0.00027658', direction: 'short' }, { timestamp: NOW / 1000 - 7200, rate: '0.0007', direction: 'long' }, { timestamp: NOW / 1000 - 10800, rate: '0', direction: 'short' }] };
  const parsed = parseLighterFundingHistory(funding, 145, NOW);
  assert.ok(Math.abs(parsed[0].rate + 0.000003) < 1e-15); assert.ok(Math.abs(parsed[1].rate - 0.000007) < 1e-15); assert.equal(parsed[2].rate, 0);
  for (const patch of [{ rate: '-0.001' }, { rate: '' }, { direction: 'unknown' }, { market_id: 159 }, { timestamp: NOW }]) {
    assert.throws(() => parseLighterFundingHistory({ code: 200, fundings: [{ ...funding.fundings[0], ...patch }] }, 145, NOW));
  }
  assert.throws(() => parseLighterFundingHistory({ code: 400, fundings: [] }, 145, NOW));
});

test('history boundary rejects wrong identity, invented missing values, invalid future settlements and unsupported data', () => {
  const value = history();
  for (const patch of [{ exchange: 'binance' }, { monitorId: 'hynix' }, { currency: 'USDT' }, { left: { ...value.left, fetchedAt: null } }, { rows: [{ time: NOW + 1, leftRate: 0, rightRate: null }] }, { rows: [{ time: NOW, leftRate: '', rightRate: null }] }, { rows: [...value.rows, value.rows[0]] }, { availability: 'unsupported' }]) assert.throws(() => validateExchangeFundingHistory({ ...value, ...patch }, 'hyperliquid'));
  assert.equal(history('variational').availability, 'unsupported');
  assert.throws(() => validateExchangeFundingHistory({ ...history('variational'), rows: value.rows }, 'variational'));
});

test('independent legs retain old records and receipt time on partial failure; all-failed loads reject; asynchronous settlements never align', async () => {
  let now = NOW, fail = '';
  const read = createExchangeFundingReader({ clock: () => now, fetcher: async (_url, init) => {
    const { coin } = JSON.parse(init.body);
    if (fail === 'all' || coin === fail) return new Response('', { status: 503 });
    return Response.json([{ coin, time: now - HOUR + (coin.endsWith('CL') ? 32 : 21), fundingRate: coin.endsWith('CL') ? '-0.0001' : '0' }]);
  } });
  const initial = await read('hyperliquid');
  assert.equal(initial.rows.length, 2); assert.ok(initial.rows.every(row => (row.leftRate === null) !== (row.rightRate === null)));
  now += 300_000; fail = 'xyz:CL';
  const partial = await read('hyperliquid', initial);
  assert.equal(partial.left.fetchedAt, new Date(now).toISOString()); assert.equal(partial.right.fetchedAt, initial.right.fetchedAt); assert.ok(partial.right.error);
  assert.deepEqual(partial.rows.find(row => row.rightRate !== null), initial.rows.find(row => row.rightRate !== null));
  const firstPartial = await read('hyperliquid'); assert.equal(firstPartial.right.fetchedAt, null); assert.ok(firstPartial.rows.every(row => row.rightRate === null));
  fail = 'all'; await assert.rejects(read('hyperliquid', partial));
});

test('Lighter dynamically discovers and shares metadata while history remains independent, Variational performs no invented request', async () => {
  let metadataCalls = 0, historyCalls = 0;
  const read = createExchangeFundingReader({ clock: () => NOW, fetcher: async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('orderBookDetails')) {
      metadataCalls++;
      return Response.json({ code: 200, order_book_details: ['BRENTOIL', 'WTI'].map((symbol, i) => ({ symbol, market_id: 200 + i, market_type: 'perp', status: 'active', multiplier: 1 })) });
    }
    historyCalls++; assert.ok(['200', '201'].includes(url.searchParams.get('market_id'))); assert.equal(url.searchParams.get('resolution'), '1h');
    return Response.json({ code: 200, fundings: [{ timestamp: NOW / 1000 - 3600, rate: '0.001', direction: 'long' }] });
  } });
  assert.equal((await read('lighter')).rows[0].leftRate, 0.00001); assert.equal(metadataCalls, 1); assert.equal(historyCalls, 2);
  assert.equal((await read('variational')).availability, 'unsupported'); assert.equal(historyCalls, 2);
});

test('preview history has an independent five-minute cache, deduplicates requests and retains original timestamps on failure', async () => {
  let now = NOW, calls = 0, fail = false;
  const read = createDataReader({ oil: { quote: async () => ({}) }, hynix: { quote: async () => ({}) } }, () => now, async () => { throw Error('quote path used'); }, async () => {
    calls++; if (fail) throw Error('offline'); return history('okx', now);
  });
  const action = exchangeFundingAction('okx');
  const values = await Promise.all([read('oil', action), read('oil', action)]); assert.equal(calls, 1);
  now += HISTORY_REFRESH_MS - 1; assert.equal((await read('oil', action)).fetchedAt, values[0].fetchedAt); assert.equal(calls, 1);
  now += 2; fail = true;
  const retained = await read('oil', action); assert.equal(retained.status, 'snapshot'); assert.equal(retained.fetchedAt, values[0].fetchedAt); assert.equal(calls, 2);
  for (const id of ['hynix', 'perpetual', 'cl-xau']) await assert.rejects(read(id, action), /Unsupported/);
  await assert.rejects(read('oil', 'exchanges/fake/funding-history'));
});

test('history schedules and persistent API reads retain failures without loading upstream or modifying the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settled-funding-test-'));
  let store, services, server;
  try {
    let now = Date.now(); store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => now });
    for (const exchange of comparisonExchanges('oil')) store.write('oil', exchangeFundingAction(exchange), history(exchange, now));
    const action = exchangeFundingAction('hyperliquid'), initial = store.raw('oil', action);
    store.write('oil', action, initial); assert.equal(store.count('oil', action), 2);
    now += HISTORY_STALE_MS + 1; assert.equal(store.read('oil', action).status, 'snapshot');
    const collector = createMarketCollector(store, { jobs: [] });
    await collector.collect({ id: 'oil', action, load() { throw Error('offline'); } });
    assert.equal(store.read('oil', action).fetchedAt, initial.fetchedAt); assert.equal(store.read('oil', action).status, 'snapshot');
    await collector.stop(); store.close(); store = null;
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
    server = createServer(createHandler({ services, username: 'admin', password: 'history-test-password', nextHandler(_req, res) { res.writeHead(404).end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Basic ${Buffer.from('admin:history-test-password').toString('base64')}` }, before = services.market.status();
    for (const exchange of comparisonExchanges('oil')) {
      const path = exchangeFundingAction(exchange), url = `${base}/api/monitors/oil/${path}`;
      assert.equal((await fetch(url)).status, 401);
      const response = await fetch(url, { headers }); assert.equal(response.status, 200);
      const value = await response.json(); assert.equal(value.exchange, exchange); assert.equal(value.collection.source, 'database');
      assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
      assert.equal((await fetch(`${base}/api/monitors/hynix/${path}`, { headers })).status, 404);
    }
    assert.deepEqual(services.market.status(), before);
    const jobs = marketJobs().filter(job => job.action.endsWith('/funding-history'));
    assert.equal(jobs.length, 7); assert.ok(jobs.every(job => job.id === 'oil' && job.intervalMs === HISTORY_REFRESH_MS));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
    store?.close(); await rm(directory, { recursive: true, force: true });
  }
});

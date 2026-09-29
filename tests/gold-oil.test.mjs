import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goldOilRatio, validateGoldOilQuote, goldOilChartPoints, GOLD_OIL_INTERVAL_MS as STEP } from '../lib/gold-oil.ts';
import { parseGoldOilQuote, parseGoldOilHistory, validateGoldOilContracts, createGoldOilReader } from '../lib/gold-oil-service.ts';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector } from '../server/market-collector.mjs';
import { openMonitorControlStore } from '../server/monitor-control.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';
import { readHubSummary } from '../server/hub-summary.mjs';
import { createDataReader } from '../lib/monitor-service.ts';
import { goldOilSummary } from '../lib/monitor-summary.ts';

const now = Date.UTC(2026, 8, 30, 12), stamp = new Date(now).toISOString();
const ticker = (symbol, markPrice, time = now) => ({ symbol, markPrice: String(markPrice), time });
const quote = () => parseGoldOilQuote(ticker('CLUSDT', 80), ticker('XAUUSDT', 4000), now);
const candle = (time, price) => [time, String(price), String(price), String(price), String(price), '0', time + STEP - 1];
const metadata = () => ({ symbols: ['CL', 'XAU'].map(baseAsset => ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' })) });
async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'gold-oil-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test('XAU divided by CL recomputes derived ratios and rejects invalid prices', () => {
  assert.equal(goldOilRatio(80, 4000), 50); assert.equal(goldOilRatio(100, 4000), 40);
  for (const invalid of [null, 0, -1, Infinity, NaN]) { assert.equal(goldOilRatio(invalid, 4000), null); assert.equal(goldOilRatio(80, invalid), null); }
  assert.equal(goldOilRatio(Number.MIN_VALUE, Number.MAX_VALUE), null);
  assert.equal(validateGoldOilQuote({ ...quote(), ratio: 999 }).ratio, 50);
  assert.equal(goldOilSummary(quote()).metrics[0].value, '50.000');
  assert.equal(goldOilSummary(quote(), true).status, 'stale'); assert.equal(goldOilSummary(quote(), true).fetchedAt, stamp);
});

test('exact contracts, positive marks and synchronized source times are required', () => {
  validateGoldOilContracts(metadata());
  for (const [field, value] of [['baseAsset', 'XAUT'], ['quoteAsset', 'USDC'], ['marginAsset', 'USDC'], ['status', 'SETTLING'], ['contractType', 'CURRENT_QUARTER']]) {
    const input = metadata(); input.symbols[1][field] = value; assert.throws(() => validateGoldOilContracts(input));
  }
  const duplicate = metadata(); duplicate.symbols.push(duplicate.symbols[1]); assert.throws(() => validateGoldOilContracts(duplicate));
  for (const leg of [ticker('PAXGUSDT', 4000), ticker('XAUUSDT', 0), ticker('XAUUSDT', -1), ticker('XAUUSDT', ''), ticker('XAUUSDT', 4000, now + 2000), ticker('XAUUSDT', 4000, now - 16_000), ticker('XAUUSDT', 4000, now - 100_000)]) assert.throws(() => parseGoldOilQuote(ticker('CLUSDT', 80), leg, now));
  assert.equal(parseGoldOilQuote(ticker('CLUSDT', 80, now - 1000), ticker('XAUUSDT', 4000), now).fetchedAt, new Date(now - 1000).toISOString());
});

test('history pairs completed periods, preserves missing legs and breaks chart gaps', () => {
  const history = parseGoldOilHistory([candle(now - 4 * STEP, 80), candle(now - 2 * STEP, 100), candle(now - STEP, 100), candle(now, 100)], [candle(now - 4 * STEP, 4000), candle(now - 2 * STEP, 4100), candle(now, 4100)], now);
  assert.deepEqual(history.points.map(row => row.ratio), [50, 41, null]);
  assert.deepEqual(goldOilChartPoints(history, 7).map(row => row.ratio), [50, null, 41, null]);
  assert.equal(history.points.at(-1).xau, null);
  assert.deepEqual(parseGoldOilHistory([candle(now - STEP, 100)], [candle(now - STEP, 4200)], now, history).points.map(row => row.ratio), [50, 41, 42]);
  for (const input of [[candle(now - STEP, 0)], [candle(now - STEP, 80), candle(now - STEP, 80)], [candle(now - STEP + 1, 80)], [candle(now, 80)], []]) assert.throws(() => parseGoldOilHistory(input, [candle(now - STEP, 4000)], now));
  assert.throws(() => parseGoldOilHistory([], [], now, history), 'Empty response cannot relabel retained history live');
});

test('Binance reader shares metadata, uses mark-price history and retries errors', async () => {
  const paths = [], fetcher = async input => {
    const url = new URL(input); paths.push(url);
    if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
    const price = url.searchParams.get('symbol') === 'CLUSDT' ? 80 : 4000;
    if (url.pathname.endsWith('premiumIndex')) return Response.json(ticker(url.searchParams.get('symbol'), price));
    assert.equal(url.pathname, '/fapi/v1/markPriceKlines'); assert.equal(url.searchParams.get('interval'), '15m'); assert.equal(Number(url.searchParams.get('endTime')), now - 1);
    return Response.json([candle(now - STEP, price)]);
  };
  const reader = createGoldOilReader({ fetcher, clock: () => now });
  const [live, history] = await Promise.all([reader.quote(), reader.history()]);
  assert.equal(live.ratio, 50); assert.equal(history.points[0].ratio, 50); assert.equal(paths.filter(url => url.pathname.endsWith('exchangeInfo')).length, 1);
  let fail = true;
  const retry = createGoldOilReader({ clock: () => now, fetcher: async input => fail ? new Response('', { status: 503 }) : fetcher(input) });
  await assert.rejects(retry.quote()); fail = false; assert.equal((await retry.quote()).ratio, 50);
});

test('resident storage retains values and source time through outage and reopen', async t => {
  const directory = await temporary(t); let clock = now, fail = false;
  let store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => clock });
  const job = { id: 'cl-xau', action: 'quote', intervalMs: 30_000, load: async () => { if (fail) throw Error('offline'); return quote(); } };
  const collector = createMarketCollector(store, { jobs: [job] });
  try {
    await collector.collect(job); assert.equal(store.read('cl-xau', 'quote').ratio, 50);
    clock += 31_000; fail = true; await collector.collect(job);
    const retained = store.read('cl-xau', 'quote'); assert.equal(retained.status, 'snapshot'); assert.equal(retained.fetchedAt, stamp); assert.equal(retained.ratio, 50);
    assert.throws(() => store.read('cl-xau', 'quote', { fresh: true })); assert.equal(store.count('cl-xau', 'quote'), 1);
    store.close(); store = await openMarketStore(join(directory, 'market.sqlite'), { clock: () => clock }); assert.equal(store.read('cl-xau', 'quote').fetchedAt, stamp);
    assert.throws(() => store.write('cl-xau', 'quote', { ...quote(), fetchedAt: new Date(now + 5000).toISOString() }));
  } finally { await collector.stop(); store.close(); }
});

test('old switches gain only the new module and still reject corrupt entries', async t => {
  const directory = await temporary(t), file = join(directory, 'monitor-control.json');
  const old = { version: 1, monitors: { oil: { enabled: false, revision: 8 }, hynix: { enabled: true, revision: 2 }, perpetual: { enabled: false, revision: 3 } } };
  await writeFile(file, JSON.stringify(old)); const store = await openMonitorControlStore(directory);
  for (const id of Object.keys(old.monitors)) assert.deepEqual(store.get().monitors[id], old.monitors[id]);
  assert.deepEqual(store.get().monitors['cl-xau'], { enabled: true, revision: 0 }); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), old);
  const next = store.get(); next.monitors['cl-xau'] = { enabled: false, revision: 1 }; await store.save(next); assert.deepEqual((await openMonitorControlStore(directory)).get(), next);
  for (const invalid of [null, { enabled: 'false', revision: 0 }]) { await writeFile(file, JSON.stringify({ ...old, monitors: { ...old.monitors, 'cl-xau': invalid } })); await assert.rejects(openMonitorControlStore(directory)); }
  const missing = structuredClone(old); delete missing.monitors.oil; await writeFile(file, JSON.stringify(missing)); await assert.rejects(openMonitorControlStore(directory));
});

test('resident APIs read only caches, expose ratio summary and pause independently', async t => {
  const directory = await temporary(t), services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
  try {
    const before = services.market.status(); await assert.rejects(services.get('cl-xau').handle('quote', 'GET'), /尚未收到/);
    assert.deepEqual((await readInitialMarket(services))['cl-xau'], { quote: null, history: null }); assert.deepEqual(services.market.status(), before);
    assert.equal((await readHubSummary(services, now, 'cl-xau')).health.state, 'offline');
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: false, revision: 0 }); await assert.rejects(services.get('cl-xau').handle('history', 'GET'), { status: 423 });
    assert.equal(services.get('oil').runtime().enabled, true);
    await services.get('cl-xau').handle('runtime', 'PUT', { enabled: true, revision: 1 }); assert.equal(services.get('cl-xau').runtime().enabled, true);
  } finally { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
  const cached = new Map([['cl-xau', { handle: async () => quote() }]]), summary = await readHubSummary(cached, now, 'cl-xau');
  assert.equal(summary.health.state, 'online'); assert.deepEqual(summary.metrics[0], { key: 'ratio', label: '金油比 XAU / CL', value: 50, unit: '桶/盎司' });
  assert.equal((await readHubSummary(cached, now + 76_000, 'cl-xau')).health.state, 'stale'); assert.equal((await readInitialMarket(cached))['cl-xau'].quote.ratio, 50);
});

test('preview cache and capabilities remain separate from oil', async () => {
  let calls = 0;
  const read = createDataReader({ 'cl-xau': { quote: async () => { calls++; return quote(); } }, oil: { quote: async () => ({ brent: 80 }) } });
  const pair = await Promise.all([read('cl-xau', 'quote'), read('cl-xau', 'quote')]);
  assert.equal(calls, 1); assert.equal(pair[0].ratio, 50); assert.deepEqual(await read('oil', 'quote'), { brent: 80 });
  await assert.rejects(read('cl-xau', 'funding')); await assert.rejects(read('cl-xau', 'exchanges/binance/quote'));
});

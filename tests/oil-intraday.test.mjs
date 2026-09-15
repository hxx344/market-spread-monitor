import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASSETS } from '../modules/oil/hyperliquid.mjs';
import { OIL_CANDLE_MS as BAR, pairIntradayCandles, createIntradaySnapshot, validateIntradaySnapshot, fetchIntradaySnapshot, intradayChartRows } from '../modules/oil/intraday.mjs';
import { filterRows } from '../modules/oil/data-utils.mjs';
import { analyzeFundingWindow, HOUR } from '../modules/oil/funding-history.mjs';

const START = Date.UTC(2026, 8, 1);
const saved = JSON.parse(await readFile(new URL('../public/oil/data/hyperliquid-15m.json', import.meta.url), 'utf8'));
const candle = (coin, time, close) => ({ s: coin, i: '15m', t: time, T: time + BAR - 1, c: String(close) });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('real archive has 5,000 aligned completed 15-minute pairs and filters exactly one day or week', () => {
  const snapshot = validateIntradaySnapshot(saved), rows = intradayChartRows(snapshot);
  assert.ok(rows.length >= 5000);
  assert.equal(snapshot.metadata.missingObservationRows, 0);
  rows.forEach((row, index) => {
    if (index) assert.equal(row.time - rows[index - 1].time, BAR);
    assert.ok(row.time + BAR <= Date.parse(snapshot.metadata.fetchedAt));
    near(row.spread, Math.round((row.brent - row.wti) * 1e6) / 1e6);
  });
  assert.equal(filterRows(rows, '1d', BAR).length, 96);
  assert.equal(filterRows(rows, '1w', BAR).length, 672);
  assert.equal(filterRows(rows, 'all', BAR).length, rows.length);
});

test('pairs matching completed bars only, retaining missing legs and real time gaps', () => {
  const rows = pairIntradayCandles(
    [0, 1, 3, 4].map(i => candle(ASSETS.brent.coin, START + i * BAR, 80 + i)),
    [0, 3, 4].map(i => candle(ASSETS.wti.coin, START + i * BAR, 70 + i)), START + 4 * BAR);
  assert.deepEqual(rows.map(row => [row.time - START, row.wti]), [[0, 70], [BAR, null], [3 * BAR, 73]]);
  const snapshot = createIntradaySnapshot(rows, new Date(START + 4 * BAR).toISOString());
  assert.equal(snapshot.metadata.pairedObservationRows, 2);
  assert.equal(snapshot.metadata.missingObservationRows, 2);
  assert.deepEqual(intradayChartRows(snapshot).map(row => row.time), [START, START + 3 * BAR]);
});

test('rejects wrong markets, intervals, malformed timestamps, duplicates, unfinished snapshots and false coverage', () => {
  const left = candle(ASSETS.brent.coin, START, 80), right = candle(ASSETS.wti.coin, START, 70), now = START + BAR;
  for (const changed of [{ s: 'xyz:WTIOIL' }, { i: '1d' }, { t: START + 1 }, { T: now }, { c: '' }, { c: 0 }, { c: 'Infinity' }]) assert.throws(() => pairIntradayCandles([{ ...left, ...changed }], [right], now));
  assert.throws(() => pairIntradayCandles([left, left], [right], now));
  assert.throws(() => pairIntradayCandles({}, [right], now));
  assert.throws(() => createIntradaySnapshot([{time: START, brent: 80, wti: 70}], new Date(now - 1).toISOString()));
  assert.throws(() => validateIntradaySnapshot({ ...saved, metadata: { ...saved.metadata, pairedObservationRows: 1 } }));
  assert.throws(() => validateIntradaySnapshot({ ...saved, metadata: { ...saved.metadata, interval: '1d' } }));
});

test('incremental collection repairs an interior gap and missing leg, keeps older saved history, and excludes the open bar', async () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({ time: START + i * BAR, brent: i === 11 ? null : 80, wti: 70 })).filter((_, i) => i !== 10);
  const existing = createIntradaySnapshot(rows, new Date(START + 160 * BAR).toISOString()), before = JSON.stringify(existing), requests = [];
  const result = await fetchIntradaySnapshot(existing, { now: START + 161 * BAR, fetcher: async (_url, options) => {
    const { req } = JSON.parse(options.body); requests.push(req);
    return Response.json([10, 11, 160, 161].map(i => candle(req.coin, START + i * BAR, req.coin === ASSETS.brent.coin ? 81 : 71)));
  } });
  assert.ok(requests.every(req => req.interval === '15m' && req.startTime === START + 10 * BAR));
  assert.equal(result.data.length, 161);
  assert.deepEqual(result.data[0], existing.data[0]);
  assert.deepEqual(result.data[11], { time: START + 11 * BAR, brent: 81, wti: 71 });
  assert.equal(result.metadata.missingObservationRows, 0);
  assert.equal(JSON.stringify(existing), before);
});

test('API lookback is capped at 5,000 bars while previously saved older observations survive', async () => {
  const now = START + 7000 * BAR, rows = [0, 2, 6999].map(i => ({ time: START + i * BAR, brent: 80, wti: 70 }));
  const existing = createIntradaySnapshot(rows, new Date(now).toISOString()), requests = [];
  const next = await fetchIntradaySnapshot(existing, { now, fetcher: async (_url, options) => {
    const { req } = JSON.parse(options.body); requests.push(req);
    return Response.json([candle(req.coin, START + 6999 * BAR, 80)]);
  } });
  assert.ok(requests.every(req => req.startTime === START + 2000 * BAR));
  assert.equal(next.data[0].time, START);
  assert.equal(next.data[1].time, START + 2 * BAR);
});

test('a failed candle leg leaves the previous snapshot and its original collection time unchanged', async () => {
  const existing = createIntradaySnapshot([{time: START, brent: 80, wti: 70}], new Date(START + BAR).toISOString()), before = JSON.stringify(existing);
  await assert.rejects(() => fetchIntradaySnapshot(existing, { now: START + 2 * BAR, fetcher: async (_url, options) => JSON.parse(options.body).req.coin === ASSETS.brent.coin ? Response.json([candle(ASSETS.brent.coin, START + BAR, 81)]) : new Response('', { status: 503 }) }));
  assert.equal(JSON.stringify(existing), before);
});

test('calendar month windows preserve intraday time and clamp month end', () => {
  const timestamps = ['2026-02-28T10:00Z', '2026-02-28T10:15Z', '2026-03-31T10:00Z'];
  const rows = timestamps.map(date => ({ date }));
  assert.deepEqual(filterRows(rows, '1m', BAR).map(row => row.date), timestamps.slice(1));
});

test('15-minute selection counts each actual funding settlement once and excludes both outside boundaries', () => {
  const rows = Array.from({ length: 29 }, (_, i) => ({ time: START + i * HOUR, brent: i === 25 ? null : (i + 1) / 10000, wti: 0.0001 }));
  const start = START + BAR, end = START + 27 * HOUR;
  const included = rows.filter(row => row.time >= start && row.time < end && row.brent !== null);
  const sum = included.reduce((total, row) => total + (row.brent - row.wti) / 2, 0);
  const result = analyzeFundingWindow(rows, start, end);
  assert.equal(result.expectedHours, 26);
  assert.equal(result.count, 25);
  assert.equal(result.missingHours, 1);
  assert.deepEqual(result.points.map(row => [row.time - START, row.count]), [[23 * HOUR, 23], [26 * HOUR, 2]]);
  near(result.shortCumulative, sum);
  near(result.shortAnnualized, sum / included.length * 8760);
  near(result.longAnnualized, -result.shortAnnualized);
});

test('funding quarter-hour windows distinguish no settlement, missing settlement and valid zero', () => {
  const rows = [{time: START, brent: 0, wti: 0}];
  const zero = analyzeFundingWindow(rows, START, START + BAR);
  assert.equal(zero.count, 1); assert.equal(zero.shortAnnualized, 0);
  const absent = analyzeFundingWindow(rows, START + BAR, START + HOUR);
  assert.equal(absent.expectedHours, 0); assert.equal(absent.shortAnnualized, null);
  const missing = analyzeFundingWindow(rows, START + HOUR, START + HOUR + BAR);
  assert.equal(missing.missingHours, 1); assert.equal(missing.shortCumulative, null);
  assert.throws(() => analyzeFundingWindow(rows, START, START));
});

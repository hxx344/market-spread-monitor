import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultQualityBudget, evaluateOpportunityQuality, parseQualityBudget, qualityPairKey } from '../lib/perpetual-quality.ts';
import { createQualityHistory, QUALITY_SAMPLE_MS, QUALITY_PRICE_WINDOW_MS, QUALITY_FUNDING_WINDOW_MS } from '../server/perpetual-quality-history.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';

const NOW = Math.floor(1_790_000_000_000 / 300_000) * 300_000;
const quote = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: NOW + 3_600_000, sourceTime: NOW, receivedAt: NOW, transport: 'ws', bidAskAt: NOW, markAt: NOW, fundingAt: NOW, ...patch });
const venue = id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: NOW, error: null });
const snapshot = (quotes, now = NOW) => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000, exchanges: [...new Set(quotes.map(item => item.exchange))].map(venue), quotes });
const pair = (patch = {}) => ({ base: 'BTC', long: quote('a'), short: quote('b', { bid: 101, ask: 102 }), buyPrice: 100, sellPrice: 101, spreadPercent: 1, fundingSpread8h: 0.0001, updatedAt: NOW, crossCurrency: false, ...patch });
const stats = (patch = {}) => ({ samples: 60, expectedSamples: 60, coverage: 1, firstAt: NOW - 59 * 60_000, lastAt: NOW, mean: 1, stddev: 0, positiveRatio: 1, signChanges: 0, ...patch });
const ratio = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', longRatio: 0.5, shortRatio: 0.5, kind: 'accounts', scope: 'all', source: 'official', observedAt: NOW, ...patch });
function report(row = pair()) {
  return {
    schemaVersion: 1, generatedAt: NOW, sampleIntervalMs: 60_000, priceWindowMs: 3_600_000, fundingWindowMs: 86_400_000,
    assets: { BTC: { coinId: 'bitcoin', name: 'Bitcoin', marketCapUsd: 10e9, fdvUsd: 10e9, circulatingSupply: 10, totalSupply: 10, maxSupply: null, updatedAt: NOW, source: 'coingecko' } },
    assetErrors: {}, positioning: { 'a:BTCUSDT': ratio('a'), 'b:BTCUSDT': ratio('b') }, positioningErrors: {},
    pairs: { [qualityPairKey(row)]: { base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, spread: stats(), funding: stats({ samples: 288, expectedSamples: 288, firstAt: NOW - 287 * 300_000, mean: 0.01, longStddev: 0, shortStddev: 0 }) } },
  };
}
const dimension = (result, id) => result.dimensions.find(item => item.id === id).score;
const historyRow = (spread, long = 0.01, short = 0.02, patch = {}) => [patch.base ?? 'BTC', patch.longKey ?? 'a:BTCUSDT', patch.shortKey ?? 'b:BTCUSDT', patch.identity ?? 'same-contract', spread, long, short];
const readPair = (history, now = NOW) => history.get('BTC', 'a:BTCUSDT', 'b:BTCUSDT', now);
function livePair(now, longPatch = {}, shortPatch = {}) {
  const time = { bidAskAt: now, fundingAt: now, receivedAt: now, sourceTime: now };
  return snapshot([quote('a', { ...time, ...longPatch }), quote('b', { bid: 101, ask: 102, ...time, ...shortPatch })], now);
}

test('quality separates market size from market-cap to FDV ratio without assuming maximum supply', () => {
  const row = pair(), data = report(row);
  const complete = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(complete.grade, 'strong');
  assert.equal(complete.score, 100);
  assert.equal(complete.coverage, 100);
  for (const [cap, expected] of [[10e9, 100], [1e9, 80], [100e6, 60], [10e6, 35], [1e6, 10]]) {
    data.assets.BTC.marketCapUsd = cap;
    data.assets.BTC.fdvUsd = cap * 10;
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'marketCap'), expected);
    assert.equal(dimension(result, 'fdv'), 10);
  }
  data.assets.BTC.fdvUsd = null;
  data.assets.BTC.maxSupply = 1_000_000;
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'fdv'), null);
  data.assets.BTC.fdvUsd = data.assets.BTC.marketCapUsd * 0.5;
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'fdv'), null, 'Inconsistent provider values must not award maximum dilution points');
});

test('quality crowding uses the proposed long and short directions and does not mix accounts with positions', () => {
  const row = pair(), data = report(row);
  data.positioning['a:BTCUSDT'] = ratio('a', { longRatio: 0.9, shortRatio: 0.1 });
  data.positioning['b:BTCUSDT'] = ratio('b', { longRatio: 0.1, shortRatio: 0.9 });
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'positioning'), 20);
  const reversed = pair({ long: row.short, short: row.long });
  assert.equal(dimension(evaluateOpportunityQuality(reversed, data, NOW), 'positioning'), 100);
  data.positioning['b:BTCUSDT'].kind = 'positions';
  const mixed = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(mixed, 'positioning'), null);
  assert.equal(mixed.coverage, 85);
  assert.notEqual(mixed.grade, 'strong');
});

test('quality leaves missing, stale and malformed evidence unscored rather than treating it as zero risk', () => {
  const row = pair();
  for (const changed of [
    data => { data.assets.BTC.updatedAt = NOW - 3_600_001; },
    data => { data.assets.BTC.updatedAt = NOW + 5001; },
    data => { delete data.assets.BTC; },
    data => { data.assets.BTC.marketCapUsd = 0; data.assets.BTC.fdvUsd = 0; },
  ]) {
    const data = report(row); changed(data);
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'marketCap'), null);
    assert.equal(dimension(result, 'fdv'), null);
    assert.notEqual(result.grade, 'strong');
  }
  for (const patch of [{ observedAt: NOW - 900_001 }, { observedAt: NOW + 5001 }, { longRatio: 0.9, shortRatio: 0.9 }, { longRatio: NaN }, { shortRatio: -0.1 }]) {
    const data = report(row); Object.assign(data.positioning['a:BTCUSDT'], patch);
    assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'positioning'), null);
  }
  const stale = report(row); stale.generatedAt = NOW - 180_001;
  const result = evaluateOpportunityQuality(row, stale, NOW);
  assert.equal(result.coverage, 0);
  assert.equal(result.score, null);
  assert.ok(result.dimensions.every(item => item.score === null));
});

test('quality does not score insufficient or expired history and limits grades on partial coverage', () => {
  const row = pair(), key = qualityPairKey(row);
  for (const patch of [{ samples: 29 }, { coverage: 0.49 }, { lastAt: NOW - 180_001 }]) {
    const data = report(row); Object.assign(data.pairs[key].spread, patch);
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'spread'), null);
    assert.equal(result.score, null);
    assert.equal(result.grade, 'insufficient');
  }
  for (const patch of [{ samples: 11 }, { coverage: 0 }, { lastAt: NOW - 600_001 }, { longStddev: null }]) {
    const data = report(row); Object.assign(data.pairs[key].funding, patch);
    assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'funding'), null);
  }
  const limited = report(row);
  Object.assign(limited.pairs[key].funding, { samples: 12, coverage: 12 / 288 });
  const result = evaluateOpportunityQuality(row, limited, NOW);
  assert.equal(dimension(result, 'funding'), 100);
  assert.equal(result.grade, 'watch', 'One hour of funding samples cannot establish twelve-hour quality');
  delete limited.assets.BTC;
  delete limited.positioning['b:BTCUSDT'];
  const sparse = evaluateOpportunityQuality(row, limited, NOW);
  assert.equal(sparse.coverage, 50);
  assert.equal(sparse.score, null);
});

test('quality never gives a constant negative spread a high stability score', () => {
  const row = pair(), data = report(row), history = createQualityHistory();
  for (let index = 29; index >= 0; index--) history.ingest(NOW - index * 60_000, [historyRow(-0.5)], NOW);
  data.pairs[qualityPairKey(row)].spread = readPair(history).spread;
  const result = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(result, 'spread'), 0);
  assert.notEqual(result.grade, 'strong');
});

test('quality funding stability measures both legs even when their changes cancel in the funding difference', () => {
  const row = pair(), data = report(row), history = createQualityHistory();
  for (let index = 143; index >= 0; index--) {
    const rate = index % 2 ? -0.2 : 0.2;
    history.ingest(NOW - index * 300_000, [historyRow(null, rate, rate)], NOW);
  }
  const funding = readPair(history).funding;
  assert.equal(funding.stddev, 0);
  assert.ok(funding.longStddev > 0.19 && funding.shortStddev > 0.19);
  assert.equal(funding.coverage, 0.5);
  data.pairs[qualityPairKey(row)].funding = funding;
  assert.ok(dimension(evaluateOpportunityQuality(row, data, NOW), 'funding') <= 21);
});

test('quality keeps mark mode, cross-currency prices and stale current quotes as reference only', () => {
  const row = pair(), data = report(row);
  for (const [candidate, mode] of [[row, 'mark'], [pair({ crossCurrency: true }), 'book'], [pair({ updatedAt: NOW - 30_001 }), 'book']]) {
    const result = evaluateOpportunityQuality(candidate, data, NOW, defaultQualityBudget, mode);
    assert.equal(result.grade, 'reference');
    assert.equal(result.score, null);
    assert.equal(result.netSpreadPercent, null);
  }
});

test('quality cost budgets remain an auxiliary calculation and notices or adverse carry constrain the grade', () => {
  const row = pair(), data = report(row);
  const cost = evaluateOpportunityQuality(row, data, NOW, { feePercent: 0.6, slippagePercent: 0.5 });
  assert.equal(cost.score, 100, 'Cost settings do not rewrite the fundamental and historical evidence');
  assert.ok(Math.abs(cost.netSpreadPercent + 0.1) < 1e-10);
  assert.equal(cost.grade, 'weak');
  const delisting = pair({ long: quote('a', { delisting: true, delistingAt: null }) });
  assert.equal(evaluateOpportunityQuality(delisting, data, NOW).grade, 'weak');
  data.pairs[qualityPairKey(row)].funding.mean = -1;
  assert.equal(evaluateOpportunityQuality(row, data, NOW).grade, 'weak');
});

test('quality parses versioned cost preferences without coercing invalid values or replacing valid zero budgets', () => {
  for (const input of [null, '', '{broken', JSON.stringify({ version: 2, feePercent: 0 })]) assert.deepEqual(parseQualityBudget(input), defaultQualityBudget);
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: 0, slippagePercent: 0 })), { feePercent: 0, slippagePercent: 0 });
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: '0.1', slippagePercent: -1 })), defaultQualityBudget);
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: 10.1, slippagePercent: 0.3 })), { feePercent: 0.24, slippagePercent: 0.3 });
});

test('quality history samples a minute once and leaves offline gaps empty', () => {
  const history = createQualityHistory();
  assert.ok(history.sample(livePair(NOW), NOW));
  assert.equal(history.sample(livePair(NOW + 30_000), NOW + 30_000), null);
  history.sample(livePair(NOW + 600_000), NOW + 600_000);
  const values = readPair(history, NOW + 600_000);
  assert.equal(values.spread.samples, 2);
  assert.equal(values.funding.samples, 2);
  assert.equal(values.spread.coverage, 2 / 60);
  assert.equal(values.spread.firstAt, NOW);
  assert.equal(values.spread.lastAt, NOW + 600_000);
});

test('quality history rejects stale or incomplete books and preserves missing funding rather than filling zero', () => {
  const history = createQualityHistory();
  history.sample(livePair(NOW), NOW);
  history.sample(livePair(NOW + 60_000, { bidAskAt: NOW }, { bidAskAt: NOW }), NOW + 60_000);
  history.sample(livePair(NOW + 300_000, { fundingRate: null }), NOW + 300_000);
  const values = readPair(history, NOW + 300_000);
  assert.equal(values.spread.samples, 2);
  assert.equal(values.funding.samples, 1);
});

test('quality history normalizes each funding interval and retains true zero and negative rates', () => {
  const history = createQualityHistory();
  history.sample(livePair(NOW, { fundingRate: -0.0001, fundingIntervalHours: 1 }, { fundingRate: 0, fundingIntervalHours: 4 }), NOW);
  const values = readPair(history);
  assert.ok(Math.abs(values.funding.mean - 0.08) < 1e-10);
  assert.equal(values.funding.positiveRatio, 1);
  assert.equal(values.funding.longStddev, 0);
});

test('quality history keeps venue combinations and trading directions separate when the best pair changes', () => {
  const history = createQualityHistory();
  history.sample(snapshot([quote('a'), quote('b', { bid: 101, ask: 102 }), quote('c', { bid: 103, ask: 104 })]), NOW);
  const next = NOW + 60_000;
  history.sample(snapshot([
    quote('a', { bidAskAt: next, receivedAt: next }),
    quote('b', { bid: 101, ask: 102, bidAskAt: next, receivedAt: next }),
    quote('c', { bid: 99, ask: 100, bidAskAt: next, receivedAt: next }),
  ], next), next);
  assert.equal(history.get('BTC', 'a:BTCUSDT', 'c:BTCUSDT', next).spread.samples, 2);
  assert.equal(history.get('BTC', 'a:BTCUSDT', 'b:BTCUSDT', next).spread.samples, 1);
  assert.equal(history.get('BTC', 'b:BTCUSDT', 'a:BTCUSDT', next).spread.samples, 0);
  const forward = qualityPairKey(pair()), reverse = qualityPairKey(pair({ long: quote('b'), short: quote('a') }));
  assert.notEqual(forward, reverse);
});

test('quality history resets changed units, multipliers, collateral and quote currencies without carrying old samples', () => {
  for (const patch of [{ contractUnit: 'new unit' }, { multiplier: 1000 }, { quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' }]) {
    const history = createQualityHistory();
    history.sample(livePair(NOW), NOW);
    const next = NOW + 60_000;
    history.sample(livePair(next, patch, patch), next);
    const values = readPair(history, next);
    assert.equal(values.spread.samples, 1);
    assert.equal(values.spread.firstAt, next);
    assert.equal(values.funding.samples, 0);
  }
  const history = createQualityHistory();
  history.sample(livePair(NOW), NOW);
  history.sample(livePair(NOW + 60_000, { comparable: false }), NOW + 60_000);
  assert.equal(readPair(history, NOW + 60_000).spread.samples, 0);
  const changedBase = createQualityHistory();
  changedBase.sample(livePair(NOW), NOW);
  changedBase.sample(livePair(NOW + 60_000, { base: 'OTHER' }, { base: 'OTHER' }), NOW + 60_000);
  assert.equal(readPair(changedBase, NOW + 60_000).spread.samples, 0);
  assert.equal(changedBase.get('OTHER', 'a:BTCUSDT', 'b:BTCUSDT', NOW + 60_000).spread.samples, 1);
});

test('quality history rolls one-hour prices and twenty-four-hour funding windows at their exact boundaries', () => {
  const history = createQualityHistory();
  for (let index = 1440; index >= 0; index--) history.ingest(NOW - index * QUALITY_SAMPLE_MS, [historyRow(1)], NOW);
  const values = readPair(history);
  assert.equal(values.spread.samples, 60);
  assert.equal(values.spread.firstAt, NOW - QUALITY_PRICE_WINDOW_MS + QUALITY_SAMPLE_MS);
  assert.equal(values.funding.samples, 288);
  assert.equal(values.funding.firstAt, NOW - QUALITY_FUNDING_WINDOW_MS + 300_000);
  assert.deepEqual(history.metrics(), { trackedPairs: 1, pricePoints: 60, fundingPoints: 288 });
  const expired = readPair(history, NOW + QUALITY_FUNDING_WINDOW_MS);
  assert.equal(expired.spread.samples, 0);
  assert.equal(expired.funding.samples, 0);
});

test('quality history ignores duplicate, future and unaligned persisted samples', () => {
  const history = createQualityHistory();
  history.ingest(NOW, [historyRow(1)], NOW);
  history.ingest(NOW, [historyRow(99)], NOW);
  history.ingest(NOW + 1, [historyRow(99)], NOW + 1);
  history.ingest(NOW + QUALITY_SAMPLE_MS, [historyRow(99)], NOW);
  assert.equal(readPair(history).spread.samples, 1);
  assert.equal(readPair(history).spread.mean, 1);
});

test('quality history enforces the default thousand-pair cap and keeps retained rings bounded', () => {
  const history = createQualityHistory();
  const rows = Array.from({ length: 1000 }, (_, index) => historyRow(1, 0.01, 0.02, { base: `COIN${index}`, longKey: `a:C${index}`, shortKey: `b:C${index}` }));
  history.ingest(NOW, rows, NOW);
  history.ingest(NOW + 60_000, [historyRow(1, 0.01, 0.02, { base: 'EXTRA', longKey: 'a:EXTRA', shortKey: 'b:EXTRA' })], NOW + 60_000);
  assert.equal(history.metrics().trackedPairs, 1000);
  assert.equal(history.get('EXTRA', 'a:EXTRA', 'b:EXTRA', NOW + 60_000).spread.samples, 1);
  assert.equal(history.get('COIN0', 'a:C0', 'b:C0', NOW + 60_000).spread.samples, 0);
});

test('quality samples survive restart, prune beyond a day and retain corrupt buckets as gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-quality-'));
  let store, db;
  try {
    const filename = join(directory, 'quotes.sqlite');
    store = await openPerpetualStore(filename);
    for (let index = 1440; index >= 0; index--) store.saveQualitySample(NOW - index * 60_000, [historyRow(0.5)]);
    store.saveQualitySample(NOW, [historyRow(999)]);
    store.close(); store = undefined;
    db = new DatabaseSync(filename);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quality_samples').get().count, 1440);
    db.prepare('UPDATE quality_samples SET payload=? WHERE bucket=?').run(Buffer.from('corrupt'), NOW - 60_000);
    db.close(); db = undefined;
    store = await openPerpetualStore(filename);
    const history = createQualityHistory();
    let buckets = 0;
    for (const sample of store.loadQualitySamples(NOW)) { buckets++; history.ingest(sample.bucket, sample.rows, NOW); }
    assert.equal(buckets, 1439);
    const values = readPair(history);
    assert.equal(values.spread.samples, 59);
    assert.equal(values.spread.mean, 0.5, 'A duplicate write cannot replace the original observed minute');
    assert.equal(values.funding.samples, 288);
    assert.deepEqual([...store.loadQualitySamples(NOW + QUALITY_FUNDING_WINDOW_MS)], []);
  } finally {
    db?.close(); store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-quality-'));
    await rm(directory, { recursive: true, force: true });
  }
});

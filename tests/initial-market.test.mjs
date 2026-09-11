import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { readInitialMarket, registerInitialMarket } from '../server/initial-market.mjs';
import { readInitialMarket as readServerInitialMarket } from '../lib/server-initial-market.ts';
import { initialSummaries } from '../lib/initial-market.ts';

test('first render reads persisted history immediately with collection stopped and preserves missing quotes and source dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'market-initial-test-'));
  let services;
  try {
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
    const before = services.market.status();
    const data = await readInitialMarket(services);
    assert.equal(data.hynix.quote, null, 'Do not disguise a candle close as a current quote');
    assert.ok(data.hynix.history.points.length > 1000);
    assert.equal(data.oil.quote.status, 'snapshot');
    assert.equal(data.oil.quote.collection.source, 'database');
    assert.deepEqual(services.market.status(), before, 'First render must not collect or write');
    const summaries = initialSummaries(data);
    assert.equal(summaries.oil.status, 'stale');
    assert.equal(summaries.oil.fetchedAt, data.oil.quote.fetchedAt);
    assert.notEqual(summaries.oil.metrics[0].value, '—');
    assert.equal(summaries.hynix.metrics[0].value, '—');
    assert.equal(summaries.hynix.trend.points.length, 168);
    assert.equal(summaries.oil.trend.points.length, 30);
  } finally { if (services) { await services.market.stop(); await services.notifications.stop(); } await rm(directory, { recursive: true, force: true }); }
});

test('a missing dataset cannot block other first-render data; the server provider is current on every request and releases cleanly', async () => {
  let revision = 0;
  const calls = [];
  const services = new Map(['hynix', 'oil'].map(id => [id, { async handle(action, method) {
    calls.push([id, action, method]);
    if (id === 'hynix' && action === 'quote') throw new Error('No quote yet');
    return { revision };
  } }]));
  assert.equal(await readServerInitialMarket(), null);
  const release = registerInitialMarket(services);
  try {
    assert.throws(() => registerInitialMarket(services));
    const first = await readServerInitialMarket();
    assert.equal(first.hynix.quote, null);
    assert.equal(first.oil.quote.revision, 0);
    revision++;
    assert.equal((await readServerInitialMarket()).oil.quote.revision, 1);
    assert.equal(calls.length, 8);
    assert.ok(calls.every(([, action, method]) => ['quote', 'history'].includes(action) && method === 'GET'));
  } finally { release(); }
  assert.equal(await readServerInitialMarket(), null, 'A stopped runtime cannot leak its provider into another instance');
});

test('first-render summaries retain valid zero quotes and stale status without changing the funding basis', () => {
  const fetchedAt = '2026-09-11T16:00:00Z';
  const leg = { markPx: 100, oraclePx: 100, funding: 0 };
  const summaries = initialSummaries({ renderedAt: Date.parse(fetchedAt), hynix: { quote: { fetchedAt, status: 'snapshot', adr: 20, ordinary: 200, equivalent: 20, spread: 0, premium: 0 }, history: null }, oil: { quote: { fetchedAt, status: 'live', brent: leg, wti: leg }, history: null } });
  assert.equal(summaries.hynix.metrics[0].value, '0.00%');
  assert.equal(summaries.hynix.status, 'stale');
  assert.equal(summaries.oil.metrics[0].value, '0.000');
  assert.equal(summaries.oil.metrics[1].value, '0.00%');
  assert.match(summaries.oil.note, /等桶数/);
});

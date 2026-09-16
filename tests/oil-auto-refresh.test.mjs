import test from 'node:test';
import assert from 'node:assert/strict';
import { startOilAutoRefresh } from '../modules/oil/auto-refresh.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const targets = () => ({ page: Object.assign(new EventTarget(), { hidden: false }), view: new EventTarget() });

test('oil history polls every minute even when server timestamps are ahead; funding keeps a five-minute cadence', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.UTC(2026, 8, 17) });
  const calls = [], target = targets(); let funding = 0;
  const stop = startOilAutoRefresh({ ...target, prices: async () => { calls.push(Date.now()); return { fetchedAt: new Date(Date.now() + 8 * 3600_000).toISOString() }; }, funding: async () => funding++ });
  t.after(stop);
  await flush(); assert.equal(calls.length, 0, 'Hydrated history is not fetched twice at startup');
  for (let minute = 1; minute <= 5; minute++) { t.mock.timers.tick(60_000); await flush(); assert.equal(calls.length, minute); }
  assert.equal(funding, 1);
});

test('returning to a visible page refreshes both datasets immediately and hidden pages do not poll', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const target = targets(); let prices = 0, funding = 0;
  const stop = startOilAutoRefresh({ ...target, prices: async () => prices++, funding: async () => funding++ });
  t.after(stop);
  target.page.hidden = true; target.page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(300_000); await flush();
  assert.deepEqual([prices, funding], [0, 0]);
  target.page.hidden = false; target.page.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.deepEqual([prices, funding], [1, 1]);
  t.mock.timers.tick(60_000); await flush(); assert.equal(prices, 2);
});

test('network and back-forward restoration resume once without overlapping an in-flight update', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const target = targets(); let prices = 0, funding = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const stop = startOilAutoRefresh({ ...target, prices: async () => { prices++; await gate; }, funding: async () => { funding++; await gate; } });
  t.after(stop);
  target.view.dispatchEvent(new Event('pageshow')); await flush(); assert.equal(prices, 0);
  target.view.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); await flush();
  target.view.dispatchEvent(new Event('online')); t.mock.timers.tick(300_000); await flush();
  assert.deepEqual([prices, funding], [1, 1]);
  release(); await flush();
  target.view.dispatchEvent(new Event('online')); await flush();
  assert.deepEqual([prices, funding], [2, 2]);
});

test('a failed price refresh does not stop subsequent polls or the funding schedule', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0, funding = 0, failures = 0;
  const stop = startOilAutoRefresh({ ...targets(), prices: async () => { if (++calls === 1) throw Error('offline'); }, funding: async () => funding++, onError: () => failures++ });
  t.after(stop);
  t.mock.timers.tick(60_000); await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(calls, 2); assert.equal(failures, 1);
  t.mock.timers.tick(180_000); await flush(); assert.equal(funding, 1);
});

test('disposing a panel removes its timers and restoration listeners, including queued refreshes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const target = targets(); let calls = 0;
  const stop = startOilAutoRefresh({ ...target, prices: async () => calls++, funding: async () => calls++ });
  target.view.dispatchEvent(new Event('online')); stop(); await flush();
  t.mock.timers.tick(600_000);
  target.page.dispatchEvent(new Event('visibilitychange')); target.view.dispatchEvent(new Event('online'));
  target.view.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); await flush();
  assert.equal(calls, 0);
});

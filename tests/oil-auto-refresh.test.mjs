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

test('inactive oil panels pause all reads and resume immediately without replacing their mounted state', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const target = targets(); let prices = 0, funding = 0;
  const stop = startOilAutoRefresh({ ...target, active: false, prices: async () => prices++, funding: async () => funding++ });
  t.after(stop);
  t.mock.timers.tick(600000); target.view.dispatchEvent(new Event('online')); await flush(); assert.deepEqual([prices, funding], [0, 0]);
  stop.setActive(true); await flush(); assert.deepEqual([prices, funding], [1, 1]);
  stop.setActive(false); t.mock.timers.tick(600000); await flush(); assert.deepEqual([prices, funding], [1, 1]);
  stop.setActive(true); await flush(); assert.deepEqual([prices, funding], [2, 2]);
});

test('pausing oil refresh aborts in-flight requests and does not report cancellation as market failure', async t => {
  const target = targets(); let signal, failures = 0;
  const stop = startOilAutoRefresh({ ...target, prices: input => { signal = input; return new Promise((_resolve, reject) => input.addEventListener('abort', () => reject(input.reason), { once: true })); }, funding: async () => {}, onError: () => failures++ });
  t.after(stop); target.view.dispatchEvent(new Event('online')); await flush();
  stop.setActive(false); assert.equal(signal.aborted, true); await flush(); assert.equal(failures, 0);
});

test('the visible oil overview refreshes quotes while hidden history and funding stay idle', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = { quote: 0, history: 0, funding: 0 };
  const stop = startOilAutoRefresh({ ...targets(), active: false, summaryActive: true,
    quote: async () => calls.quote++, prices: async () => calls.history++, funding: async () => calls.funding++ });
  t.after(stop);
  await stop.refreshQuote();
  for (let cycle = 0; cycle < 6; cycle++) { t.mock.timers.tick(10_000); await flush(); }
  assert.deepEqual(calls, { quote: 7, history: 0, funding: 0 });
  stop.setActive(true); await flush();
  assert.deepEqual(calls, { quote: 7, history: 1, funding: 1 }, 'Opening detail does not create a second quote request');
  stop.setActive(false); t.mock.timers.tick(10_000); await flush();
  assert.deepEqual(calls, { quote: 8, history: 1, funding: 1 });
});

test('quote polling pauses with the host, visibility and network then resumes exactly once', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const target = targets(); target.view.navigator = { onLine: true };
  let quotes = 0, histories = 0;
  const stop = startOilAutoRefresh({ ...target, active: false, summaryActive: true,
    quote: async () => quotes++, prices: async () => histories++, funding: async () => {} });
  t.after(stop);
  await stop.refreshQuote(); assert.equal(quotes, 1);
  target.page.hidden = true; target.page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60_000); await flush(); assert.equal(quotes, 1);
  target.page.hidden = false; target.page.dispatchEvent(new Event('visibilitychange'));
  await flush(); assert.equal(quotes, 2);
  target.view.navigator.onLine = false; target.view.dispatchEvent(new Event('offline'));
  t.mock.timers.tick(60_000); await flush(); assert.equal(quotes, 2);
  target.view.navigator.onLine = true; target.view.dispatchEvent(new Event('online'));
  await flush(); assert.equal(quotes, 3, 'Online listeners share one in-flight refresh');
  stop.setSummaryActive(false); t.mock.timers.tick(60_000); await flush(); assert.equal(quotes, 3);
  stop.setSummaryActive(true); await flush(); assert.equal(quotes, 4);
  assert.equal(histories, 0);
});

test('a stalled quote times out independently while history succeeds and quote polling recovers', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let quotes = 0, histories = 0;
  const errors = [];
  const stop = startOilAutoRefresh({ ...targets(), active: true, summaryActive: true,
    quote: () => ++quotes === 1 ? new Promise(() => {}) : Promise.resolve(),
    prices: async () => histories++, funding: async () => {},
    onQuoteError: error => errors.push(error.name), onError: error => { throw error; } });
  t.after(stop);
  void stop.refreshQuote(); await flush();
  await stop.refreshHistory(); assert.equal(histories, 1);
  t.mock.timers.tick(15_000); await flush();
  assert.deepEqual(errors, ['TimeoutError']);
  t.mock.timers.tick(5_000); await flush(); assert.equal(quotes, 2);
});

test('manual and scheduled quote refreshes share one request and history errors stay separate', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let quotes = 0, release;
  const errors = [];
  const stop = startOilAutoRefresh({ ...targets(), quote: () => { quotes++; return new Promise(resolve => { release = resolve; }); },
    prices: async () => { throw Error('history unavailable'); }, funding: async () => {},
    onQuoteError: () => errors.push('quote'), onHistoryError: () => errors.push('history') });
  t.after(stop);
  void stop.refreshQuote(); await flush();
  void stop.refresh(); t.mock.timers.tick(10_000); await flush();
  assert.equal(quotes, 1); assert.deepEqual(errors, ['history']);
  release(); await flush();
  t.mock.timers.tick(10_000); await flush(); assert.equal(quotes, 2);
});

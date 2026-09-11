import { loadQuote } from '../lib/quote-service.ts';
import { loadMarket, getMarketSnapshot } from '../lib/market-service.ts';
import { fetchHynixFundingSnapshot } from '../lib/hynix-funding-history.ts';
import { fetchMarket, fetchSnapshot } from '../modules/oil/hyperliquid.mjs';
import { fetchFundingSnapshot } from '../modules/oil/funding-history.mjs';
import oilArchive from '../public/oil/data/hyperliquid-2026.json' with { type: 'json' };
import oilFundingArchive from '../public/oil/data/hyperliquid-funding-2026.json' with { type: 'json' };
import hynixFundingArchive from '../data/hynix-funding.json' with { type: 'json' };

export function seedMarketDatabase(store) {
  store.write('hynix', 'history', getMarketSnapshot(), { seed: true });
  store.write('hynix', 'funding', hynixFundingArchive, { seed: true });
  store.write('oil', 'quote', oilArchive.market, { seed: true });
  store.write('oil', 'history', oilArchive, { seed: true });
  store.write('oil', 'funding', oilFundingArchive, { seed: true });
}

export function marketJobs({ oilIntervalMs = 30_000 } = {}) {
  return [
    { id: 'hynix', action: 'quote', intervalMs: 10_000, load: () => loadQuote() },
    { id: 'oil', action: 'quote', intervalMs: oilIntervalMs, load: () => fetchMarket() },
    { id: 'hynix', action: 'history', intervalMs: 60_000, load: previous => loadMarket(fetch, Date.now(), previous ?? getMarketSnapshot()) },
    { id: 'oil', action: 'history', intervalMs: 300_000, async load(previous) {
      const next = await fetchSnapshot();
      const rows = new Map((previous?.data ?? []).map(row => [row.date, row]));
      for (const row of next.data) { const old = rows.get(row.date); rows.set(row.date, { date: row.date, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null }); }
      const data = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
      const paired = data.filter(row => row.brent !== null && row.wti !== null);
      return { ...next, data, metadata: { ...next.metadata, firstCommonObservation: paired[0].date, lastCommonObservation: paired.at(-1).date, pairedObservationRows: paired.length } };
    } },
    { id: 'hynix', action: 'funding', intervalMs: 300_000, load: previous => fetchHynixFundingSnapshot(previous ?? hynixFundingArchive, { signal: AbortSignal.timeout(12_000) }) },
    { id: 'oil', action: 'funding', intervalMs: 300_000, load: previous => fetchFundingSnapshot(previous ?? oilFundingArchive) },
  ];
}

/** Independent resident schedules; slow history never blocks current quotes. */
export function createMarketCollector(store, { jobs = marketJobs(), clock = Date.now, timers = globalThis, onStored = () => {} } = {}) {
  const pending = new Map(), scheduled = new Map(), storageFailures = new Set();
  let running = false;
  function collect(job) {
    const key = `${job.id}/${job.action}`;
    if (pending.has(key)) return pending.get(key);
    const operation = Promise.resolve().then(async () => {
      let next;
      try {
        next = await job.load(store.raw(job.id, job.action));
        if (next?.status === 'snapshot') throw new Error('Upstream returned a retained snapshot');
      } catch {
        try { store.fail(job.id, job.action, '采集暂时失败，保留上次成功数据；后台将自动重试。'); storageFailures.delete(key); }
        catch { storageFailures.add(key); }
        return false;
      }
      try { store.write(job.id, job.action, next); storageFailures.delete(key); }
      catch (error) {
        if (error.code === 'MARKET_DATA_INVALID') {
          try { store.fail(job.id, job.action, '本轮行情不完整或时间无效，保留上次成功数据。'); storageFailures.delete(key); return false; }
          catch { /* A failed status write is a database failure. */ }
        }
        storageFailures.add(key);
        return false;
      }
      // Alerts consume the committed quote promptly, without delaying collection.
      void Promise.resolve().then(() => onStored(job)).catch(() => {});
      return true;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }
  return {
    collect,
    healthy: () => storageFailures.size === 0,
    start() {
      if (running) return;
      running = true;
      for (const job of jobs) {
        const tick = async () => {
          const started = clock();
          await collect(job);
          if (running) scheduled.set(job, timers.setTimeout(tick, Math.max(1000, job.intervalMs - (clock() - started))));
        };
        void tick();
      }
    },
    async stop() { running = false; for (const timer of scheduled.values()) timers.clearTimeout(timer); scheduled.clear(); await Promise.all(pending.values()); },
  };
}

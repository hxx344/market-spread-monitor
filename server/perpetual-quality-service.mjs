import { setImmediate as yieldLoop } from 'node:timers/promises';
import { createFundamentalsClient } from './perpetual-fundamentals.mjs';
import { fetchPositioning } from './perpetual-positioning.mjs';
import { createQualityHistory, QUALITY_SAMPLE_MS, QUALITY_PRICE_WINDOW_MS, QUALITY_FUNDING_WINDOW_MS } from './perpetual-quality-history.mjs';

const pairKey = row => JSON.stringify([row.base, row.longKey, row.shortKey]);
const qkey = quote => `${quote.exchange}:${quote.symbol}`;
const assetMessages = { pending: '基本面等待查询', unmapped: '未找到对应代币', ambiguous: '同名代币待确认，未猜测匹配', unsupported: '该标的不使用代币市值', missing: '数据源未提供市值 / FDV', stale: '基本面缓存已过期' };
const supported = new Set(['binance', 'bybit', 'okx', 'bitget', 'gate']);

/** Secondary research data: one shared, bounded collector; page requests read cached evidence only. */
export function createPerpetualQualityService({ getSnapshot, store, clock = Date.now, fundamentals = createFundamentalsClient({ clock }), positioningFetch = fetchPositioning } = {}) {
  const history = createQualityHistory(), watches = new Map(), positioning = new Map(), attempts = new Map(), venueRetryAt = new Map();
  let running = false, restoring = false, metadataBusy = false, ratioBusy = false, metadataRetryAt = 0, metadataFailures = 0;
  let historyError = null, metadataError = null, timer, sampleTimer, metadataTimer, restorePromise;
  const controllers = new Set(), pending = new Set();
  const launch = fn => {
    const promise = Promise.resolve().then(fn).catch(() => {}).finally(() => pending.delete(promise));
    pending.add(promise); return promise;
  };
  function watched(now) {
    for (const [id, item] of watches) if (now - item.at > 180_000) watches.delete(id);
    return [...watches.values()].sort((a, b) => b.at - a.at).map(item => item.row);
  }
  function collectSample() {
    if (!running || restoring) return;
    const sample = history.sample(getSnapshot(), clock(), watched(clock()));
    if (sample) {
      try { store?.saveQualitySample?.(sample.bucket, sample.rows); historyError = null; }
      catch { historyError = '质量历史保存失败，当前窗口仅保留在内存'; }
    }
  }
  async function collectFundamentals() {
    if (!running || metadataBusy || clock() < metadataRetryAt) return;
    const bases = [...new Set(getSnapshot().quotes.filter(row => row.comparable !== false && /^[A-Z0-9-]{1,40}$/.test(row.base)).map(row => row.base))];
    if (!bases.length) return;
    metadataBusy = true;
    const controller = new AbortController(); controllers.add(controller);
    try { await fundamentals.refresh(bases, { signal: controller.signal }); metadataFailures = 0; metadataRetryAt = 0; metadataError = null; }
    catch (error) {
      metadataFailures++;
      const hint = error?.retryAfter;
      const delay = hint && Number.isFinite(Number(hint)) ? Number(hint) * 1000 : hint ? Date.parse(hint) - clock() : 0;
      metadataRetryAt = clock() + Math.max(Number.isFinite(delay) ? Math.min(3_600_000, Math.max(0, delay)) : 0, Math.min(1_800_000, 60_000 * 2 ** Math.min(metadataFailures, 5)));
      metadataError = '基本面数据源暂不可用，保留原时间，稍后重试';
    }
    finally { metadataBusy = false; controllers.delete(controller); }
  }
  async function collectPositioning() {
    if (!running || ratioBusy) return;
    const now = clock(), keys = new Set(watched(now).flatMap(row => [row.longKey, row.shortKey]));
    const ready = [...keys].filter(key => supported.has(key.split(':')[0]) && now >= (attempts.get(key)?.retryAt ?? 0) && now >= (venueRetryAt.get(key.split(':')[0]) ?? 0));
    if (!ready.length) return;
    // Rotate the least recently attempted first. Missing/failed symbols cannot starve other rows.
    const byKey = new Map(getSnapshot().quotes.map(quote => [qkey(quote), quote]));
    const candidates = ready.filter(key => supported.has(byKey.get(key)?.exchange))
      .sort((a, b) => (attempts.get(a)?.at ?? 0) - (attempts.get(b)?.at ?? 0));
    const key = candidates[0];
    if (!key) return;
    ratioBusy = true;
    const controller = new AbortController(); controllers.add(controller);
    const previous = attempts.get(key);
    try {
      const item = await positioningFetch(byKey.get(key), { signal: controller.signal, now });
      if (item) positioning.set(key, item);
      attempts.set(key, { at: now, retryAt: clock() + 300_000, failures: 0, error: item ? null : '该合约暂无公开多空数据' });
    } catch (error) {
      const failures = (previous?.failures ?? 0) + 1;
      const retryAfter = Number.isFinite(error?.retryAfterMs) ? Math.min(3_600_000, Math.max(0, error.retryAfterMs)) : 0;
      const backoff = Math.max(300_000, retryAfter, Math.min(1_800_000, 60_000 * 2 ** Math.min(failures, 5)));
      if (error?.status === 429) venueRetryAt.set(byKey.get(key).exchange, clock() + backoff);
      attempts.set(key, { at: now, retryAt: clock() + backoff, failures, error: error?.status === 429 ? '多空接口限流，等待重试' : '多空接口暂不可用' });
    } finally {
      ratioBusy = false; controllers.delete(controller);
      for (const [id, attempt] of attempts) if (!keys.has(id) && now - attempt.at > 900_000) { attempts.delete(id); positioning.delete(id); }
      // No request or user can turn the cache into an unbounded symbol history.
      while (attempts.size > 200) { const id = [...attempts].sort((a, b) => a[1].at - b[1].at)[0][0]; attempts.delete(id); positioning.delete(id); }
    }
  }
  function read(input) {
    if (!input || !Array.isArray(input.pairs) || input.pairs.length > 30) throw new Error('每次最多评估30个平台组合');
    const snapshot = getSnapshot(), byKey = new Map(snapshot.quotes.map(row => [qkey(row), row])), now = clock();
    const pairs = {}, assets = {}, assetErrors = {}, ratios = {}, positioningErrors = {};
    for (const row of input.pairs) {
      if (!row || ['base', 'longKey', 'shortKey'].some(key => typeof row[key] !== 'string' || row[key].length > 160)) throw new Error('平台组合格式无效');
      const long = byKey.get(row.longKey), short = byKey.get(row.shortKey);
      if (!long || !short || long.base !== row.base || short.base !== row.base || long.exchange === short.exchange) continue;
      const id = pairKey(row);
      watches.delete(id); watches.set(id, { row: { base: row.base, longKey: row.longKey, shortKey: row.shortKey }, at: now });
      while (watches.size > 60) watches.delete(watches.keys().next().value);
      pairs[id] = history.get(row.base, row.longKey, row.shortKey, now);
      const asset = fundamentals.get(row.base);
      if (asset) assets[row.base] = asset;
      else assetErrors[row.base] = assetMessages[fundamentals.describe(row.base).status] || '基本面尚未就绪';
      for (const quote of [long, short]) {
        const key = qkey(quote), ratio = positioning.get(key);
        if (ratio) ratios[key] = ratio;
        if (!supported.has(quote.exchange)) positioningErrors[key] = '该平台暂无接入的官方多空比';
        else if (attempts.get(key)?.error) positioningErrors[key] = attempts.get(key).error;
        else if (!ratio) positioningErrors[key] = '等待后台采集官方多空比';
      }
    }
    return { schemaVersion: 1, generatedAt: now, sampleIntervalMs: QUALITY_SAMPLE_MS, priceWindowMs: QUALITY_PRICE_WINDOW_MS, fundingWindowMs: QUALITY_FUNDING_WINDOW_MS,
      pairs, assets, assetErrors, positioning: ratios, positioningErrors, error: historyError || metadataError };
  }
  return {
    read,
    start() {
      if (running) return;
      running = true; restoring = true;
      restorePromise = launch(async () => {
        try {
          let count = 0;
          for (const sample of store?.loadQualitySamples?.(clock()) ?? []) {
            if (!running) break;
            history.ingest(sample.bucket, sample.rows, clock());
            if (++count % 8 === 0) await yieldLoop();
          }
        } catch { historyError = '质量历史恢复失败，将重新积累样本'; }
        finally { restoring = false; if (running) collectSample(); }
      });
      sampleTimer = setInterval(collectSample, QUALITY_SAMPLE_MS);
      // Cache TTL decides which assets need network access; unseen quotes appear after startup discovery.
      metadataTimer = setInterval(() => { void launch(collectFundamentals); }, 60_000);
      timer = setInterval(() => { void launch(collectPositioning); }, 1000);
      for (const task of [sampleTimer, metadataTimer, timer]) task.unref?.();
      void launch(collectFundamentals);
    },
    async stop() {
      running = false;
      for (const task of [sampleTimer, metadataTimer, timer]) clearInterval(task);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending, restorePromise].filter(Boolean));
    },
    // Testable collector operations also power the timers; no alternate implementation.
    collectSample, collectFundamentals, collectPositioning,
    metrics: () => ({ ...history.metrics(), watchedPairs: watches.size, positioningCache: positioning.size, restoring, metadataRetryAt, error: historyError || metadataError }),
  };
}

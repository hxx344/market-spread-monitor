import type { FundingWindowHours, FundingWindowTotal } from './perpetual-funding-history.ts';
import { isPerpetualMarketMetricsReport } from './perpetual-market-metrics-feed.ts';
import type { PerpetualMarketMetricsLeg } from './perpetual-market-metrics.ts';
import { canonicalScannerDataPair, scannerDataPairKey, scannerDataRequirementsKey, scannerDataSelectionKey,
  type PerpetualScannerDataReport, type ScannerDataPair, type ScannerDataRequest, type ScannerDataRequirements } from './perpetual-scanner-data.ts';

const REFRESH_MS = 300_000, POLL_MS = 3_000, FAILURE_MS = 60_000, NO_PROGRESS_MS = 20 * 60_000;
const HOURS: FundingWindowHours[] = [24, 72, 168, 720];
const emptyRequirements = (): ScannerDataRequirements => ({ metrics: false, historyHours: [] });
const enabled = (requirements: ScannerDataRequirements) => requirements.metrics || requirements.historyHours.length > 0;
const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isPerpetualScannerDataReport(input: unknown): input is PerpetualScannerDataReport {
  if (!object(input) || input.schemaVersion !== 1 || !timestamp(input.generatedAt) || !object(input.history)
    || Object.keys(input.history).length > 30 || (input.storageError !== undefined && typeof input.storageError !== 'string')
    || !isPerpetualMarketMetricsReport({ schemaVersion: 1, generatedAt: input.generatedAt, legs: input.metrics })) return false;
  return Object.entries(input.history).every(([key, windows]) => {
    try {
      const [base, longKey, shortKey, extra] = JSON.parse(key);
      if (extra !== undefined || typeof base !== 'string' || typeof longKey !== 'string' || typeof shortKey !== 'string'
        || key !== scannerDataPairKey({ base, longKey, shortKey }) || !object(windows)) return false;
      return Object.entries(windows).every(([hours, raw]) => {
        if (!HOURS.includes(Number(hours) as FundingWindowHours) || !object(raw) || raw.hours !== Number(hours)
          || !['ready', 'pending', 'partial', 'stale', 'error', 'unsupported'].includes(String(raw.status)) || typeof raw.reason !== 'string'
          || (raw.asOf !== null && !timestamp(raw.asOf)) || !timestamp(raw.longCount) || !timestamp(raw.shortCount)) return false;
        return ['longPercent', 'shortPercent', 'netPercent'].every(field => raw[field] === null || (typeof raw[field] === 'number' && Number.isFinite(raw[field])))
          && (raw.status !== 'ready' || (raw.asOf !== null && raw.longPercent !== null && raw.shortPercent !== null && raw.netPercent !== null));
      });
    } catch { return false; }
  });
}

interface Timed<T> { value?: T; nextReadAt: number; terminal: boolean; receivedAt: number }
interface Entry {
  pair: ScannerDataPair;
  identity: string;
  lastUsed: number;
  metrics?: Timed<Record<string, PerpetualMarketMetricsLeg>>;
  history: Map<FundingWindowHours, Timed<FundingWindowTotal>>;
  deferred: boolean;
}
interface Subscriber {
  options: ScannerDataFeedOptions;
  pairs: Map<string, ScannerDataPair>;
  requirements: ScannerDataRequirements;
  active: boolean;
  delivered: PerpetualScannerDataReport | null;
}
interface BatchItem { identity: string; progressAt: number; fingerprint: string }
interface Batch { items: Map<string, BatchItem>; requirements: ScannerDataRequirements; nextReadAt: number }
interface Demand { entry: Entry; requirements: ScannerDataRequirements }
export interface ScannerDataFeedOptions {
  load: (request: ScannerDataRequest, signal: AbortSignal) => Promise<PerpetualScannerDataReport>;
  onData: (report: PerpetualScannerDataReport) => void;
  onError: (error: string) => void;
  onLoading: (loading: boolean) => void;
  cache?: PerpetualScannerDataCache;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  /** Defaults cover a full 500-contract host rotation before yielding a stall. */
  noProgressMs?: number;
  inactiveLimit?: number;
}

function intersect(left: ScannerDataRequirements, right: ScannerDataRequirements): ScannerDataRequirements {
  return { metrics: left.metrics && right.metrics, historyHours: left.historyHours.filter(hours => right.historyHours.includes(hours)) };
}
function union(left: ScannerDataRequirements, right: ScannerDataRequirements): ScannerDataRequirements {
  return { metrics: left.metrics || right.metrics, historyHours: [...new Set([...left.historyHours, ...right.historyHours])].sort((a, b) => a - b) };
}
function mergeLeg(previous: PerpetualMarketMetricsLeg | undefined, incoming: PerpetualMarketMetricsLeg): PerpetualMarketMetricsLeg {
  if (!previous || previous.identity !== incoming.identity || incoming.status === 'unsupported') return incoming;
  const keep = (field: 'volume24h' | 'openInterest') => {
    const old = previous[field], next = incoming[field];
    return old.value !== null && (next.value === null || (next.observedAt ?? 0) < (old.observedAt ?? 0))
      ? { ...old, error: next.error || incoming.error || '更新尚未取得新值，保留上次数据' } : next;
  };
  return { ...incoming, volume24h: keep('volume24h'), openInterest: keep('openInterest') };
}
function mergeWindow(previous: FundingWindowTotal | undefined, incoming: FundingWindowTotal): FundingWindowTotal {
  if (previous && previous.netPercent !== null && incoming.status !== 'unsupported'
    && (incoming.netPercent === null || (incoming.asOf ?? 0) < (previous.asOf ?? 0))) {
    return { ...previous, status: incoming.status, reason: incoming.reason || '保留上次累计，等待更新' };
  }
  return incoming;
}
function failedLeg(key: string, reason: string, previous?: PerpetualMarketMetricsLeg): PerpetualMarketMetricsLeg {
  const split = key.indexOf(':'), missing = { value: null, currency: null, observedAt: null, source: '', error: reason };
  return { key, exchange: key.slice(0, split), symbol: key.slice(split + 1), identity: `missing:${key}`, fetchedAt: null, ...previous,
    status: 'error', error: reason, volume24h: { ...(previous?.volume24h ?? missing), error: reason }, openInterest: { ...(previous?.openInterest ?? missing), error: reason } };
}
function failedWindow(hours: FundingWindowHours, reason: string, previous?: FundingWindowTotal): FundingWindowTotal {
  return { hours, asOf: null, longPercent: null, shortPercent: null, netPercent: null, longCount: 0, shortCount: 0, ...previous, status: 'error', reason };
}

/** One queue per browser cache. Subscriber count, candidate count and durable
 * server capacity are separate: only completed batches release the next batch. */
export class PerpetualScannerDataCache {
  private entries = new Map<string, Entry>();
  private subscribers = new Set<Subscriber>();
  private batch: Batch | null = null;
  private request: { controller: AbortController; timeout: unknown } | null = null;
  private timer: unknown;
  private environment: Pick<ScannerDataFeedOptions, 'now' | 'schedule' | 'cancel' | 'noProgressMs' | 'inactiveLimit'> | null = null;
  private order = 0;
  private report: PerpetualScannerDataReport | null = null;
  private generatedAt = 0;
  private storageError = '';
  private failure = '';
  private now = () => this.environment?.now?.() ?? Date.now();
  private schedule = (callback: () => void, delay: number) => this.environment?.schedule?.(callback, delay) ?? setTimeout(callback, delay);
  private cancel = (timer: unknown) => {
    if (timer === undefined) return;
    if (this.environment?.cancel) this.environment.cancel(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  };
  private demands(onlyActive: boolean): Map<string, Demand> {
    const demands = new Map<string, Demand>();
    for (const subscriber of this.subscribers) {
      if (onlyActive && !subscriber.active) continue;
      for (const [key] of subscriber.pairs) {
        const entry = this.entries.get(key);
        if (entry) demands.set(key, { entry, requirements: union(demands.get(key)?.requirements ?? emptyRequirements(), subscriber.requirements) });
      }
    }
    return demands;
  }
  private prune() {
    // Hidden/offline subscribers retain their full candidate set for re-entry.
    const protectedKeys = this.demands(false), inactive = [...this.entries].filter(([key]) => !protectedKeys.has(key)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    const limit = this.environment?.inactiveLimit ?? 500;
    for (const [key] of inactive.slice(0, Math.max(0, inactive.length - limit))) this.entries.delete(key);
  }
  private slots(entry: Entry, requirements: ScannerDataRequirements): (Timed<unknown> | undefined)[] {
    return [...(requirements.metrics ? [entry.metrics] : []), ...requirements.historyHours.map(hours => entry.history.get(hours))];
  }
  private rebuild() {
    const metrics: PerpetualScannerDataReport['metrics'] = Object.create(null), history: PerpetualScannerDataReport['history'] = Object.create(null), metricTimes = new Map<string, number>();
    const demands = this.demands(false), progress = { total: 0, completed: 0, pending: 0, deferred: 0 };
    for (const [key, { entry, requirements }] of demands) {
      if (enabled(requirements)) {
        progress.total++;
        if (this.slots(entry, requirements).every(slot => slot?.terminal)) progress.completed++;
        else { progress.pending++; if (entry.deferred) progress.deferred++; }
      }
      if (entry.metrics?.value) for (const [legKey, leg] of Object.entries(entry.metrics.value)) {
        if (entry.metrics.receivedAt >= (metricTimes.get(legKey) ?? -1)) { metrics[legKey] = leg; metricTimes.set(legKey, entry.metrics.receivedAt); }
      }
      const windows = Object.fromEntries([...entry.history].flatMap(([hours, slot]) => slot.value ? [[hours, slot.value]] : []));
      if (Object.keys(windows).length) history[key] = windows;
    }
    this.report = { schemaVersion: 1, generatedAt: this.generatedAt, metrics, history, progress, ...(this.storageError ? { storageError: this.storageError } : {}) };
  }
  private publish() {
    for (const subscriber of this.subscribers) if (subscriber.active) {
      if (this.report && subscriber.delivered !== this.report) { subscriber.delivered = this.report; subscriber.options.onData(this.report); }
      subscriber.options.onError(this.failure);
      subscriber.options.onLoading(Boolean(this.request || this.batch));
    }
  }
  private needs(entry: Entry, requirements: ScannerDataRequirements): ScannerDataRequirements {
    const now = this.now();
    return { metrics: requirements.metrics && (entry.metrics?.nextReadAt ?? 0) <= now,
      historyHours: requirements.historyHours.filter(hours => (entry.history.get(hours)?.nextReadAt ?? 0) <= now) };
  }
  private postpone(entry: Entry, requirements: ScannerDataRequirements, delay: number, terminal: boolean) {
    const nextReadAt = this.now() + delay, receivedAt = this.now();
    if (requirements.metrics) entry.metrics = { ...entry.metrics, terminal, receivedAt, nextReadAt };
    for (const hours of requirements.historyHours) entry.history.set(hours, { ...entry.history.get(hours), terminal, receivedAt, nextReadAt });
  }
  private pauseIfUnused() {
    if ([...this.subscribers].some(subscriber => subscriber.active && subscriber.pairs.size && enabled(subscriber.requirements))) return false;
    this.cancel(this.timer); this.timer = undefined; this.batch = null;
    if (this.request) { const request = this.request; this.request = null; this.cancel(request.timeout); request.controller.abort(); }
    return true;
  }
  private pump = () => {
    this.cancel(this.timer); this.timer = undefined;
    if (this.pauseIfUnused()) { this.publish(); return; }
    if (this.request) { this.publish(); return; }
    const demands = this.demands(true), now = this.now();
    if (this.batch) {
      for (const [key, item] of this.batch.items) {
        const demand = demands.get(key);
        if (!demand || demand.entry.identity !== item.identity || !enabled(intersect(demand.requirements, this.batch.requirements))) this.batch.items.delete(key);
      }
      if (!this.batch.items.size) this.batch = null;
    }
    if (!this.batch) {
      const candidates = [...demands].map(([key, demand]) => ({ key, ...demand, needed: this.needs(demand.entry, demand.requirements) })).filter(item => enabled(item.needed));
      candidates.sort((a, b) => {
        const slotsA = this.slots(a.entry, a.needed), slotsB = this.slots(b.entry, b.needed);
        return Number(slotsB.some(slot => !slot)) - Number(slotsA.some(slot => !slot))
          || Math.min(...slotsA.map(slot => slot?.nextReadAt ?? 0)) - Math.min(...slotsB.map(slot => slot?.nextReadAt ?? 0)) || a.entry.lastUsed - b.entry.lastUsed;
      });
      if (candidates.length) {
        const requirements = candidates[0].needed, signature = scannerDataRequirementsKey(requirements);
        const selected = candidates.filter(item => scannerDataRequirementsKey(item.needed) === signature).slice(0, 30);
        this.batch = { requirements, nextReadAt: now, items: new Map(selected.map(item => [item.key, { identity: item.entry.identity, progressAt: now, fingerprint: '' }])) };
      } else {
        const times = [...demands.values()].flatMap(({ entry, requirements }) => this.slots(entry, requirements).map(slot => slot?.nextReadAt ?? 0));
        if (times.length) this.timer = this.schedule(this.pump, Math.max(1, times.reduce((earliest, time) => Math.min(earliest, time), Infinity) - now));
        this.publish(); return;
      }
    }
    if (this.batch.nextReadAt > now) { this.timer = this.schedule(this.pump, this.batch.nextReadAt - now); this.publish(); return; }
    void this.load(this.batch, demands);
  };
  private async load(batch: Batch, demands: Map<string, Demand>) {
    const owner = [...this.subscribers].find(subscriber => subscriber.active && subscriber.pairs.size);
    if (!owner) return;
    let requirements = emptyRequirements();
    const pairs = [...batch.items.keys()].flatMap(key => {
      const demand = demands.get(key);
      if (!demand) return [];
      requirements = union(requirements, intersect(demand.requirements, batch.requirements));
      return [demand.entry.pair];
    });
    const controller = new AbortController();
    let timedOut = false;
    const request = { controller, timeout: this.schedule(() => { timedOut = true; controller.abort(); }, 12_000) };
    this.request = request; this.publish();
    try {
      const report = await Promise.race([owner.options.load({ pairs, ...requirements }, controller.signal),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Error('Scanner read aborted')), { once: true }))]);
      if (this.request !== request || controller.signal.aborted) return;
      if (!isPerpetualScannerDataReport(report)) throw Error('Invalid scanner cache report');
      const now = this.now(), currentDemands = this.demands(true);
      this.generatedAt = Math.max(this.generatedAt, report.generatedAt); this.storageError = report.storageError ?? ''; this.failure = '';
      for (const [key, item] of batch.items) {
        const entry = this.entries.get(key);
        if (!entry || entry.identity !== item.identity) { batch.items.delete(key); continue; }
        const fingerprint: unknown[] = [];
        if (requirements.metrics) {
          const legs = [entry.pair.longKey, entry.pair.shortKey].map(legKey => {
            if (report.metrics[legKey]) return report.metrics[legKey];
            return failedLeg(legKey, '接口未返回该合约指标', entry.metrics?.value?.[legKey]);
          });
          const terminal = legs.every(leg => leg.status !== 'pending' || Boolean(leg.error));
          const value = Object.fromEntries(legs.map(leg => [leg.key, mergeLeg(entry.metrics?.value?.[leg.key], leg)]));
          entry.metrics = { value, terminal, nextReadAt: now + (terminal ? REFRESH_MS : POLL_MS), receivedAt: now };
          fingerprint.push(legs.map(leg => leg ? [leg.status, leg.error, leg.volume24h.observedAt, leg.openInterest.observedAt] : null));
        }
        for (const hours of requirements.historyHours) {
          const incoming = report.history[key]?.[hours] ?? failedWindow(hours, '接口未返回该组合窗口', entry.history.get(hours)?.value);
          const terminal = incoming.status !== 'pending';
          entry.history.set(hours, { value: mergeWindow(entry.history.get(hours)?.value, incoming), terminal, nextReadAt: now + (terminal ? REFRESH_MS : POLL_MS), receivedAt: now });
          fingerprint.push([hours, incoming.status, incoming.asOf, incoming.longCount, incoming.shortCount, incoming.reason]);
        }
        const effective = intersect(batch.requirements, currentDemands.get(key)?.requirements ?? emptyRequirements());
        if (this.slots(entry, effective).every(slot => slot?.terminal)) { entry.deferred = false; batch.items.delete(key); continue; }
        const serialized = JSON.stringify(fingerprint);
        if (serialized !== item.fingerprint) { item.fingerprint = serialized; item.progressAt = now; }
        else if (now - item.progressAt >= (this.environment?.noProgressMs ?? NO_PROGRESS_MS)) {
          this.postpone(entry, effective, REFRESH_MS, false); entry.deferred = true; batch.items.delete(key);
        }
      }
      if ([...this.demands(false).values()].some(({ entry }) => entry.deferred)) this.failure = '部分组合长时间未取得完整数据，已继续检查其余组合；缺失数据稍后重试。';
      let remaining = emptyRequirements();
      for (const key of batch.items.keys()) {
        const entry = this.entries.get(key)!;
        remaining = union(remaining, { metrics: batch.requirements.metrics && !entry.metrics?.terminal,
          historyHours: batch.requirements.historyHours.filter(hours => !entry.history.get(hours)?.terminal) });
      }
      this.batch = batch.items.size ? { ...batch, requirements: remaining, nextReadAt: now + POLL_MS } : null;
      this.rebuild();
    } catch {
      if (this.request !== request || (controller.signal.aborted && !timedOut)) return;
      for (const [key, item] of batch.items) {
        const entry = this.entries.get(key);
        if (!entry || entry.identity !== item.identity) continue;
        const reason = '筛选数据读取失败，保留上次数据并稍后重试';
        if (requirements.metrics) entry.metrics = { ...entry.metrics, nextReadAt: 0, terminal: true, receivedAt: this.now(),
          value: Object.fromEntries([entry.pair.longKey, entry.pair.shortKey].map(legKey => [legKey, failedLeg(legKey, reason, entry.metrics?.value?.[legKey])])) };
        for (const hours of requirements.historyHours) entry.history.set(hours, { ...entry.history.get(hours), nextReadAt: 0, terminal: true, receivedAt: this.now(),
          value: failedWindow(hours, reason, entry.history.get(hours)?.value) });
        this.postpone(entry, requirements, FAILURE_MS, true);
      }
      this.failure = '筛选数据暂时无法更新，已继续检查其余组合，稍后重试。'; this.batch = null; this.rebuild();
    } finally {
      this.cancel(request.timeout);
      if (this.request === request) { this.request = null; this.publish(); queueMicrotask(this.pump); }
    }
  }
  subscribe(options: ScannerDataFeedOptions) {
    if (!this.environment) {
      const { now, schedule, cancel, noProgressMs, inactiveLimit } = options;
      this.environment = { now, schedule, cancel, noProgressMs, inactiveLimit };
    }
    const subscriber: Subscriber = { options, pairs: new Map(), requirements: emptyRequirements(), active: false, delivered: null };
    this.subscribers.add(subscriber);
    let stopped = false, selectionKey = '[]', requirementsKey = scannerDataRequirementsKey(subscriber.requirements);
    return {
      setSelection: (pairs: ScannerDataPair[], requirements: ScannerDataRequirements) => {
        if (stopped) return;
        const nextSelection = scannerDataSelectionKey(pairs), nextRequirements = scannerDataRequirementsKey(requirements);
        if (nextSelection === selectionKey && nextRequirements === requirementsKey) return;
        selectionKey = nextSelection; requirementsKey = nextRequirements;
        subscriber.requirements = JSON.parse(nextRequirements) as ScannerDataRequirements;
        subscriber.pairs = new Map((JSON.parse(nextSelection) as ScannerDataPair[]).map(pair => [scannerDataPairKey(pair), pair]));
        for (const [key, pair] of subscriber.pairs) {
          const entry = this.entries.get(key), identity = pair.identity ?? '';
          if (!entry || entry.identity !== identity) this.entries.set(key, { pair: canonicalScannerDataPair(pair), identity, lastUsed: ++this.order, history: new Map(), deferred: false });
          else { entry.pair = pair; entry.lastUsed = ++this.order; }
        }
        this.prune(); this.rebuild(); this.pump();
      },
      setActive: (active: boolean) => {
        if (stopped || subscriber.active === active) return;
        subscriber.active = active;
        if (!active) options.onLoading(false);
        this.pump();
      },
      stop: () => {
        if (stopped) return;
        stopped = true; this.subscribers.delete(subscriber); this.prune(); this.rebuild(); this.pump();
      },
    };
  }
}

export const createPerpetualScannerDataCache = () => new PerpetualScannerDataCache();
let browserCache: PerpetualScannerDataCache | undefined;
export function startPerpetualScannerDataFeed(options: ScannerDataFeedOptions) {
  const cache = options.cache ?? (typeof window === 'undefined' ? createPerpetualScannerDataCache() : browserCache ??= createPerpetualScannerDataCache());
  return cache.subscribe(options);
}

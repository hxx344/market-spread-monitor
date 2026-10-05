import type { FundingHistoryPairRequest, PerpetualFundingHistoryReport, PerpetualFundingLeg } from "./perpetual-funding-history.ts";

/** Prices, quote times and ranking order do not change the requested contracts. */
export function fundingHistoryRequestKey(pairs: FundingHistoryPairRequest[]) {
  const entries = new Map<string, FundingHistoryPairRequest>();
  for (const { base, longKey, shortKey } of pairs.slice(0, 30)) {
    entries.set(JSON.stringify([base, longKey, shortKey]), { base, longKey, shortKey });
  }
  return JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair));
}

export function isFundingHistoryReport(value: unknown): value is PerpetualFundingHistoryReport {
  if (!value || typeof value !== "object") return false;
  const report = value as PerpetualFundingHistoryReport;
  const timestamp = (time: unknown) => typeof time === "number" && Number.isSafeInteger(time) && time >= 0;
  if (report.schemaVersion !== 1 || !timestamp(report.generatedAt) || !report.legs || typeof report.legs !== "object" || Array.isArray(report.legs) || Object.keys(report.legs).length > 60) return false;
  return Object.entries(report.legs).every(([key, leg]) => {
    if (!leg || leg.key !== key || typeof leg.exchange !== "string" || typeof leg.symbol !== "string" || typeof leg.identity !== "string" || !leg.identity
      || key !== `${leg.exchange}:${leg.symbol}` || !["pending", "ready", "error", "unsupported"].includes(leg.status)
      || (leg.fetchedAt !== null && !timestamp(leg.fetchedAt)) || typeof leg.error !== "string"
      || (leg.coverage !== null && (!timestamp(leg.coverage?.from) || !timestamp(leg.coverage?.to) || leg.coverage.from > leg.coverage.to))
      || !Array.isArray(leg.records) || leg.records.length > 2000 || (!leg.coverage && (leg.records.length > 0 || leg.status === "ready"))) return false;
    const times = new Set<number>();
    return leg.records.every(record => {
      if (!record || !timestamp(record.time) || !Number.isFinite(record.rate) || Math.abs(record.rate) > 1 || !leg.coverage
        || record.time < leg.coverage.from || record.time > leg.coverage.to || times.has(record.time)) return false;
      times.add(record.time); return true;
    });
  });
}

interface FundingHistoryFeedOptions {
  load: (pairs: FundingHistoryPairRequest[], signal: AbortSignal) => Promise<PerpetualFundingHistoryReport>;
  onData: (report: PerpetualFundingHistoryReport) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** One read at a time; retain source timestamps and a bounded cache across page changes. */
export function startPerpetualFundingHistoryFeed(options: FundingHistoryFeedOptions) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const cache = new Map<string, PerpetualFundingLeg>();
  let active = false, stopped = false, wanted = false;
  let pairs: FundingHistoryPairRequest[] = [], key = "[]";
  let request: AbortController | null = null;
  let refreshTimer: unknown, debounceTimer: unknown, deadlineTimer: unknown, timeoutTimer: unknown;
  const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };
  function clearSelectionTimers() { clear(debounceTimer); clear(deadlineTimer); debounceTimer = deadlineTimer = undefined; }
  function clearTimers() { clearSelectionTimers(); clear(refreshTimer); refreshTimer = undefined; }
  function abortRequest() { clear(timeoutTimer); timeoutTimer = undefined; request?.abort(); }
  function accept(report: PerpetualFundingHistoryReport, requested: FundingHistoryPairRequest[]) {
    for (const legKey of new Set(requested.flatMap(pair => [pair.longKey, pair.shortKey]))) {
      const previous = cache.get(legKey), incoming = report.legs[legKey];
      if (!incoming) {
        if (previous) cache.set(legKey, { ...previous, status: "error", error: "历史结算接口未返回该合约" });
        continue;
      }
      // A cache miss or failed refresh must not erase previously verified settlements.
      const keepPrevious = previous?.coverage && previous.identity === incoming.identity && incoming.status !== "unsupported" && (!incoming.coverage || incoming.coverage.to < previous.coverage.to);
      const next = keepPrevious ? { ...previous, status: incoming.status, error: incoming.error } : incoming;
      cache.delete(legKey); cache.set(legKey, next);
    }
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
    return { ...report, legs: Object.fromEntries(cache) };
  }
  async function load() {
    if (stopped || !active || !pairs.length || request) return;
    clearTimers(); wanted = false;
    const requestedKey = key, requestedPairs = pairs, controller = new AbortController();
    request = controller;
    let timedOut = false, refreshDelay = 60_000;
    timeoutTimer = schedule(() => { timedOut = true; controller.abort(); }, 12_000);
    options.onLoading(true);
    try {
      const report = await options.load(requestedPairs, controller.signal);
      if (!stopped && active && !controller.signal.aborted) {
        if (!isFundingHistoryReport(report)) throw new Error("历史结算格式异常");
        options.onData(accept(report, requestedPairs)); options.onError("");
        if (requestedPairs.some(pair => [pair.longKey, pair.shortKey].some(legKey => !report.legs[legKey] || report.legs[legKey].status === "pending"))) refreshDelay = 3_000;
      }
    } catch {
      if (!stopped && active && (timedOut || !controller.signal.aborted)) options.onError("历史结算暂时无法更新，保留上次记录，稍后自动重试。");
    } finally {
      clear(timeoutTimer); timeoutTimer = undefined;
      if (request === controller) request = null;
      if (!stopped) options.onLoading(false);
      if (stopped || !active || !pairs.length) return;
      if (wanted) { void load(); return; }
      if (requestedKey === key && debounceTimer === undefined) refreshTimer = schedule(() => { refreshTimer = undefined; void load(); }, refreshDelay);
    }
  }
  function requestLatest() { clearSelectionTimers(); wanted = true; void load(); }
  return {
    setPairs(next: FundingHistoryPairRequest[]) {
      const nextKey = fundingHistoryRequestKey(next);
      if (nextKey === key || stopped) return;
      const wasEmpty = !pairs.length;
      key = nextKey; pairs = JSON.parse(nextKey) as FundingHistoryPairRequest[];
      clear(refreshTimer); refreshTimer = undefined;
      if (!pairs.length) { clearSelectionTimers(); wanted = false; abortRequest(); options.onLoading(false); return; }
      if (!active) return;
      if (wasEmpty) { requestLatest(); return; }
      clear(debounceTimer); debounceTimer = schedule(requestLatest, 1_200);
      if (deadlineTimer === undefined) deadlineTimer = schedule(requestLatest, 5_000);
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value;
      if (active) { requestLatest(); return; }
      clearTimers(); wanted = false; abortRequest(); options.onLoading(false);
    },
    stop() { stopped = true; active = false; clearTimers(); abortRequest(); },
  };
}

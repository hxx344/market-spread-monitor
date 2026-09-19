import type { PerpetualDelta, PerpetualExchange, PerpetualQuote, PerpetualSnapshot } from "./perpetual-types.ts";

export type PerpetualConnection = "connecting" | "stream" | "polling" | "error" | "paused";
interface SnapshotStream {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}
interface FeedOptions {
  fetchSnapshot: (signal: AbortSignal) => Promise<unknown>;
  createStream: () => SnapshotStream;
  onData: (snapshot: PerpetualSnapshot) => void;
  onConnection: (state: PerpetualConnection) => void;
  onError: (message: string) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export function parsePerpetualSnapshot(value: unknown): PerpetualSnapshot {
  const snapshot = value as PerpetualSnapshot | null;
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.monitorId !== "perpetual" || !Number.isFinite(snapshot.generatedAt)
    || !Number.isFinite(snapshot.staleAfterMs) || snapshot.staleAfterMs <= 0 || !Array.isArray(snapshot.quotes) || !Array.isArray(snapshot.exchanges)) {
    throw new Error("行情响应格式异常，正在重试。");
  }
  return snapshot;
}

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

/** Materialize delta frames once, preserving unaffected object and array identities. */
export function createPerpetualSnapshotAccumulator() {
  let snapshot: PerpetualSnapshot | null = null;
  let quotes = new Map<string, PerpetualQuote>();
  let venues = new Map<string, PerpetualExchange>();
  const key = (quote: PerpetualQuote) => {
    if (!quote || typeof quote.exchange !== "string" || typeof quote.symbol !== "string") throw new Error("行情报价格式异常。");
    return `${quote.exchange}:${quote.symbol}`;
  };
  const reuseVenues = (next: PerpetualExchange[]) => {
    const list = next.map(venue => { const previous = venues.get(venue.id); return previous && sameFields(previous, venue) ? previous : venue; });
    const same = snapshot && list.length === snapshot.exchanges.length && list.every((venue, index) => venue === snapshot!.exchanges[index]);
    venues = new Map(list.map(venue => [venue.id, venue]));
    return same ? snapshot!.exchanges : list;
  };
  return (value: unknown): PerpetualSnapshot | null => {
    const frame = value as PerpetualSnapshot | PerpetualDelta;
    if (snapshot && frame && Number.isFinite(frame.generatedAt) && frame.generatedAt < snapshot.generatedAt) return null;
    if (frame && "type" in frame && frame.type === "delta") {
      if (!snapshot) throw new Error("增量行情缺少完整快照，正在重新同步。");
      if (frame.schemaVersion !== 1 || frame.monitorId !== "perpetual" || !Number.isFinite(frame.generatedAt)
        || !Number.isFinite(frame.staleAfterMs) || frame.staleAfterMs <= 0 || !Array.isArray(frame.updates) || !Array.isArray(frame.removed) || !Array.isArray(frame.exchanges)) throw new Error("增量行情格式异常。");
      let changed = false;
      for (const removed of frame.removed) { if (typeof removed !== "string") throw new Error("移除报价标识异常。"); if (quotes.delete(removed)) changed = true; }
      for (const quote of frame.updates) {
        const id = key(quote), previous = quotes.get(id);
        if (!previous || !sameFields(previous, quote)) { quotes.set(id, quote); changed = true; }
      }
      snapshot = { schemaVersion: 1, monitorId: "perpetual", generatedAt: frame.generatedAt, staleAfterMs: frame.staleAfterMs, status: frame.status,
        exchanges: reuseVenues(frame.exchanges), quotes: changed ? [...quotes.values()] : snapshot.quotes,
        error: frame.error ?? null, note: frame.note ?? null, storageError: frame.storageError ?? null };
    } else {
      const next = parsePerpetualSnapshot(value);
      const list = next.quotes.map(quote => { const previous = quotes.get(key(quote)); return previous && sameFields(previous, quote) ? previous : quote; });
      const same = snapshot && list.length === snapshot.quotes.length && list.every((quote, index) => quote === snapshot!.quotes[index]);
      const exchanges = reuseVenues(next.exchanges);
      quotes = new Map(list.map(quote => [key(quote), quote]));
      snapshot = { ...next, quotes: same ? snapshot!.quotes : list, exchanges };
    }
    return snapshot;
  };
}

/** One stream per visible panel; falls back to bounded snapshot requests on transport failure. */
export function startPerpetualFeed(options: FeedOptions) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let stream: SnapshotStream | null = null;
  let pollingTimer: unknown, reconnectTimer: unknown, watchdogTimer: unknown;
  let request: AbortController | null = null;
  let requestTimer: unknown;
  const accumulate = createPerpetualSnapshotAccumulator();
  let streaming = false;
  let fallback = false;

  const accept = (value: unknown) => {
    const snapshot = accumulate(value);
    if (!snapshot) return;
    options.onData(snapshot);
    options.onError("");
  };
  const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };

  async function loadSnapshot() {
    if (stopped || request) return;
    const controller = new AbortController();
    request = controller;
    requestTimer = schedule(() => controller.abort(), 12_000);
    try {
      const value = await options.fetchSnapshot(controller.signal);
      if (stopped || controller.signal.aborted) return;
      accept(value);
      if (fallback) options.onConnection("polling");
    } catch {
      if (!stopped && !streaming) {
        options.onConnection("error");
        options.onError("无法更新行情，5 秒后重试。已有报价超过有效期会退出排名。");
      }
    } finally {
      clear(requestTimer);
      if (request === controller) request = null;
      if (!stopped && fallback) {
        clear(pollingTimer);
        pollingTimer = schedule(() => { void loadSnapshot(); }, 5_000);
      }
    }
  }

  function switchToPolling() {
    if (stopped) return;
    streaming = false;
    fallback = true;
    stream?.close(); stream = null;
    clear(watchdogTimer);
    options.onConnection("polling");
    void loadSnapshot();
    clear(reconnectTimer);
    reconnectTimer = schedule(connect, 30_000);
  }

  function watch() {
    clear(watchdogTimer);
    watchdogTimer = schedule(switchToPolling, 12_000);
  }

  function connect() {
    if (stopped) return;
    try {
      stream?.close();
      const current = options.createStream();
      stream = current;
      current.onmessage = event => {
        if (stopped || current !== stream) return;
        try {
          accept(JSON.parse(event.data));
          streaming = true; fallback = false;
          clear(pollingTimer); clear(reconnectTimer);
          options.onConnection("stream");
          watch();
        } catch { switchToPolling(); }
      };
      current.onerror = () => { if (current === stream) switchToPolling(); };
      watch();
    } catch { switchToPolling(); }
  }

  options.onConnection("connecting");
  connect();
  return {
    refresh: () => { clear(pollingTimer); void loadSnapshot(); },
    stop() {
      stopped = true;
      stream?.close(); stream = null;
      request?.abort();
      [pollingTimer, reconnectTimer, watchdogTimer, requestTimer].forEach(clear);
    },
  };
}

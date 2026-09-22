export const QUOTE_REFRESH_MS = 10_000;
export const HISTORY_REFRESH_MS = 60_000;

interface PollingOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  intervalMs: number;
  immediate?: boolean;
  timeoutMs?: number;
}
interface VisibilitySource {
  hidden: boolean;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}
interface NetworkSource {
  readonly onLine: boolean;
  addEventListener: (type: "online" | "offline", listener: () => void) => void;
  removeEventListener: (type: "online" | "offline", listener: () => void) => void;
}
const browserNetwork: NetworkSource | undefined = typeof window === "undefined" ? undefined : {
  get onLine() { return navigator.onLine; },
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener),
};

/** Fixed-cadence polling with a shared in-flight request and unmount cancellation. */
export function startPolling<T>({ load, onData, onError, onSettled, intervalMs, immediate = true, timeoutMs = 15_000 }: PollingOptions<T>) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  let stopped = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    const deadline = setTimeout(() => controllerForRequest.abort(new DOMException("数据读取超时，稍后自动重试", "TimeoutError")), timeoutMs);
    const controllerForRequest = controller;
    let cancel: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    pending = Promise.race([cancelled, Promise.resolve()
      .then(() => { if (signal.aborted) throw signal.reason; return load(signal); })])
      .then(value => { if (!stopped && !signal.aborted) onData(value); })
      .catch(error => { if (!stopped && (!signal.aborted || signal.reason?.name === "TimeoutError")) onError(error); })
      .finally(() => { clearTimeout(deadline); signal.removeEventListener("abort", cancel); pending = undefined; if (!stopped) onSettled?.(); });
    return pending;
  };
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  if (immediate) void refresh();
  return {
    refresh,
    stop() { stopped = true; clearInterval(timer); controller?.abort(); },
  };
}

/** Keep component state while suspending its timers and reads whenever it cannot be seen. */
export function startActivityPolling<T>({ active = true, page = typeof document === "undefined" ? undefined : document, network = browserNetwork, ...options }: PollingOptions<T> & { active?: boolean; page?: VisibilitySource; network?: NetworkSource }) {
  let enabled = active, stopped = false, activated = !active || Boolean(page?.hidden) || network?.onLine === false;
  let polling: ReturnType<typeof startPolling<T>> | null = null;
  function synchronize() {
    if (stopped) return;
    if (!enabled || page?.hidden || network?.onLine === false) { polling?.stop(); polling = null; return; }
    if (polling) return;
    polling = startPolling({ ...options, immediate: activated ? true : options.immediate });
    activated = true;
  }
  page?.addEventListener("visibilitychange", synchronize);
  network?.addEventListener("online", synchronize);
  network?.addEventListener("offline", synchronize);
  synchronize();
  return {
    refresh() { return polling?.refresh() ?? Promise.resolve(); },
    setActive(value: boolean) { enabled = value; synchronize(); },
    stop() { stopped = true; polling?.stop(); polling = null; page?.removeEventListener("visibilitychange", synchronize); network?.removeEventListener("online", synchronize); network?.removeEventListener("offline", synchronize); },
  };
}

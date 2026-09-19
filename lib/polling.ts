export const QUOTE_REFRESH_MS = 10_000;
export const HISTORY_REFRESH_MS = 60_000;

interface PollingOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  intervalMs: number;
  immediate?: boolean;
}
interface VisibilitySource {
  hidden: boolean;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

/** Fixed-cadence polling with a shared in-flight request and unmount cancellation. */
export function startPolling<T>({ load, onData, onError, onSettled, intervalMs, immediate = true }: PollingOptions<T>) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    pending = Promise.resolve()
      .then(() => { if (signal.aborted) throw signal.reason; return load(signal); })
      .then(value => { if (!stopped && !signal.aborted) onData(value); })
      .catch(error => { if (!stopped && !signal.aborted) onError(error); })
      .finally(() => { pending = undefined; if (!stopped) onSettled?.(); });
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
export function startActivityPolling<T>({ active = true, page = typeof document === "undefined" ? undefined : document, ...options }: PollingOptions<T> & { active?: boolean; page?: VisibilitySource }) {
  let enabled = active, stopped = false, activated = !active || Boolean(page?.hidden);
  let polling: ReturnType<typeof startPolling<T>> | null = null;
  function synchronize() {
    if (stopped) return;
    if (!enabled || page?.hidden) { polling?.stop(); polling = null; return; }
    if (polling) return;
    polling = startPolling({ ...options, immediate: activated ? true : options.immediate });
    activated = true;
  }
  page?.addEventListener("visibilitychange", synchronize);
  synchronize();
  return {
    refresh() { return polling?.refresh() ?? Promise.resolve(); },
    setActive(value: boolean) { enabled = value; synchronize(); },
    stop() { stopped = true; polling?.stop(); polling = null; page?.removeEventListener("visibilitychange", synchronize); },
  };
}

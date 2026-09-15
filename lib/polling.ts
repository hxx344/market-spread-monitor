export const QUOTE_REFRESH_MS = 10_000;
export const HISTORY_REFRESH_MS = 60_000;

/** Fixed-cadence polling with a shared in-flight request and unmount cancellation. */
export function startPolling<T>({ load, onData, onError, onSettled, intervalMs, immediate = true }: {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  intervalMs: number;
  immediate?: boolean;
}) {
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

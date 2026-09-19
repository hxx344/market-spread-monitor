export const OIL_REFRESH_MS = 60_000;
export const OIL_FUNDING_REFRESH_MS = 300_000;

/** Schedule by elapsed browser time, never by the server's data timestamps. */
export function startOilAutoRefresh({ prices, funding, page = document, view = window, active = true, onError = console.warn }) {
  const controller = new AbortController();
  let enabled = active, session = new AbortController(), priceTimer, fundingTimer;
  const running = new Map();
  const run = task => {
    if (controller.signal.aborted || !enabled || page.hidden || running.has(task)) return;
    const signal = session.signal;
    const request = Promise.resolve().then(() => {
      if (!controller.signal.aborted && !signal.aborted && enabled && !page.hidden) return task(signal);
    }).catch(error => { if (!controller.signal.aborted && !signal.aborted) onError(error); }).finally(() => running.delete(task));
    running.set(task, request);
  };
  const synchronize = () => {
    clearInterval(priceTimer); clearInterval(fundingTimer);
    if (controller.signal.aborted || !enabled || page.hidden) { session.abort(); return; }
    if (session.signal.aborted) session = new AbortController();
    priceTimer = setInterval(() => run(prices), OIL_REFRESH_MS);
    fundingTimer = setInterval(() => run(funding), OIL_FUNDING_REFRESH_MS);
  };
  const resume = () => { synchronize(); run(prices); run(funding); };
  synchronize();
  const options = { signal: controller.signal };
  page.addEventListener('visibilitychange', resume, options);
  view.addEventListener('online', resume, options);
  view.addEventListener('pageshow', event => { if (event.persisted) resume(); }, options);
  const stop = () => { controller.abort(); session.abort(); clearInterval(priceTimer); clearInterval(fundingTimer); };
  stop.signal = () => session.signal;
  stop.setActive = value => {
    if (enabled === value || controller.signal.aborted) return;
    enabled = value; synchronize();
    if (enabled) {
      const pending = [...running.values()];
      if (pending.length) void Promise.allSettled(pending).then(() => { run(prices); run(funding); });
      else { run(prices); run(funding); }
    }
  };
  return stop;
}

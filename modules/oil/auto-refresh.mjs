export const OIL_REFRESH_MS = 60_000;
export const OIL_FUNDING_REFRESH_MS = 300_000;

/** Schedule by elapsed browser time, never by the server's data timestamps. */
export function startOilAutoRefresh({ prices, funding, page = document, view = window, onError = console.warn }) {
  const controller = new AbortController();
  const running = new Map();
  const run = task => {
    if (controller.signal.aborted || page.hidden || running.has(task)) return;
    const request = Promise.resolve().then(() => {
      if (!controller.signal.aborted && !page.hidden) return task();
    }).catch(error => { if (!controller.signal.aborted) onError(error); }).finally(() => running.delete(task));
    running.set(task, request);
  };
  const resume = () => { run(prices); run(funding); };
  const priceTimer = setInterval(() => run(prices), OIL_REFRESH_MS);
  const fundingTimer = setInterval(() => run(funding), OIL_FUNDING_REFRESH_MS);
  const options = { signal: controller.signal };
  page.addEventListener('visibilitychange', resume, options);
  view.addEventListener('online', resume, options);
  view.addEventListener('pageshow', event => { if (event.persisted) resume(); }, options);
  return () => { controller.abort(); clearInterval(priceTimer); clearInterval(fundingTimer); };
}

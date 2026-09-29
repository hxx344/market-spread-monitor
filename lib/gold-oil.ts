export const GOLD_OIL_INTERVAL_MS = 900_000;
export const GOLD_OIL_QUOTE_MS = 30_000;
export const GOLD_OIL_HISTORY_MS = 60_000;
export const GOLD_OIL_STALE_MS = 75_000;
export const GOLD_OIL_SYMBOLS = { cl: 'CLUSDT', xau: 'XAUUSDT' } as const;
type Leg = { symbol: string; price: number; updatedAt: string };
export type GoldOilQuote = { source: 'Binance'; currency: 'USDT'; priceBasis: 'mark'; fetchedAt: string; cl: Leg; xau: Leg; ratio: number; status: 'live' | 'snapshot' };
export type GoldOilPoint = { time: number; cl: number | null; xau: number | null; ratio: number | null };
export type GoldOilHistory = { source: 'Binance'; currency: 'USDT'; priceBasis: 'mark'; interval: '15m'; fetchedAt: string; status: 'live' | 'snapshot'; points: GoldOilPoint[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid gold/oil data');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw Error('Invalid gold/oil price');
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0) throw Error('Invalid gold/oil time');
  return value;
}
function common(value: Record<string, unknown>) {
  if (value.source !== 'Binance' || value.currency !== 'USDT' || value.priceBasis !== 'mark' || !['live', 'snapshot'].includes(String(value.status))) throw Error('Invalid gold/oil source');
  return { source: 'Binance' as const, currency: 'USDT' as const, priceBasis: 'mark' as const, fetchedAt: stamp(value.fetchedAt), status: value.status as 'live' | 'snapshot' };
}
/** USDT/ounce divided by USDT/barrel gives barrels/ounce. */
export function goldOilRatio(cl: number | null, xau: number | null): number | null {
  if (cl === null || xau === null || !Number.isFinite(cl) || !Number.isFinite(xau) || cl <= 0 || xau <= 0) return null;
  const ratio = xau / cl;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
export function validateGoldOilQuote(input: unknown): GoldOilQuote {
  const value = object(input), base = common(value);
  const leg = (key: 'cl' | 'xau'): Leg => {
    const item = object(value[key]);
    if (item.symbol !== GOLD_OIL_SYMBOLS[key]) throw Error('Unexpected gold/oil contract');
    return { symbol: GOLD_OIL_SYMBOLS[key], price: positive(item.price), updatedAt: stamp(item.updatedAt) };
  };
  const cl = leg('cl'), xau = leg('xau'), times = [Date.parse(cl.updatedAt), Date.parse(xau.updatedAt)];
  const ratio = goldOilRatio(cl.price, xau.price);
  if (Math.abs(times[0] - times[1]) > 15_000 || Date.parse(base.fetchedAt) !== Math.min(...times) || ratio === null) throw Error('Unsynchronized gold/oil quote');
  return { ...base, cl, xau, ratio };
}
export function validateGoldOilHistory(input: unknown): GoldOilHistory {
  const value = object(input), base = common(value);
  if (value.interval !== '15m' || !Array.isArray(value.points) || !value.points.length || value.points.length > 672) throw Error('Invalid gold/oil history');
  let previous = 0;
  const points = value.points.map(item => {
    const row = object(item), time = row.time;
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= previous || time % GOLD_OIL_INTERVAL_MS || time + GOLD_OIL_INTERVAL_MS > Date.parse(base.fetchedAt)) throw Error('Invalid gold/oil candle time');
    previous = time;
    const cl = row.cl === null ? null : positive(row.cl), xau = row.xau === null ? null : positive(row.xau);
    return { time, cl, xau, ratio: goldOilRatio(cl, xau) };
  });
  if (!points.some(point => point.ratio !== null)) throw Error('No paired gold/oil history');
  return { ...base, interval: '15m', points };
}

/** Include explicit nulls so Recharts cannot join across a missing period. */
export function goldOilChartPoints(history: GoldOilHistory | null, days: number) {
  if (!history?.points.length) return [];
  const end = Math.floor(Date.parse(history.fetchedAt) / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  const start = Math.max(history.points[0].time, end - days * 86_400_000);
  const points = new Map(history.points.map(point => [point.time, point]));
  const rows: GoldOilPoint[] = [];
  for (let time = start; time < end; time += GOLD_OIL_INTERVAL_MS) rows.push(points.get(time) ?? { time, cl: null, xau: null, ratio: null });
  return rows;
}

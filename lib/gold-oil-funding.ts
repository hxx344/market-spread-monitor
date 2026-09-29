import { GOLD_OIL_SYMBOLS, type GoldOilQuote } from './gold-oil.ts';

export const HOUR = 3_600_000;
export type FundingEvent = { time: number; cl: number | null; xau: number | null };
export type GoldOilFundingHistory = { source: 'Binance'; fetchedAt: string; status: 'live' | 'snapshot'; coverageStart: number; coverageEnd: number; points: FundingEvent[] };
export function currentGoldOilFunding(quote: GoldOilQuote | null) {
  if (!quote?.funding) return null;
  const { xau, cl } = quote.funding;
  const hourlyRate = (xau.rate / xau.intervalHours - cl.rate / cl.intervalHours) / 2;
  return { hourlyRate, annualized: hourlyRate * 8760, cashPerHour: hourlyRate * 10_000 };
}

export function validateGoldOilFunding(input: unknown): GoldOilFundingHistory {
  const value = input as GoldOilFundingHistory;
  if (!value || value.source !== 'Binance' || !['live', 'snapshot'].includes(value.status) || !Number.isFinite(Date.parse(value.fetchedAt)) || !Number.isSafeInteger(value.coverageStart) || !Number.isSafeInteger(value.coverageEnd) || value.coverageStart <= 0 || value.coverageEnd <= value.coverageStart || value.coverageEnd > Date.parse(value.fetchedAt) + 1 || !Array.isArray(value.points) || value.points.length > 100_000) throw Error('Invalid gold/oil funding history');
  let previous = 0;
  const points = value.points.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time <= previous || row.time < value.coverageStart || row.time >= value.coverageEnd || row.cl === null && row.xau === null) throw Error('Invalid gold/oil funding time');
    previous = row.time;
    for (const rate of [row.cl, row.xau]) if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1)) throw Error('Invalid settled funding rate');
    return { time: row.time, cl: row.cl, xau: row.xau };
  });
  return { source: 'Binance', fetchedAt: value.fetchedAt, status: value.status, coverageStart: value.coverageStart, coverageEnd: value.coverageEnd, points };
}

export function parseGoldOilFunding(clInput: unknown, xauInput: unknown, start: number, end: number, now: number, previous: GoldOilFundingHistory | null = null) {
  const values = new Map<number, FundingEvent>((previous?.points ?? []).map(row => [row.time, { ...row }]));
  for (const [key, input] of [['cl', clInput], ['xau', xauInput]] as const) {
    if (!Array.isArray(input)) throw Error('Invalid Binance funding history');
    const seen = new Set<number>();
    for (const row of input) {
      const time = row.fundingTime, rate = typeof row.fundingRate === 'string' && row.fundingRate.trim() ? Number(row.fundingRate) : row.fundingRate;
      if (row.symbol !== GOLD_OIL_SYMBOLS[key] || row.rateType !== undefined && row.rateType !== 'Regular' || !Number.isSafeInteger(time) || time < start || time >= end || seen.has(time) || typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1) throw Error('Invalid Binance funding event');
      seen.add(time);
      const event = values.get(time) ?? { time, cl: null, xau: null };
      event[key] = rate; values.set(time, event);
    }
  }
  return validateGoldOilFunding({ source: 'Binance', status: 'live', fetchedAt: new Date(now).toISOString(), coverageStart: Math.min(start, previous?.coverageStart ?? start), coverageEnd: end, points: [...values.values()].sort((a, b) => a.time - b.time) });
}

/** Sum each leg's actual events, including settlements at different times or intervals. */
export function analyzeGoldOilFunding(history: GoldOilFundingHistory | null, start: number, end: number) {
  const covered = Boolean(history && start >= history.coverageStart && end <= history.coverageEnd && end > start);
  const events = history?.points.filter(row => row.time >= start && row.time < end) ?? [];
  const hasBoth = events.some(row => row.cl !== null) && events.some(row => row.xau !== null);
  const days = new Map<number, { time: number; short: number; clCount: number; xauCount: number }>();
  for (const row of events) {
    const key = Math.floor(row.time / (24 * HOUR)) * 24 * HOUR;
    const day = days.get(key) ?? { time: row.time, short: 0, clCount: 0, xauCount: 0 };
    // An absent leg has no returned event here; it is never presented as a zero fee.
    if (row.xau !== null) { day.short += row.xau / 2; day.xauCount++; }
    if (row.cl !== null) { day.short -= row.cl / 2; day.clCount++; }
    day.time = row.time; days.set(key, day);
  }
  let sum = 0, previous = -Infinity;
  const points: { time: number; shortAnnualized: number | null; longAnnualized: number | null; shortRate: number | null; longRate: number | null }[] = [];
  for (const [dayStart, day] of days) {
    sum += day.short;
    if (dayStart - previous > 24 * HOUR && previous !== -Infinity) points.push({ time: previous + 24 * HOUR, shortAnnualized: null, longAnnualized: null, shortRate: null, longRate: null });
    previous = dayStart;
    const until = Math.min(end, dayStart + 24 * HOUR), elapsed = (until - start) / HOUR, dayHours = (until - Math.max(start, dayStart)) / HOUR;
    const annual = covered && hasBoth && elapsed > 0 ? sum / elapsed * 8760 : null, rate = covered && hasBoth && dayHours > 0 ? day.short / dayHours : null;
    points.push({ time: day.time, shortAnnualized: annual, longAnnualized: annual === null ? null : -annual, shortRate: rate, longRate: rate === null ? null : -rate });
  }
  const annualized = covered && hasBoth ? sum / ((end - start) / HOUR) * 8760 : null;
  return { covered, points, events, shortCumulative: events.length ? sum : null, longCumulative: events.length ? -sum : null, shortAnnualized: annualized, longAnnualized: annualized === null ? null : -annualized, clCount: events.filter(row => row.cl !== null).length, xauCount: events.filter(row => row.xau !== null).length };
}

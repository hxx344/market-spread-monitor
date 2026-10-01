import { comparisonExchanges, exchangeDefinition, type Exchange } from './exchange-quotes.ts';

export const HISTORY_REFRESH_MS = 300_000;
export const HISTORY_STALE_MS = HISTORY_REFRESH_MS * 2 + 15_000;
export const HISTORY_WINDOW_MS = 7 * 24 * 3_600_000;
export const HISTORY_LEG_LIMIT = 20;
export type SettledFundingRecord = { time: number; rate: number };
export type ExchangeFundingHistory = {
  exchange: Exchange;
  monitorId: 'oil';
  currency: 'USD' | 'USDT' | 'USDC';
  fetchedAt: string;
  status: 'live' | 'snapshot';
  availability: 'supported' | 'unsupported';
  reason: string;
  left: { symbol: string; fetchedAt: string | null; error: string };
  right: { symbol: string; fetchedAt: string | null; error: string };
  rows: Array<{ time: number; leftRate: number | null; rightRate: number | null }>;
};

export const exchangeFundingAction = (exchange: Exchange) => `exchanges/${exchange}/funding-history`;
export const fundingExchangeFromAction = (action: string): Exchange | null => comparisonExchanges('oil').find(exchange => exchangeFundingAction(exchange) === action) ?? null;

/** Preserve the original settlement timestamps; asynchronous legs are never paired by a time bucket. */
export function normalizeSettledFunding(records: SettledFundingRecord[], now: number): SettledFundingRecord[] {
  const unique = new Map<number, number>();
  for (const { time, rate } of records) {
    if (!Number.isSafeInteger(time) || time < Date.UTC(2020, 0, 1) || typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1) throw new Error('Invalid settled funding record');
    if (time > now || time < now - HISTORY_WINDOW_MS) continue;
    if (unique.has(time) && unique.get(time) !== rate) throw new Error('Conflicting settled funding records');
    unique.set(time, rate);
  }
  return [...unique].sort(([a], [b]) => b - a).slice(0, HISTORY_LEG_LIMIT).map(([time, rate]) => ({ time, rate }));
}

export function validateExchangeFundingHistory(input: unknown, exchange: Exchange): ExchangeFundingHistory {
  const value = input as ExchangeFundingHistory;
  const definition = exchangeDefinition(exchange, 'oil');
  const stamp = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time));
  if (!value || value.exchange !== exchange || value.monitorId !== 'oil' || value.currency !== definition.currency || !stamp(value.fetchedAt) || !['live', 'snapshot'].includes(value.status) || !['supported', 'unsupported'].includes(value.availability) || typeof value.reason !== 'string' || !Array.isArray(value.rows) || value.rows.length > HISTORY_LEG_LIMIT * 2) throw new Error('Invalid exchange funding history');
  if ((exchange === 'variational') !== (value.availability === 'unsupported')) throw new Error('Invalid history availability');
  const now = Date.parse(value.fetchedAt);
  for (const [side, symbol] of [['left', definition.left], ['right', definition.right]] as const) {
    const leg = value[side];
    if (!leg || leg.symbol !== symbol || typeof leg.error !== 'string' || (leg.fetchedAt !== null && (!stamp(leg.fetchedAt) || Date.parse(leg.fetchedAt) > now))) throw new Error('Invalid history leg metadata');
  }
  const seen = new Set<number>(), counts = { left: 0, right: 0 };
  for (const row of value.rows) {
    if (!row || !Number.isSafeInteger(row.time) || row.time < now - HISTORY_WINDOW_MS || row.time > now || seen.has(row.time) || (row.leftRate === null && row.rightRate === null)) throw new Error('Invalid history settlement time');
    seen.add(row.time);
    for (const side of ['left', 'right'] as const) {
      const rate = row[`${side}Rate`];
      if (rate === null) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1 || value[side].fetchedAt === null || row.time > Date.parse(value[side].fetchedAt!) || ++counts[side] > HISTORY_LEG_LIMIT) throw new Error('Invalid settled funding rate');
    }
  }
  if (value.availability === 'unsupported' && (value.rows.length || !value.reason || value.left.fetchedAt !== null || value.right.fetchedAt !== null)) throw new Error('Unsupported history cannot contain settlements');
  return { exchange, monitorId: 'oil', currency: definition.currency, fetchedAt: value.fetchedAt, status: value.status, availability: value.availability, reason: value.reason,
    left: { ...value.left }, right: { ...value.right }, rows: value.rows.map(row => ({ time: row.time, leftRate: row.leftRate, rightRate: row.rightRate })).sort((a, b) => b.time - a.time) };
}

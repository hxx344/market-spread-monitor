import type { FundingHistoryPairRequest, FundingWindowHours, FundingWindowTotal } from './perpetual-funding-history.ts';
import type { PerpetualMarketMetricsLeg } from './perpetual-market-metrics.ts';

export interface ScannerDataPair extends FundingHistoryPairRequest { identity?: string }
export interface ScannerDataRequirements { metrics: boolean; historyHours: FundingWindowHours[] }
export interface PerpetualScannerDataReport {
  schemaVersion: 1;
  generatedAt: number;
  metrics: Record<string, PerpetualMarketMetricsLeg>;
  /** The lexical first contract is the long leg in each canonical result. */
  history: Record<string, Partial<Record<FundingWindowHours, FundingWindowTotal>>>;
  storageError?: string;
  /** Browser queue progress for the entire subscribed candidate set. */
  progress?: { total: number; completed: number; pending: number; deferred: number };
}
export interface ScannerDataRequest extends ScannerDataRequirements { pairs: ScannerDataPair[] }

export function canonicalScannerDataPair(pair: ScannerDataPair): ScannerDataPair {
  const [longKey, shortKey] = [pair.longKey, pair.shortKey].sort();
  return { base: pair.base, longKey, shortKey, ...(pair.identity === undefined ? {} : { identity: pair.identity }) };
}
export function scannerDataPairKey(pair: FundingHistoryPairRequest): string {
  const [first, second] = [pair.longKey, pair.shortKey].sort();
  return JSON.stringify([pair.base, first, second]);
}
export function scannerDataSelectionKey(pairs: ScannerDataPair[]): string {
  const unique = new Map(pairs.map(pair => [scannerDataPairKey(pair), canonicalScannerDataPair(pair)]));
  return JSON.stringify([...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair));
}
export function scannerDataRequirementsKey(requirements: ScannerDataRequirements): string {
  return JSON.stringify({ metrics: requirements.metrics, historyHours: [...new Set(requirements.historyHours)].sort((a, b) => a - b) });
}
/** Consumers never need to infer which direction a cached canonical sum uses. */
export function scannerDataHistoryForPair(report: PerpetualScannerDataReport | null | undefined, pair: FundingHistoryPairRequest, hours: FundingWindowHours): FundingWindowTotal | undefined {
  const value = report?.history[scannerDataPairKey(pair)]?.[hours];
  if (!value || pair.longKey < pair.shortKey) return value;
  return { ...value, longPercent: value.shortPercent, shortPercent: value.longPercent,
    longCount: value.shortCount, shortCount: value.longCount, netPercent: value.netPercent === null ? null : -value.netPercent };
}

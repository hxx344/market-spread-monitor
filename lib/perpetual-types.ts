/** Public perpetual-market snapshot. Rates are decimal fractions; timestamps are epoch ms. */
export type PerpetualExchangeKind = "cex" | "dex";
export type PerpetualExchangeStatus = "connecting" | "live" | "stale" | "error" | "disabled";
export type PerpetualStatus = "live" | "partial" | "snapshot" | "connecting" | "unavailable";

export interface PerpetualExchange {
  id: string;
  name: string;
  kind: PerpetualExchangeKind;
  status: PerpetualExchangeStatus;
  marketCount: number;
  quoteCount: number;
  lastMessageAt: number | null;
  error: string | null;
  freshBookCount?: number;
  staleBookCount?: number;
  missingBookCount?: number;
}

export interface PerpetualQuote {
  exchange: string;
  symbol: string;
  base: string;
  quoteCurrency: string;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  last: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  nextFundingAt: number | null;
  sourceTime: number | null;
  receivedAt: number;
  transport: "ws" | "rest";
  bidAskAt?: number;
  markAt?: number;
  fundingAt?: number;
  displayBase?: string;
  contractUnit?: string;
  collateralCurrency?: string;
  comparable?: boolean;
  /** Official venue lifecycle metadata, independent of price freshness. */
  delisting?: boolean;
  delistingAt?: number | null;
}

export interface PerpetualSnapshot {
  schemaVersion: 1;
  monitorId: "perpetual";
  status: PerpetualStatus;
  generatedAt: number;
  staleAfterMs: number;
  exchanges: PerpetualExchange[];
  quotes: PerpetualQuote[];
  error?: string | null;
  note?: string | null;
  storageError?: string | null;
  streamId?: string;
  sequence?: number;
}

export interface PerpetualDelta extends Omit<PerpetualSnapshot, "quotes"> {
  type: "delta";
  updates: PerpetualQuote[];
  removed: string[];
}

export interface PerpetualPatch extends Omit<PerpetualSnapshot, "quotes"> {
  type: "patch";
  streamId: string;
  baseSequence: number;
  sequence: number;
  patches: [string, { [K in keyof PerpetualQuote]?: PerpetualQuote[K] | null }][];
  removed: string[];
}

export type PerpetualPriceMode = "book" | "mark";
export type PerpetualPairMode = "all" | "cex-dex" | "cex-cex" | "dex-dex";

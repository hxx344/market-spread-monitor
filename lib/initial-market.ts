import type { LiveQuote, MarketData } from "./market";
import type { validateOilHistory, validateOilQuote } from "./market-validation";
import { calculateShortSpreadFunding } from "../modules/oil/hyperliquid.mjs";
import { hynixSummary, oilSummary } from "./monitor-summary.ts";
import { createTrend } from "./monitor-trend.ts";

export type InitialMarketData = {
  renderedAt: number;
  hynix: { quote: LiveQuote | null; history: MarketData | null };
  oil: { quote: (ReturnType<typeof validateOilQuote> & { status: "live" | "snapshot" }) | null; history: ReturnType<typeof validateOilHistory> | null };
};

export function initialSummaries(initial: InitialMarketData | null) {
  const hynix = initial?.hynix, oil = initial?.oil;
  return {
    hynix: hynixSummary(hynix?.quote ?? null, hynix?.quote?.status === "snapshot" ? "行情待更新" : "", createTrend(hynix?.history ? {
      points: hynix.history.points.map(point => ({ time: point.time, value: point.premium })), status: hynix.history.status, fetchedAt: hynix.history.fetchedAt,
    } : undefined, { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" })),
    oil: oilSummary(oil ? {
      status: oil.quote ? oil.quote.status === "snapshot" ? "stale" : "live" : "loading",
      spread: oil.quote ? oil.quote.brent.markPx - oil.quote.wti.markPx : null,
      fundingHourlyRate: oil.quote ? calculateShortSpreadFunding(oil.quote).hourlyRate : null,
      fundingBasis: "quantity", fetchedAt: oil.quote?.fetchedAt ?? null,
      history: oil.history ? { points: oil.history.data.filter(row => row.brent !== null && row.wti !== null).map(row => ({ time: Date.parse(row.date), value: row.brent! - row.wti! })), status: oil.history.status, fetchedAt: oil.history.metadata.fetchedAt } : undefined,
    } : undefined),
  };
}

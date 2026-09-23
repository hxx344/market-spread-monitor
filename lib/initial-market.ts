import type { LiveQuote, MarketData } from "./market";
import type { validateOilHistory, validateOilQuote } from "./market-validation";
import { calculateShortSpreadFunding } from "../modules/oil/binance.mjs";
import { hynixSummary, oilSummary } from "./monitor-summary.ts";
import { createTrend } from "./monitor-trend.ts";
import { binanceOilExchangeQuote, type ExternalQuoteSet } from "./exchange-quotes.ts";
import { intradayChartRows, type createIntradaySnapshot } from "../modules/oil/intraday.mjs";
import { oilSpreadPercent } from "../modules/oil/spread.mjs";

export type InitialMarketData = {
  renderedAt: number;
  hynix: { quote: LiveQuote | null; history: MarketData | null; exchanges?: ExternalQuoteSet };
  oil: { quote: (ReturnType<typeof validateOilQuote> & { status: "live" | "snapshot" }) | null; history?: ReturnType<typeof validateOilHistory> | null; candles?: ReturnType<typeof createIntradaySnapshot> | null; exchanges?: ExternalQuoteSet };
};

export function initialSummaries(initial: InitialMarketData | null) {
  const hynix = initial?.hynix, oil = initial?.oil;
  return {
    hynix: hynixSummary(hynix?.quote ?? null, hynix?.quote?.status === "snapshot" ? "行情待更新" : "", createTrend(hynix?.history ? {
      points: hynix.history.points.map(point => ({ time: point.time, value: point.premium })), status: hynix.history.status, fetchedAt: hynix.history.fetchedAt,
    } : undefined, { days: 7, intervalMs: 3_600_000, label: "7 天小时线", shortLabel: "7天", unit: "%" })),
    oil: oilSummary(oil ? {
      status: oil.quote ? oil.quote.status === "snapshot" ? "stale" : "live" : "loading",
      spread: oil.quote ? oilSpreadPercent(oil.quote.brent.markPx, oil.quote.wti.markPx) : null,
      fundingHourlyRate: oil.quote ? calculateShortSpreadFunding(oil.quote).hourlyRate : null,
      fundingBasis: "quantity", fetchedAt: oil.quote?.fetchedAt ?? null,
      comparison: oil.quote ? binanceOilExchangeQuote(oil.quote, oil.quote.status === "snapshot") : undefined,
      history: oil.candles ? { points: intradayChartRows(oil.candles).map(row => ({ time: row.time, value: row.spread })), status: oil.candles.status, fetchedAt: oil.candles.metadata.fetchedAt } : undefined,
    } : undefined),
  };
}

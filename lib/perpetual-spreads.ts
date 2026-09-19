import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from "./perpetual-types.ts";

export interface PerpetualFilters {
  search: string;
  exchanges: string[] | null;
  pairMode: PerpetualPairMode;
  priceMode: PerpetualPriceMode;
  crossCurrency: boolean;
  minSpreadPercent: number;
  favoritesOnly: boolean;
  favorites: string[];
}

export interface PerpetualSpread {
  base: string;
  long: PerpetualQuote;
  short: PerpetualQuote;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  /** Short funding income minus long funding expense, normalized to eight hours. */
  fundingSpread8h: number | null;
  updatedAt: number;
  crossCurrency: boolean;
}

const stableQuotes = new Set(["USD", "USDT", "USDC", "USD1", "USDG"]);
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

export function quotePriceTime(quote: PerpetualQuote, mode: PerpetualPriceMode): number {
  const priceTime = mode === "book" ? quote.bidAskAt : quote.markAt;
  // A recent funding or ticker message must never make an older order book fresh.
  return typeof priceTime === "number" ? Math.min(priceTime, quote.receivedAt) : NaN;
}

export function quoteIsFresh(quote: PerpetualQuote, mode: PerpetualPriceMode, now: number, staleAfterMs: number): boolean {
  const timestamp = quotePriceTime(quote, mode);
  return Number.isFinite(timestamp) && Number.isFinite(now) && staleAfterMs > 0 && timestamp > 0 && timestamp <= now + 5_000 && now - timestamp <= staleAfterMs;
}

export function normalizedFunding8h(quote: PerpetualQuote, now?: number): number | null {
  if (quote.fundingRate === null || !Number.isFinite(quote.fundingRate) || !positive(quote.fundingIntervalHours)) return null;
  if (now !== undefined && (!quote.fundingAt || now - quote.fundingAt > 300_000 || quote.fundingAt > now + 5_000)) return null;
  return quote.fundingRate * 8 / quote.fundingIntervalHours;
}

export function quotePrice(quote: PerpetualQuote, mode: PerpetualPriceMode, side: "buy" | "sell"): number | null {
  if (mode === "mark") return positive(quote.mark) ? quote.mark : null;
  // Crossed books indicate an incomplete or invalid upstream update.
  if (positive(quote.bid) && positive(quote.ask) && quote.bid > quote.ask) return null;
  const price = side === "buy" ? quote.ask : quote.bid;
  return positive(price) ? price : null;
}

function compatiblePair(long: PerpetualExchange, short: PerpetualExchange, mode: PerpetualPairMode): boolean {
  if (long.id === short.id) return false;
  if (mode === "cex-dex") return long.kind !== short.kind;
  if (mode === "cex-cex") return long.kind === "cex" && short.kind === "cex";
  if (mode === "dex-dex") return long.kind === "dex" && short.kind === "dex";
  return true;
}

export function rankPerpetualSpreads(snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number): PerpetualSpread[] {
  if (snapshot.status === "unavailable") return [];
  const venues = new Map(snapshot.exchanges.map(exchange => [exchange.id, exchange]));
  const selected = filters.exchanges === null ? null : new Set(filters.exchanges);
  const favorites = new Set(filters.favorites);
  const search = filters.search.trim().toUpperCase();
  const groups = new Map<string, PerpetualQuote[]>();
  for (const quote of snapshot.quotes) {
    const venue = venues.get(quote.exchange);
    if (!venue || venue.status !== "live" || quote.comparable === false) continue;
    if (selected && !selected.has(quote.exchange)) continue;
    if (search && !quote.base.includes(search)) continue;
    if (filters.favoritesOnly && !favorites.has(quote.base)) continue;
    if (!quoteIsFresh(quote, filters.priceMode, now, snapshot.staleAfterMs)) continue;
    const group = groups.get(quote.base);
    if (group) group.push(quote); else groups.set(quote.base, [quote]);
  }
  const rows: PerpetualSpread[] = [];
  for (const [base, quotes] of groups) {
    let best: PerpetualSpread | null = null;
    for (const long of quotes) {
      const buyPrice = quotePrice(long, filters.priceMode, "buy");
      if (buyPrice === null) continue;
      for (const short of quotes) {
        if (!compatiblePair(venues.get(long.exchange)!, venues.get(short.exchange)!, filters.pairMode)) continue;
        if (Math.abs(quotePriceTime(long, filters.priceMode) - quotePriceTime(short, filters.priceMode)) > 5_000) continue;
        const crossCurrency = long.quoteCurrency !== short.quoteCurrency;
        if (crossCurrency && (!filters.crossCurrency || !stableQuotes.has(long.quoteCurrency) || !stableQuotes.has(short.quoteCurrency))) continue;
        const sellPrice = quotePrice(short, filters.priceMode, "sell");
        if (sellPrice === null) continue;
        const spreadPercent = (sellPrice / buyPrice - 1) * 100;
        if (!Number.isFinite(spreadPercent) || spreadPercent < filters.minSpreadPercent || (best && spreadPercent <= best.spreadPercent)) continue;
        const longFunding = normalizedFunding8h(long, now), shortFunding = normalizedFunding8h(short, now);
        best = { base, long, short, buyPrice, sellPrice, spreadPercent, fundingSpread8h: longFunding === null || shortFunding === null ? null : shortFunding - longFunding,
          updatedAt: Math.min(quotePriceTime(long, filters.priceMode), quotePriceTime(short, filters.priceMode)), crossCurrency };
      }
    }
    if (best) rows.push(best);
  }
  return rows.sort((a, b) => b.spreadPercent - a.spreadPercent || a.base.localeCompare(b.base));
}

/** Metadata-only frames reuse the ranking until a price or funding validity boundary is crossed. */
export function createPerpetualRankingSelector() {
  let previousQuotes: PerpetualQuote[] | null = null;
  let previousFilters: PerpetualFilters | null = null;
  let previousVenues = "";
  let previousStatus = "";
  let previousStaleAfter = 0;
  let previousNow = 0;
  let nextExpiry = Infinity;
  let result: PerpetualSpread[] = [];
  return (snapshot: PerpetualSnapshot, filters: PerpetualFilters, now: number): PerpetualSpread[] => {
    const venueKey = snapshot.exchanges.map(exchange => `${exchange.id}:${exchange.kind}:${exchange.status}`).join("|");
    const statusKey = snapshot.status === "unavailable" ? "unavailable" : "available";
    if (snapshot.quotes === previousQuotes && filters === previousFilters && venueKey === previousVenues && statusKey === previousStatus
      && snapshot.staleAfterMs === previousStaleAfter && now >= previousNow && now < nextExpiry) return result;
    result = rankPerpetualSpreads(snapshot, filters, now);
    previousQuotes = snapshot.quotes; previousFilters = filters; previousVenues = venueKey;
    previousStatus = statusKey; previousStaleAfter = snapshot.staleAfterMs; previousNow = now;
    nextExpiry = Infinity;
    for (const quote of snapshot.quotes) {
      const priceTime = quotePriceTime(quote, filters.priceMode);
      const priceExpiry = priceTime + snapshot.staleAfterMs + 1;
      if (priceExpiry > now) nextExpiry = Math.min(nextExpiry, priceExpiry);
      if (priceTime > now + 5_000) nextExpiry = Math.min(nextExpiry, priceTime - 5_000);
      if (quote.fundingAt && quote.fundingAt + 300_001 > now) nextExpiry = Math.min(nextExpiry, quote.fundingAt + 300_001);
    }
    return result;
  };
}

export const defaultPerpetualFilters: PerpetualFilters = {
  search: "", exchanges: null, pairMode: "all", priceMode: "book", crossCurrency: false,
  minSpreadPercent: 0, favoritesOnly: false, favorites: [],
};

/** Versioned browser preferences are untrusted and may have been written by an older release. */
export function parsePerpetualPreferences(value: string | null): PerpetualFilters {
  if (!value) return { ...defaultPerpetualFilters, favorites: [] };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || parsed.version !== 1) return { ...defaultPerpetualFilters, favorites: [] };
    const strings = (items: unknown): string[] => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string" && item.length <= 80))].slice(0, 1000) : [];
    return {
      search: typeof parsed.search === "string" ? parsed.search.slice(0, 40) : "",
      exchanges: Array.isArray(parsed.exchanges) ? strings(parsed.exchanges) : null,
      pairMode: ["all", "cex-dex", "cex-cex", "dex-dex"].includes(parsed.pairMode) ? parsed.pairMode : "all",
      priceMode: parsed.priceMode === "mark" ? "mark" : "book",
      crossCurrency: parsed.crossCurrency === true,
      minSpreadPercent: typeof parsed.minSpreadPercent === "number" && Number.isFinite(parsed.minSpreadPercent) ? Math.min(1000, Math.max(-100, parsed.minSpreadPercent)) : 0,
      favoritesOnly: parsed.favoritesOnly === true,
      favorites: strings(parsed.favorites),
    };
  } catch { return { ...defaultPerpetualFilters, favorites: [] }; }
}

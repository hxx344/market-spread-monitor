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
  const groups = new Map<string, { quote: PerpetualQuote; venue: PerpetualExchange; time: number; buy: number | null; sell: number | null; funding: number | null }[]>();
  for (const quote of snapshot.quotes) {
    const venue = venues.get(quote.exchange);
    if (!venue || venue.status !== "live" || quote.comparable === false) continue;
    if (selected && !selected.has(quote.exchange)) continue;
    if (search && !quote.base.includes(search)) continue;
    if (filters.favoritesOnly && !favorites.has(quote.base)) continue;
    if (!quoteIsFresh(quote, filters.priceMode, now, snapshot.staleAfterMs)) continue;
    const ready = { quote, venue, time: quotePriceTime(quote, filters.priceMode), buy: quotePrice(quote, filters.priceMode, "buy"), sell: quotePrice(quote, filters.priceMode, "sell"), funding: normalizedFunding8h(quote, now) };
    const group = groups.get(quote.base);
    if (group) group.push(ready); else groups.set(quote.base, [ready]);
  }
  const rows: PerpetualSpread[] = [];
  for (const [base, quotes] of groups) {
    let best: PerpetualSpread | null = null;
    for (const longLeg of quotes) {
      const long = longLeg.quote;
      const buyPrice = longLeg.buy;
      if (buyPrice === null) continue;
      for (const shortLeg of quotes) {
        const short = shortLeg.quote;
        if (!compatiblePair(longLeg.venue, shortLeg.venue, filters.pairMode)) continue;
        if (Math.abs(longLeg.time - shortLeg.time) > 5_000) continue;
        const crossCurrency = long.quoteCurrency !== short.quoteCurrency;
        if (crossCurrency && (!filters.crossCurrency || !stableQuotes.has(long.quoteCurrency) || !stableQuotes.has(short.quoteCurrency))) continue;
        const sellPrice = shortLeg.sell;
        if (sellPrice === null) continue;
        const spreadPercent = (sellPrice / buyPrice - 1) * 100;
        if (!Number.isFinite(spreadPercent) || spreadPercent < filters.minSpreadPercent || (best && spreadPercent <= best.spreadPercent)) continue;
        const longFunding = longLeg.funding, shortFunding = shortLeg.funding;
        best = { base, long, short, buyPrice, sellPrice, spreadPercent, fundingSpread8h: longFunding === null || shortFunding === null ? null : shortFunding - longFunding,
          updatedAt: Math.min(longLeg.time, shortLeg.time), crossCurrency };
      }
    }
    if (best) rows.push(best);
  }
  return rows.sort((a, b) => b.spreadPercent - a.spreadPercent || a.base.localeCompare(b.base));
}

export interface PerpetualQuoteSelection {
  byKey: Map<string, PerpetualQuote>;
  keys: string[];
  baseCount: number;
}

/** Price updates replace values, not the alphabetical market ordering or filter membership. */
export function createPerpetualQuoteSelector() {
  let previousQuotes: PerpetualQuote[] | null = null;
  let byKey = new Map<string, PerpetualQuote>();
  let order: string[] = [];
  let baseCount = 0;
  let search = "", exchanges: string[] | null | undefined, favorites: string[] | undefined, favoritesOnly = false;
  let keys: string[] = [];
  return (quotes: PerpetualQuote[], filters: PerpetualFilters): PerpetualQuoteSelection => {
    let catalogChanged = previousQuotes === null;
    if (quotes !== previousQuotes) {
      const next = new Map<string, PerpetualQuote>();
      for (const quote of quotes) {
        const key = `${quote.exchange}:${quote.symbol}`, previous = byKey.get(key);
        if (!previous || previous.base !== quote.base || previous.displayBase !== quote.displayBase) catalogChanged = true;
        next.set(key, quote);
      }
      if (next.size !== byKey.size) catalogChanged = true;
      byKey = next;
      previousQuotes = quotes;
      if (catalogChanged) {
        order = [...next.keys()].sort((a, b) => { const left = next.get(a)!, right = next.get(b)!; return left.base.localeCompare(right.base) || left.exchange.localeCompare(right.exchange) || left.symbol.localeCompare(right.symbol); });
        baseCount = new Set(quotes.map(quote => quote.base)).size;
      }
    }
    const nextSearch = filters.search.trim().toUpperCase();
    if (catalogChanged || search !== nextSearch || exchanges !== filters.exchanges || favorites !== filters.favorites || favoritesOnly !== filters.favoritesOnly) {
      search = nextSearch; exchanges = filters.exchanges; favorites = filters.favorites; favoritesOnly = filters.favoritesOnly;
      const selected = exchanges === null ? null : new Set(exchanges);
      const starred = new Set(favorites);
      keys = order.filter(key => {
        const quote = byKey.get(key)!;
        return (!selected || selected.has(quote.exchange)) && (!favoritesOnly || starred.has(quote.base))
          && (!search || `${quote.base} ${quote.displayBase ?? ""} ${quote.symbol}`.toUpperCase().includes(search));
      });
    }
    return { byKey, keys, baseCount };
  };
}

/** Missing prices are unavailable, not stale; both stay out of executable rankings. */
export function classifyPerpetualQuote(quote: PerpetualQuote, mode: PerpetualPriceMode, now: number, staleAfterMs: number): "fresh" | "stale" | "unavailable" {
  const time = quotePriceTime(quote, mode);
  if (!Number.isFinite(time) || time <= 0 || time > now + 5_000 || (quotePrice(quote, mode, "buy") === null && quotePrice(quote, mode, "sell") === null)) return "unavailable";
  return now - time > staleAfterMs ? "stale" : "fresh";
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

import { getMonitor } from "./monitors.ts";
import { loadQuote } from "./quote-service.ts";
import { loadMarket } from "./market-service.ts";
import { loadHynixFunding } from "./hynix-funding-service.ts";
import { fetchMarket, fetchSnapshot } from "../modules/oil/hyperliquid.mjs";
import { fetchFundingSnapshot } from "../modules/oil/funding-history.mjs";
import oilArchive from "../public/oil/data/hyperliquid-2026.json" with { type: "json" };
import fundingArchive from "../public/oil/data/hyperliquid-funding-2026.json" with { type: "json" };
import { exchangeFromAction, type SpreadMarket } from "./exchange-quotes.ts";
import { readExchangeQuote } from "./exchange-service.ts";

export interface DataAdapter {
  quote: () => Promise<unknown>;
  history: () => Promise<unknown>;
  funding?: () => Promise<unknown>;
}
/** Add a data adapter here and a descriptor in monitors.ts to expose a new module. */
export const dataAdapters: Record<string, DataAdapter> = {
  hynix: { quote: loadQuote, history: loadMarket, funding: loadHynixFunding },
  oil: {
    quote: fetchMarket,
    async history() {
      try { return { ...await fetchSnapshot(), status: "live" }; }
      catch { return { ...oilArchive, status: "snapshot" }; }
    },
    async funding() {
      try { return { ...await fetchFundingSnapshot(fundingArchive), status: "live" }; }
      catch { return { ...fundingArchive, status: "snapshot" }; }
    },
  },
};

export function createDataReader(adapters = dataAdapters, clock = Date.now, exchangeReader = readExchangeQuote) {
  const cache = new Map<string, { value: unknown; until: number }>();
  const pending = new Map<string, Promise<unknown>>();
  return async function read(id: string, action: string) {
    const exchange = exchangeFromAction(action);
    if (!getMonitor(id) || !Object.hasOwn(adapters, id) || (!["quote", "history", "funding"].includes(action) && !exchange)) throw new Error("Unknown monitor action");
    const loader = exchange ? () => exchangeReader(exchange, id as SpreadMarket) : adapters[id][action as keyof DataAdapter];
    if (!loader) throw new Error("Unsupported monitor capability");
    const key = `${id}/${action}`, previous = cache.get(key);
    if (previous && clock() < previous.until) return previous.value;
    if (!pending.has(key)) {
      const request = Promise.resolve().then(loader).then(value => {
        const snapshot = (value as { status?: string })?.status === "snapshot";
        const ttl = snapshot ? 15_000 : action === "quote" || exchange ? 5_000 : action === "history" ? 60_000 : 300_000;
        cache.set(key, { value, until: clock() + ttl });
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    // Failed live quotes reject. Old values are never timestamped as fresh.
    return pending.get(key)!;
  };
}
export const readMonitorData = createDataReader();

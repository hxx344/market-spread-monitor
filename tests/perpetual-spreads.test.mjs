import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPerpetualQuote, createPerpetualQuoteSelector, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, quoteIsFresh, rankPerpetualSpreads } from "../lib/perpetual-spreads.ts";

const now = 1_800_000_000_000;
const venue = (id, kind = "cex", status = "live") => ({ id, name: id, kind, status, marketCount: 1, quoteCount: 1, lastMessageAt: now, error: null });
const quote = (exchange, overrides = {}) => ({ exchange, symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: now + 3600000, sourceTime: now, receivedAt: now, transport: "ws", bidAskAt: now, markAt: now, fundingAt: now, ...overrides });
const snapshot = (quotes, exchanges = [venue("a"), venue("b"), venue("c", "dex")]) => ({ schemaVersion: 1, monitorId: "perpetual", status: "live", generatedAt: now, staleAfterMs: 30000, exchanges, quotes });
const rank = (data, filters = {}) => rankPerpetualSpreads(data, { ...defaultPerpetualFilters, ...filters }, now);

test("perpetual ranking uses buy ask / sell bid on different venues, not mark or last", () => {
  const rows = rank(snapshot([quote("a", { mark: 200 }), quote("b", { bid: 102, ask: 103, mark: 90 }), quote("a", { symbol: "BTCUSDC", quoteCurrency: "USDC", bid: 150, ask: 151 })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].long.exchange, "a"); assert.equal(rows[0].short.exchange, "b");
  assert.ok(Math.abs(rows[0].spreadPercent - 2) < 1e-10);
  assert.equal(rank(snapshot([quote("a"), quote("a", { bid: 102, ask: 103 })])).length, 0);
});

test("quote currencies stay separate by default; explicit stable currency comparison is flagged", () => {
  const data = snapshot([quote("a"), quote("c", { quoteCurrency: "USDC", bid: 102, ask: 103 })]);
  assert.equal(rank(data).length, 0);
  assert.equal(rank(data, { crossCurrency: true })[0].crossCurrency, true);
  assert.equal(rank(snapshot([quote("a"), quote("c", { quoteCurrency: "BTC", bid: 102, ask: 103 })]), { crossCurrency: true }).length, 0);
});

test("stale books, unavailable venues, future timestamps and crossed books cannot enter ranking", () => {
  for (const overrides of [{ bidAskAt: now - 30001 }, { bidAskAt: undefined }, { bidAskAt: now - 5001 }, { bidAskAt: now + 10000, receivedAt: now + 10000 }, { bid: 110, ask: 109 }, { bid: Infinity }, { bid: -1 }, { comparable: false }]) {
    assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, ...overrides })])).length, 0);
  }
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })], [venue("a"), venue("b", "cex", "error")])).length, 0);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })], [venue("a"), venue("b", "cex", "connecting")])).length, 0);
  assert.equal(quoteIsFresh(quote("a", { markAt: now - 30001 }), "mark", now, 30000), false);
  assert.equal(quoteIsFresh(quote("a", { bidAskAt: now - 30000 }), "book", now, 30000), true);
});

test("funding carry converts each leg by its actual period and leaves missing data unknown", () => {
  const rows = rank(snapshot([quote("a", { fundingRate: 0.0001, fundingIntervalHours: 1 }), quote("b", { bid: 102, ask: 103, fundingRate: 0.0004, fundingIntervalHours: 4 })]));
  assert.equal(rows[0].fundingSpread8h, 0);
  assert.equal(normalizedFunding8h(quote("a", { fundingIntervalHours: null })), null);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: null })), null);
  assert.equal(normalizedFunding8h(quote("a", { fundingRate: -0.0001, fundingIntervalHours: 1 })), -0.0008);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, fundingRate: null })]))[0].fundingSpread8h, null);
  assert.equal(rank(snapshot([quote("a"), quote("b", { bid: 102, ask: 103, fundingAt: now - 300001 })]))[0].fundingSpread8h, null);
});

test("pair filters choose the best compatible pair, and selecting no exchange shows no rows", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 110, ask: 111 }), quote("c", { bid: 105, ask: 106 })]);
  assert.equal(rank(data, { pairMode: "cex-dex" })[0].short.exchange, "c");
  assert.equal(rank(data, { pairMode: "cex-dex" })[0].long.exchange, "a");
  assert.equal(rank(data, { pairMode: "dex-dex" }).length, 0);
  assert.equal(rank(data, { exchanges: [] }).length, 0);
  assert.equal(rank(data, { exchanges: ["a", "c"] })[0].short.exchange, "c");
  assert.equal(rank(data, { minSpreadPercent: 11 }).length, 0);
  assert.equal(rank(data, { search: " eth " }).length, 0);
  assert.equal(rank(data, { favoritesOnly: true, favorites: ["ETH"] }).length, 0);
});

test("mark ranking requires fresh mark prices and never falls back to last or book", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 99, ask: 100, mark: 105 })]);
  assert.equal(rank(data).length, 0);
  assert.equal(rank(data, { priceMode: "mark" })[0].sellPrice, 105);
  assert.equal(rank(snapshot([quote("a"), quote("b", { mark: null, last: 120 })]), { priceMode: "mark" }).length, 0);
});

test("one row per normalized base ranks by best compatible spread and validates persisted filters", () => {
  const data = snapshot([quote("a"), quote("b", { bid: 102, ask: 103 }), quote("a", { quoteCurrency: "USDC" }), quote("c", { quoteCurrency: "USDC", bid: 104, ask: 105 })]);
  assert.equal(rank(data).length, 1); assert.equal(rank(data)[0].short.exchange, "c");
  assert.deepEqual(parsePerpetualPreferences("not json"), defaultPerpetualFilters);
  assert.deepEqual(parsePerpetualPreferences('{"version":1,"exchanges":["a","a",null],"crossCurrency":"true","minSpreadPercent":5000}').exchanges, ["a"]);
  assert.equal(parsePerpetualPreferences('{"version":1,"crossCurrency":"true"}').crossCurrency, false);
});

test("ranking cache ignores metadata frames but invalidates at price expiry and venue outages", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([quote("a"), quote("b", { bid: 102, ask: 103 })]);
  const first = select(data, defaultPerpetualFilters, now);
  assert.equal(select({ ...data, generatedAt: now + 1000 }, defaultPerpetualFilters, now + 1000), first);
  assert.equal(select(data, defaultPerpetualFilters, now + 30000), first);
  assert.equal(select(data, defaultPerpetualFilters, now + 30001).length, 0);
  const offline = { ...data, exchanges: [venue("a"), venue("b", "cex", "error")] };
  assert.equal(select(offline, defaultPerpetualFilters, now).length, 0);
});

test("ranking cache expires funding independently without removing valid price opportunities", () => {
  const select = createPerpetualRankingSelector();
  const data = snapshot([quote("a", { fundingAt: now - 300000 }), quote("b", { bid: 102, ask: 103 })]);
  assert.equal(select(data, defaultPerpetualFilters, now)[0].fundingSpread8h, 0);
  const next = select(data, defaultPerpetualFilters, now + 1);
  assert.equal(next.length, 1); assert.equal(next[0].fundingSpread8h, null);
});

test("missing order books are unavailable, while only genuinely aged price observations are stale", () => {
  assert.equal(classifyPerpetualQuote(quote("a", { bidAskAt: undefined, bid: null, ask: null }), "book", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a", { bidAskAt: now - 30001 }), "book", now, 30000), "stale");
  assert.equal(classifyPerpetualQuote(quote("a", { bid: 102, ask: 101 }), "book", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a", { mark: null }), "mark", now, 30000), "unavailable");
  assert.equal(classifyPerpetualQuote(quote("a"), "book", now, 30000), "fresh");
});

test("price changes preserve alphabetical selection keys; catalog, search and exchange changes invalidate membership", () => {
  const select = createPerpetualQuoteSelector();
  const data = [quote("b"), quote("a", { base: "ETH", symbol: "ETHUSDT" }), quote("c")];
  const first = select(data, defaultPerpetualFilters);
  assert.deepEqual(first.keys, ["b:BTCUSDT", "c:BTCUSDT", "a:ETHUSDT"]); assert.equal(first.baseCount, 2);
  const changed = select(data.map(item => ({ ...item, bid: 200, receivedAt: now + 1 })), defaultPerpetualFilters);
  assert.equal(changed.keys, first.keys); assert.equal(changed.byKey.get("b:BTCUSDT").bid, 200);
  const filtered = select(data, { ...defaultPerpetualFilters, search: "btc", exchanges: ["b"] });
  assert.deepEqual(filtered.keys, ["b:BTCUSDT"]);
  const added = select([...data, quote("a", { base: "AAA", symbol: "AAAUSDT" })], defaultPerpetualFilters);
  assert.equal(added.keys[0], "a:AAAUSDT"); assert.equal(added.baseCount, 3);
  assert.equal(select([], defaultPerpetualFilters).keys.length, 0);
});

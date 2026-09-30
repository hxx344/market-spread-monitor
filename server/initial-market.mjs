/** Read the same persisted snapshots as the APIs; never start upstream requests. */
export async function readInitialMarket(services) {
  const read = async (id, action) => {
    try { return await services.get(id).handle(action, "GET"); }
    catch { return null; }
  };
  const [hynixQuote, hynixHistory, oilQuote, hynixBybit, hynixBinance, oilBybit, oilBinance, oilCandles, oilHyperliquid, goldOilQuote, goldOilHistory, goldOilFunding] = await Promise.all([
    read("hynix", "quote"), read("hynix", "history"), read("oil", "quote"),
    read("hynix", "exchanges/bybit/quote"), read("hynix", "exchanges/binance/quote"), read("oil", "exchanges/bybit/quote"), read("oil", "exchanges/binance/quote"),
    read("oil", "candles/15m"),
    read('oil', 'exchanges/hyperliquid/quote'),
    read('cl-xau', 'quote'), read('cl-xau', 'history'), read('cl-xau', 'funding'),
  ]);
  return { renderedAt: Date.now(), ...(services.controls ? { runtime: services.controls.view() } : {}), 'cl-xau': { quote: goldOilQuote, history: goldOilHistory, funding: goldOilFunding }, hynix: { quote: hynixQuote, history: hynixHistory, exchanges: { bybit: hynixBybit, binance: hynixBinance } }, oil: { quote: oilQuote, candles: oilCandles, exchanges: { bybit: oilBybit, binance: oilBinance, hyperliquid: oilHyperliquid } } };
}

export function registerInitialMarket(services) {
  const key = Symbol.for("market-monitor.initial-data");
  const provider = () => readInitialMarket(services);
  if (globalThis[key]) throw new Error("Initial market provider already registered");
  globalThis[key] = provider;
  return () => { if (globalThis[key] === provider) delete globalThis[key]; };
}

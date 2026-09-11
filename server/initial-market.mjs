/** Read the same persisted snapshots as the APIs; never start upstream requests. */
export async function readInitialMarket(services) {
  const read = async (id, action) => {
    try { return await services.get(id).handle(action, "GET"); }
    catch { return null; }
  };
  const [hynixQuote, hynixHistory, oilQuote, oilHistory] = await Promise.all([
    read("hynix", "quote"), read("hynix", "history"), read("oil", "quote"), read("oil", "history"),
  ]);
  return { renderedAt: Date.now(), hynix: { quote: hynixQuote, history: hynixHistory }, oil: { quote: oilQuote, history: oilHistory } };
}

export function registerInitialMarket(services) {
  const key = Symbol.for("market-monitor.initial-data");
  const provider = () => readInitialMarket(services);
  if (globalThis[key]) throw new Error("Initial market provider already registered");
  globalThis[key] = provider;
  return () => { if (globalThis[key] === provider) delete globalThis[key]; };
}

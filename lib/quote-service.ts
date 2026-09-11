import { ADR_PER_SHARE, type LiveQuote } from "./market.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadQuote(fetcher: Fetcher = fetch, clock = Date.now): Promise<LiveQuote> {
  const response = await fetcher("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids", dex: "xyz" }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const mids: unknown = await response.json();
  if (!mids || typeof mids !== "object" || Array.isArray(mids)) throw new Error("Invalid quote response");
  const values = mids as Record<string, unknown>;
  const ordinary = Number(values["xyz:SKHX"]);
  const adr = Number(values["xyz:SKHY"]);
  if (![ordinary,adr].every(v => Number.isFinite(v) && v > 0)) throw new Error("Incomplete quote pair");
  const equivalent = ordinary / ADR_PER_SHARE;
  // allMids has no exchange timestamp. This is the time we received the pair.
  return { ordinary, adr, equivalent, spread: adr-equivalent, premium: (adr/equivalent-1)*100, fetchedAt: new Date(clock()).toISOString() };
}

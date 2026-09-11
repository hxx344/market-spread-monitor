import archive from "../data/archive.json" with { type: "json" };
import { alignCandles, FIRST_FULL_HOUR, type Candle, type MarketData } from "./market.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export async function loadMarket(fetcher: Fetcher = fetch, now = Date.now()): Promise<MarketData> {
  const storedOrdinary = archive.ordinary as Candle[];
  const storedAdr = archive.adr as Candle[];
  async function candles(coin: string): Promise<Candle[]> {
    const response = await fetcher("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: FIRST_FULL_HOUR, endTime: now } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!Array.isArray(result) || !result.length || !result.every(c => c && c.s === coin && c.i === "1h" && Number.isFinite(c.t) && Number.isFinite(c.T) && c.T >= c.t && c.T < c.t + 3_600_000 && Number.isFinite(Number(c.c)) && Number(c.c) > 0)) throw new Error("Unexpected candle response");
    return result as Candle[];
  }
  let status: MarketData["status"] = "live";
  let fetchedAt = new Date(now).toISOString();
  let points;
  try {
    const [ordinary, adr] = await Promise.all([candles("xyz:SKHX"), candles("xyz:SKHY")]);
    // Reject a one-sided/misaligned update rather than silently calling it current.
    if (!alignCandles(ordinary, adr, now).length) throw new Error("No shared closed candles");
    points = alignCandles([...storedOrdinary, ...ordinary], [...storedAdr, ...adr], now);
  } catch {
    status = "snapshot";
    fetchedAt = archive.fetchedAt;
    points = alignCandles(storedOrdinary, storedAdr, Math.min(now, Date.parse(fetchedAt)));
  }
  const warnings: string[] = [];
  const gaps = points.slice(1).filter((p,i) => p.time - points[i].time > 3_600_000).length;
  if (gaps) warnings.push(`历史行情存在 ${gaps} 处缺口，图表保留断点；区间均值仅基于可用时段。`);
  if (points.length && now - (points.at(-1)!.time + 3_600_000) > 2 * 3_600_000) warnings.push("最近一个共同小时距今超过 2 小时，请留意行情时间。");
  return { points, fetchedAt, status, interval: "1h", firstAvailable: points.length ? new Date(points[0].time).toISOString() : new Date(FIRST_FULL_HOUR).toISOString(), warnings };
}

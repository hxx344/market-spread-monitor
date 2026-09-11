import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Refresh before the provider's rolling 5,000-hour window leaves the archive.
const file = fileURLToPath(new URL("../data/archive.json", import.meta.url));
const archive = JSON.parse(await readFile(file,"utf8"));
const now = Date.now();
async function read(coin) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({type:"candleSnapshot",req:{coin,interval:"1h",startTime:Date.parse("2026-07-10T14:00:00Z"),endTime:now}}),
    signal:AbortSignal.timeout(15_000),
  });
  if(!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  const candles = await response.json();
  if(!Array.isArray(candles) || !candles.length || !candles.every(c=>c.s===coin && c.i==="1h" && Number.isFinite(c.t) && Number.isFinite(c.T) && c.T>=c.t && c.T<c.t+3_600_000 && Number.isFinite(Number(c.c)) && Number(c.c)>0)) throw new Error("Invalid provider response; archive unchanged");
  return candles.filter(c=>c.T<now);
}
const [ordinary,adr] = await Promise.all([read("xyz:SKHX"),read("xyz:SKHY")]);
const merge=(old,next)=>[...new Map([...old,...next].map(c=>[c.t,c])).values()].sort((a,b)=>a.t-b.t);
const next={...archive,fetchedAt:new Date(now).toISOString(),ordinary:merge(archive.ordinary,ordinary),adr:merge(archive.adr,adr)};
await writeFile(file+".tmp",JSON.stringify(next));
await rename(file+".tmp",file);
console.log(`Archived ${next.ordinary.length} SKHX / ${next.adr.length} SKHY closed hourly candles at ${next.fetchedAt}`);

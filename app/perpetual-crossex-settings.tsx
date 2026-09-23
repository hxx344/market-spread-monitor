"use client";

import { useEffect, useRef, useState } from "react";

interface Settings {
  available: boolean; revision: number; config: { requireSpotTransfer: boolean }; error: string;
  venues: { exchange: string; state: string; checkedAt: number | null; error: string }[];
}
const endpoint = "/api/monitors/perpetual/crossex-settings";
const names: Record<string, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX", gate: "Gate", kraken: "Kraken", hyperliquid: "Hyperliquid", lighter: "Lighter" };
const labels: Record<string, string> = { live: "资料已更新", pending: "待采集", stale: "已过期", error: "读取失败", unsupported: "无法核验" };
async function request(signal: AbortSignal, body?: unknown): Promise<Settings> {
  const response = await fetch(endpoint, { cache: "no-store", signal, ...(body ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json() as Settings;
  if (!response.ok) throw new Error(data?.error || "CrossEx 筛选设置读取失败");
  if (!data || typeof data.available !== "boolean" || !Number.isSafeInteger(data.revision) || typeof data.config?.requireSpotTransfer !== "boolean" || !Array.isArray(data.venues)) throw new Error("CrossEx 筛选响应无效，请升级 Monitor 后重试");
  return data;
}

/** One lightweight settings view; no market polling or chart state ownership. */
export default function PerpetualCrossExSettings({ active }: { active: boolean }) {
  const [data, setData] = useState<Settings | null>(null), [error, setError] = useState(""), [saveError, setSaveError] = useState(""), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const savingRef = useRef(false), generation = useRef(0);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
    const eligible = () => active && !stopped && !document.hidden && navigator.onLine;
    async function read() {
      clearTimeout(timer);
      if (!eligible() || controller || savingRef.current) return;
      const current = new AbortController(), version = generation.current; controller = current;
      try {
        const next = await request(AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]));
        if (!stopped && !current.signal.aborted && generation.current === version) { setData(next); setError(""); }
      } catch (cause) { if (!stopped && !current.signal.aborted && generation.current === version) setError(cause instanceof Error ? cause.message : "读取失败"); }
      finally { controller = null; if (eligible()) timer = setTimeout(read, 15_000); }
    }
    const resume = () => { if (eligible()) void read(); else { clearTimeout(timer); controller?.abort(); } };
    void read();
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("offline", resume);
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", resume); };
  }, [active, saving]);
  async function update(enabled: boolean) {
    if (!data || savingRef.current) return;
    savingRef.current = true; generation.current++; setSaving(true); setSaved(false); setSaveError("");
    try { setData(await request(AbortSignal.timeout(10_000), { revision: data.revision, config: { requireSpotTransfer: enabled } })); setSaved(true); }
    catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存失败");
      // A timeout can occur after the server committed; reload the actual saved state.
      try { setData(await request(AbortSignal.timeout(10_000))); } catch { /* Keep the last confirmed state and visible error. */ }
    } finally { savingRef.current = false; setSaving(false); }
  }
  return <section className="perp-crossex-settings" aria-label="CrossEx 推送筛选">
    <div className="perp-crossex-control"><strong>CrossEx 推送筛选</strong><label><input type="checkbox" checked={data?.config.requireSpotTransfer ?? false} disabled={!data?.available || saving || Boolean(error)} onChange={event => void update(event.target.checked)}/>仅推送双边有现货且共同网络充提正常的机会</label><span role="status">{saving ? "保存中…" : saved ? "已保存到服务器" : data ? data.config.requireSpotTransfer ? "筛选已开启" : "筛选未开启" : "读取设置中…"}</span></div>
    <p>双方均有可交易现货，且至少一条共同网络的充值、提现均开放；代币地址须匹配。未知或过期不推送，页面关闭后仍生效。</p>
    {data?.config.requireSpotTransfer ? <p>已接入 Binance、Gate 公开数据；其他平台当前无法核验，暂不推送。</p> : null}
    {saveError || error || data?.error ? <p role="alert">{saveError || error || data?.error}</p> : null}
    {data?.config.requireSpotTransfer ? <details><summary>公开数据覆盖与核验时间</summary><p>每分钟更新，资料超过 3 分钟失效。此规则用于推送新机会，行情列表仍按上方条件显示。</p><ul>{data.venues.map(venue => <li key={venue.exchange}><strong>{names[venue.exchange] ?? venue.exchange}</strong> · {labels[venue.state] ?? "无法核验"}{venue.checkedAt ? ` · ${new Date(venue.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}{venue.error ? ` · ${venue.error}` : ""}</li>)}</ul></details> : null}
  </section>;
}

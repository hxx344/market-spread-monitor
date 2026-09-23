"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_CROSSEX_BLOCKED_BASES, normalizeCrossExBlockedBases, type CrossExFilterConfig } from "../lib/perpetual-crossex-config";

interface Settings {
  available: boolean; revision: number; config: CrossExFilterConfig; error: string;
  venues: { exchange: string; state: string; checkedAt: number | null; error: string }[];
}
const endpoint = "/api/monitors/perpetual/crossex-settings";
const names: Record<string, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX", gate: "Gate", kraken: "Kraken", hyperliquid: "Hyperliquid", lighter: "Lighter" };
const labels: Record<string, string> = { live: "资料已更新", pending: "待采集", stale: "已过期", error: "读取失败", unsupported: "无法核验" };
async function request(signal: AbortSignal, body?: unknown): Promise<Settings> {
  const response = await fetch(endpoint, { cache: "no-store", signal, ...(body ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json() as Settings;
  if (!response.ok) throw new Error(data?.error || "CrossEx 筛选设置读取失败");
  if (!data || typeof data.available !== "boolean" || !Number.isSafeInteger(data.revision) || typeof data.config?.requireSpotTransfer !== "boolean" || !Array.isArray(data.config.blockedBases) || !Array.isArray(data.venues)) throw new Error("CrossEx 筛选响应无效，请升级 Monitor 后重试");
  return { ...data, config: { ...data.config, blockedBases: normalizeCrossExBlockedBases(data.config.blockedBases) } };
}

/** One lightweight settings view; no market polling or chart state ownership. */
export default function PerpetualCrossExSettings({ active }: { active: boolean }) {
  const [data, setData] = useState<Settings | null>(null), [error, setError] = useState(""), [saveError, setSaveError] = useState(""), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [blockedInput, setBlockedInput] = useState("");
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
  async function update(patch: Partial<CrossExFilterConfig>): Promise<boolean> {
    if (!data || savingRef.current) return false;
    savingRef.current = true; generation.current++; setSaving(true); setSaved(false); setSaveError("");
    try { setData(await request(AbortSignal.timeout(10_000), { revision: data.revision, config: { ...data.config, ...patch } })); setSaved(true); return true; }
    catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存失败");
      // A timeout can occur after the server committed; reload the actual saved state.
      try { setData(await request(AbortSignal.timeout(10_000))); } catch { /* Keep the last confirmed state and visible error. */ }
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }
  async function addBlockedBase() {
    if (!data || savingRef.current) return;
    setSaveError(""); setSaved(false);
    try {
      const base = normalizeCrossExBlockedBases([blockedInput])[0];
      if (data.config.blockedBases.includes(base)) throw new Error(`${base} 已在屏蔽名单中`);
      const blockedBases = normalizeCrossExBlockedBases([...data.config.blockedBases, base]);
      if (await update({ blockedBases })) setBlockedInput("");
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "币种无效"); }
  }
  const disabled = !data?.available || saving || Boolean(error);
  return <section className="perp-crossex-settings" aria-label="CrossEx 推送筛选">
    <div className="perp-crossex-control"><strong>CrossEx 推送筛选</strong><label><input type="checkbox" checked={data?.config.requireSpotTransfer ?? false} disabled={disabled} onChange={event => void update({ requireSpotTransfer: event.target.checked })}/>仅推送双边有现货且共同网络充提正常的机会</label><span role="status">{saving ? "保存中…" : saved ? "已保存到服务器" : data ? data.config.requireSpotTransfer ? "充提筛选已开启" : "充提筛选未开启" : "读取设置中…"}</span></div>
    <p>双方均有可交易现货，且至少一条共同网络的充值、提现均开放；代币地址须匹配。未知或过期不推送，页面关闭后仍生效。</p>
    {data?.config.requireSpotTransfer ? <p>已接入 Binance、Gate 公开数据；其他平台当前无法核验，暂不推送。</p> : null}
    <form className="perp-crossex-block-form" onSubmit={event => { event.preventDefault(); void addBlockedBase(); }}>
      <label htmlFor="crossex-blocked-base">屏蔽币种 <span>{data ? `${data.config.blockedBases.length} / ${MAX_CROSSEX_BLOCKED_BASES}` : ""}</span></label>
      <input id="crossex-blocked-base" value={blockedInput} maxLength={40} placeholder="输入基础币种，如 BTC" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="crossex-blocked-help" disabled={disabled} onChange={event => setBlockedInput(event.target.value)}/>
      <button type="submit" disabled={disabled || !blockedInput.trim()}>添加屏蔽</button>
    </form>
    <p id="crossex-blocked-help">填写 BTC 等基础币种，不填 BTCUSDT。屏蔽该币在所有平台和方向上的新机会，独立于充提开关生效；保存后可随时解除。</p>
    {data?.config.blockedBases.length ? <ul className="perp-crossex-blocked-list" aria-label="已屏蔽币种">{data.config.blockedBases.map(base => <li key={base}><strong>{base}</strong><button type="button" disabled={disabled} aria-label={`解除屏蔽 ${base}`} onClick={() => void update({ blockedBases: data.config.blockedBases.filter(item => item !== base) })}>解除屏蔽</button></li>)}</ul> : data ? <p>尚未屏蔽任何币种</p> : null}
    {saveError || error || data?.error ? <p role="alert">{saveError || error || data?.error}</p> : null}
    {data?.config.requireSpotTransfer ? <details><summary>公开数据覆盖与核验时间</summary><p>每分钟更新，资料超过 3 分钟失效。此规则用于推送新机会，行情列表仍按上方条件显示。</p><ul>{data.venues.map(venue => <li key={venue.exchange}><strong>{names[venue.exchange] ?? venue.exchange}</strong> · {labels[venue.state] ?? "无法核验"}{venue.checkedAt ? ` · ${new Date(venue.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}{venue.error ? ` · ${venue.error}` : ""}</li>)}</ul></details> : null}
  </section>;
}

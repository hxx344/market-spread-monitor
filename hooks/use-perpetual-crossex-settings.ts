"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeCrossExBlockedBases, type CrossExFilterConfig } from "../lib/perpetual-crossex-config";

interface Settings {
  available: boolean; revision: number; config: CrossExFilterConfig; error: string;
  venues: { exchange: string; state: string; checkedAt: number | null; error: string }[];
}
const endpoint = "/api/monitors/perpetual/crossex-settings";
async function request(signal: AbortSignal, body?: unknown): Promise<Settings> {
  const response = await fetch(endpoint, { cache: "no-store", signal, ...(body ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json() as Settings;
  if (!response.ok) throw new Error(data?.error || "CrossEx 筛选设置读取失败");
  if (!data || typeof data.available !== "boolean" || !Number.isSafeInteger(data.revision) || typeof data.config?.requireSpotTransfer !== "boolean" || !Array.isArray(data.config.blockedBases) || !Array.isArray(data.venues)) throw new Error("CrossEx 筛选响应无效，请升级 Monitor 后重试");
  return { ...data, config: { ...data.config, blockedBases: normalizeCrossExBlockedBases(data.config.blockedBases) } };
}

/** One settings reader and write lock shared by the form and every market row. */
export function usePerpetualCrossExSettings(active: boolean) {
  const [data, setData] = useState<Settings | null>(null), [error, setError] = useState(""), [saveError, setSaveError] = useState(""), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [actionBase, setActionBase] = useState("");
  const savingRef = useRef(false), generation = useRef(0);
  const blockedBases = useMemo(() => new Set(data?.config.blockedBases), [data?.config.blockedBases]);
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
  function reportError(message: string, base = "") { setSaveError(message); setActionBase(base); setSaved(false); }
  const disabled = !data?.available || saving || Boolean(error);
  async function update(patch: Partial<CrossExFilterConfig>, base = ""): Promise<boolean> {
    if (!data || disabled || savingRef.current) return false;
    savingRef.current = true; generation.current++; setSaving(true); setSaved(false); setSaveError(""); setActionBase(base);
    try { setData(await request(AbortSignal.timeout(10_000), { revision: data.revision, config: { ...data.config, ...patch } })); setError(""); setSaved(true); return true; }
    catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存失败");
      // A timeout can occur after the server committed; reload the actual saved state.
      try { setData(await request(AbortSignal.timeout(10_000))); setError(""); } catch { /* Keep the last confirmed state and visible error. */ }
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }
  async function setBaseBlocked(input: string, blocked: boolean): Promise<boolean> {
    if (!data || disabled || savingRef.current) return false;
    try {
      const base = normalizeCrossExBlockedBases([input])[0];
      const next = blocked ? [...blockedBases, base] : [...blockedBases].filter(item => item !== base);
      return await update({ blockedBases: normalizeCrossExBlockedBases(next) }, base);
    } catch (cause) { reportError(cause instanceof Error ? cause.message : "币种无效", input); return false; }
  }
  return { data, error, saveError, saving, saved, disabled, blockedBases, actionBase, update, setBaseBlocked, reportError };
}

export type PerpetualCrossExController = ReturnType<typeof usePerpetualCrossExSettings>;

"use client";

import { useEffect, useRef, useState } from "react";
import { qualityRequestKey, startPerpetualQualityFeed, type QualityPairRequest } from "../lib/perpetual-quality-feed";
import type { PerpetualQualityReport } from "../lib/perpetual-quality";

export function usePerpetualQuality(pairs: QualityPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualQualityFeed> | null>(null);
  const requestKey = qualityRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualQualityFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/quality", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("质量资料读取失败");
        const value = await response.json() as PerpetualQualityReport;
        const records = [value?.pairs, value?.assets, value?.assetErrors, value?.positioning, value?.positioningErrors];
        if (value?.schemaVersion !== 1 || !Number.isFinite(value.generatedAt) || records.some(record => !record || typeof record !== "object" || Array.isArray(record))) throw new Error("质量资料格式异常");
        return value;
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as QualityPairRequest[]); }, [requestKey]);

  useEffect(() => {
    const synchronize = () => controls.current?.setActive(active && !document.hidden && navigator.onLine);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) { controls.current?.setActive(false); synchronize(); } };
    synchronize();
    document.addEventListener("visibilitychange", synchronize);
    window.addEventListener("online", synchronize);
    window.addEventListener("offline", synchronize);
    window.addEventListener("pageshow", restore);
    return () => {
      controls.current?.setActive(false);
      document.removeEventListener("visibilitychange", synchronize);
      window.removeEventListener("online", synchronize);
      window.removeEventListener("offline", synchronize);
      window.removeEventListener("pageshow", restore);
    };
  }, [active]);
  return { report, loading, error };
}

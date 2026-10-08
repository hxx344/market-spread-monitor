"use client";

import { useEffect, useRef, useState } from "react";
import { marketMetricsRequestKey, startPerpetualMarketMetricsFeed } from "../lib/perpetual-market-metrics-feed";
import type { FundingHistoryPairRequest } from "../lib/perpetual-funding-history";
import type { PerpetualMarketMetricsReport } from "../lib/perpetual-market-metrics";

export function usePerpetualMarketMetrics(pairs: FundingHistoryPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualMarketMetricsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualMarketMetricsFeed> | null>(null);
  const requestKey = marketMetricsRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualMarketMetricsFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/metrics", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("市场指标读取失败");
        return await response.json() as PerpetualMarketMetricsReport;
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as FundingHistoryPairRequest[]); }, [requestKey]);
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
  return { report, loading, error: [error, report?.storageError].filter(Boolean).join(" ") };
}

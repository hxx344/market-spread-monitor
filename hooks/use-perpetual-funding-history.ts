"use client";

import { useEffect, useRef, useState } from "react";
import { fundingHistoryRequestKey, startPerpetualFundingHistoryFeed } from "../lib/perpetual-funding-history-feed";
import type { FundingHistoryPairRequest, PerpetualFundingHistoryReport } from "../lib/perpetual-funding-history";

export function usePerpetualFundingHistory(pairs: FundingHistoryPairRequest[], active: boolean) {
  const [report, setReport] = useState<PerpetualFundingHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controls = useRef<ReturnType<typeof startPerpetualFundingHistoryFeed> | null>(null);
  const requestKey = fundingHistoryRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualFundingHistoryFeed({
      load: async (requested, signal) => {
        const response = await fetch("/api/monitors/perpetual/funding-history", {
          method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairs: requested }), signal,
        });
        if (!response.ok) throw new Error("历史结算读取失败");
        return await response.json() as PerpetualFundingHistoryReport;
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
  return { report, loading, error };
}

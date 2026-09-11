"use client";

import { useEffect, useRef, useState } from "react";
import { retainHistoryPoints, type LiveQuote, type MarketData } from "../lib/market";
import { HISTORY_REFRESH_MS, QUOTE_REFRESH_MS, startPolling } from "../lib/polling";

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.any([signal,AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new Error("行情更新失败，将在下一轮自动重试。");
  return response.json();
}

export function useMarketFeed() {
  const [data,setData] = useState<MarketData | null>(null);
  const [quote,setQuote] = useState<LiveQuote | null>(null);
  const [historyLoading,setHistoryLoading] = useState(true);
  const [quoteLoading,setQuoteLoading] = useState(true);
  const [error,setError] = useState("");
  const [quoteError,setQuoteError] = useState("");
  const controls = useRef<{ refresh: () => void } | null>(null);

  useEffect(() => {
    const history = startPolling({
      intervalMs: HISTORY_REFRESH_MS,
      load: async signal => {
        const next = await request<MarketData>("/api/monitors/hynix/history",signal);
        if (!next.points?.length) throw new Error("暂时没有可对齐的历史行情。");
        return next;
      },
      onData: next => { setData(previous => retainHistoryPoints(previous, next)); setError(""); },
      onError: error => setError(error instanceof Error ? error.message : "历史行情加载失败。"),
      onSettled: () => setHistoryLoading(false),
    });
    const live = startPolling({
      intervalMs: QUOTE_REFRESH_MS,
      load: signal => request<LiveQuote>("/api/monitors/hynix/quote",signal),
      onData: next => { setQuote(next); setQuoteError(""); },
      onError: () => setQuoteError("实时报价更新失败，10 秒后自动重试；请留意报价获取时间。"),
      onSettled: () => setQuoteLoading(false),
    });
    controls.current = { refresh: () => { void history.refresh(); void live.refresh(); } };
    return () => { controls.current = null; history.stop(); live.stop(); };
  },[]);

  return {
    data, quote, error, quoteError, loading: historyLoading || quoteLoading,
    refresh: () => { setHistoryLoading(true); setQuoteLoading(true); controls.current?.refresh(); },
  };
}

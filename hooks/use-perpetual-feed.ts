"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startPerpetualFeed, type PerpetualConnection } from "../lib/perpetual-feed";
import type { PerpetualSnapshot } from "../lib/perpetual-types";

export function usePerpetualFeed(active: boolean) {
  const [data, setData] = useState<PerpetualSnapshot | null>(null);
  const [connection, setConnection] = useState<PerpetualConnection>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const controls = useRef<ReturnType<typeof startPerpetualFeed> | null>(null);
  const timeAnchor = useRef<{ server: number; local: number } | null>(null);

  useEffect(() => {
    let clock: ReturnType<typeof setInterval> | undefined;
    function synchronizeVisibility() {
      controls.current?.stop(); controls.current = null;
      clearInterval(clock);
      if (!active || document.hidden) { setConnection("paused"); return; }
      const updateClock = () => {
        const anchor = timeAnchor.current;
        // Incoming frames advance time already. Run the clock only while the stream is quiet.
        if (anchor && performance.now() - anchor.local >= 1_500) setNow(anchor.server + Math.max(0, performance.now() - anchor.local));
      };
      updateClock();
      clock = setInterval(updateClock, 1_000);
      controls.current = startPerpetualFeed({
        fetchSnapshot: async signal => {
          const response = await fetch("/api/monitors/perpetual/quote", { cache: "no-store", signal });
          if (!response.ok) throw new Error("行情更新失败");
          return response.json();
        },
        createStream: () => {
          const source = new EventSource("/api/monitors/perpetual/stream");
          const adapter: { onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null; close: () => void } = { onmessage: null, onerror: null, close: () => source.close() };
          source.onmessage = event => adapter.onmessage?.({ data: event.data });
          source.onerror = () => adapter.onerror?.();
          return adapter;
        },
        onData: snapshot => {
          timeAnchor.current = { server: snapshot.generatedAt, local: performance.now() };
          setNow(snapshot.generatedAt);
          setData(snapshot);
        }, onConnection: setConnection, onError: setError,
      });
    }
    synchronizeVisibility();
    document.addEventListener("visibilitychange", synchronizeVisibility);
    return () => {
      document.removeEventListener("visibilitychange", synchronizeVisibility);
      clearInterval(clock);
      controls.current?.stop(); controls.current = null;
    };
  }, [active]);

  const refresh = useCallback(() => controls.current?.refresh(), []);
  return { data, connection, error, now, refresh };
}

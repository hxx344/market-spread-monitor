"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPerpetualClock, startPerpetualFeed, type PerpetualConnection } from "../lib/perpetual-feed";
import type { PerpetualSnapshot } from "../lib/perpetual-types";

export function usePerpetualFeed(active: boolean) {
  const [data, setData] = useState<PerpetualSnapshot | null>(null);
  const [connection, setConnection] = useState<PerpetualConnection>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const controls = useRef<ReturnType<typeof startPerpetualFeed> | null>(null);
  const [sourceClock] = useState(() => createPerpetualClock());

  useEffect(() => {
    let clock: ReturnType<typeof setInterval> | undefined;
    function synchronizeVisibility() {
      controls.current?.stop(); controls.current = null;
      clearInterval(clock);
      if (!active || document.hidden) { setConnection("paused"); return; }
      const updateClock = () => {
        // Incoming frames advance time already. Run the clock only while the stream is quiet.
        if (sourceClock.quietFor() >= 1_500) setNow(sourceClock.read());
      };
      updateClock();
      clock = setInterval(updateClock, 1_000);
      if (!navigator.onLine) {
        setConnection("error");
        setError("网络已断开，恢复连接后自动更新。");
        return;
      }
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
        onData: (snapshot, context) => {
          setNow(sourceClock.accept(snapshot.generatedAt, snapshot.streamId, context.baseline));
          setData(snapshot);
        }, onConnection: setConnection, onError: setError,
      });
    }
    synchronizeVisibility();
    document.addEventListener("visibilitychange", synchronizeVisibility);
    window.addEventListener("online", synchronizeVisibility);
    window.addEventListener("offline", synchronizeVisibility);
    const restorePage = (event: PageTransitionEvent) => { if (event.persisted) synchronizeVisibility(); };
    window.addEventListener("pageshow", restorePage);
    return () => {
      document.removeEventListener("visibilitychange", synchronizeVisibility);
      window.removeEventListener("online", synchronizeVisibility);
      window.removeEventListener("offline", synchronizeVisibility);
      window.removeEventListener("pageshow", restorePage);
      clearInterval(clock);
      controls.current?.stop(); controls.current = null;
    };
  }, [active, sourceClock]);

  const refresh = useCallback(() => controls.current?.refresh(), []);
  return { data, connection, error, now, refresh };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPerpetualClock, readPerpetualSnapshot, startPerpetualFeed, type PerpetualConnection } from "../lib/perpetual-feed";
import type { PerpetualSnapshot } from "../lib/perpetual-types";
import { backgroundReadDelay, readActivity } from "../lib/read-activity";

export function usePerpetualFeed(active: boolean, paused = false) {
  const [data, setData] = useState<PerpetualSnapshot | null>(null);
  const [connection, setConnection] = useState<PerpetualConnection>("connecting");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const controls = useRef<ReturnType<typeof startPerpetualFeed> | null>(null);
  const [sourceClock] = useState(() => createPerpetualClock());

  useEffect(() => {
    let clock: ReturnType<typeof setInterval> | undefined;
    let background = readActivity.background(document.hidden);
    function synchronizeVisibility(event?: Event) {
      if (event && ['focus', 'pageshow', 'online'].includes(event.type)) { controls.current?.stop(); controls.current = null; }
      clearInterval(clock);
      if (!active || !readActivity.allowed(document.hidden)) { controls.current?.stop(); controls.current = null; setConnection("paused"); return; }
      const previousBackground = background;
      background = readActivity.background(document.hidden);
      if (previousBackground && !background) { controls.current?.stop(); controls.current = null; }
      const updateClock = () => {
        // Incoming frames advance time already. Run the clock only while the stream is quiet.
        if (sourceClock.quietFor() >= 1_500) setNow(sourceClock.read());
      };
      updateClock();
      clock = setInterval(updateClock, backgroundReadDelay(1_000));
      // Inspection stops network work, but source time must still age so a
      // retained quote cannot stay "fresh" indefinitely while the user reads it.
      if (paused) { controls.current?.stop(); controls.current = null; setConnection("paused"); return; }
      if (!navigator.onLine) {
        controls.current?.stop(); controls.current = null;
        setConnection("error");
        setError("网络已断开，恢复连接后自动更新。");
        return;
      }
      if (controls.current) {
        if (!background && (previousBackground || event?.type === 'focus' || event?.type === 'pageshow')) controls.current.refresh();
        return;
      }
      controls.current = startPerpetualFeed({
        fetchSnapshot: readPerpetualSnapshot,
        pollIntervalMs: () => backgroundReadDelay(5_000),
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
    const unsubscribe = readActivity.subscribe(synchronizeVisibility);
    document.addEventListener("visibilitychange", synchronizeVisibility);
    window.addEventListener("online", synchronizeVisibility);
    window.addEventListener("offline", synchronizeVisibility);
    window.addEventListener("focus", synchronizeVisibility);
    window.addEventListener("pageshow", synchronizeVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", synchronizeVisibility);
      window.removeEventListener("online", synchronizeVisibility);
      window.removeEventListener("offline", synchronizeVisibility);
      window.removeEventListener("focus", synchronizeVisibility);
      window.removeEventListener("pageshow", synchronizeVisibility);
      clearInterval(clock);
      controls.current?.stop(); controls.current = null;
    };
  }, [active, paused, sourceClock]);

  const refresh = useCallback(() => controls.current?.refresh(), []);
  return { data, connection, error, now, refresh };
}

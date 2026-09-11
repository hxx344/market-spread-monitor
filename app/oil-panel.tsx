"use client";

import { useEffect, useRef, useState } from "react";
import { mount as mountChart } from "../modules/oil/app.mjs";
import { mount as mountAlerts } from "../modules/oil/alerts.mjs";
type Mounted = { dispose: () => void };

export default function OilPanel() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const node = host.current!;
    const root = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    const mounted: Mounted[] = [];
    async function load() {
      try {
        const responses = await Promise.all(["/oil/panel.html", "/oil/styles.css"].map(url => fetch(url, { signal: controller.signal })));
        if (responses.some(response => !response.ok)) throw new Error("原油面板加载失败，请刷新页面重试。");
        const [html, css] = await Promise.all(responses.map(response => response.text()));
        controller.signal.throwIfAborted();
        // This markup is a checked-in first-party asset, never user/API HTML.
        root.innerHTML = `<style>${css}</style>${html}`;
        mounted.push(mountChart(root));
        mounted.push(mountAlerts(root));
        root.querySelectorAll<HTMLAnchorElement>("[data-local-anchor]").forEach(anchor => anchor.addEventListener("click", event => { event.preventDefault(); root.getElementById(anchor.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }); }, { signal: controller.signal }));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "原油面板加载失败。");
      }
    }
    void load();
    return () => { controller.abort(); mounted.forEach(panel => panel.dispose()); root.replaceChildren(); };
  }, []);
  return <>{error && <p role="alert" className="notice error">{error}</p>}<div ref={host} data-monitor="oil" /></>;
}

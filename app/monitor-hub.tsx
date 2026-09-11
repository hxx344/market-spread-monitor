"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Activity, ArrowUpRight, Layers3 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { monitors } from "../lib/monitors";
import Dashboard from "./dashboard";
import OilPanel from "./oil-panel";

const panels = { oil: OilPanel, hynix: Dashboard };

export default function MonitorHub() {
  const [active, setActive] = useState("oil");
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => object }, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "select_market_monitor", title: "切换监控面板", description: "打开已接入的市场监控面板；保留其他面板的图表选项和未保存告警设置。",
        inputSchema: { type: "object", properties: { monitorId: { type: "string", enum: monitors.map(monitor => monitor.id) } }, required: ["monitorId"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("monitorId" in input) || typeof input.monitorId !== "string") throw new Error("需要有效的 monitorId");
          const monitor = monitors.find(item => item.id === input.monitorId);
          if (!monitor) throw new Error("监控模块不存在");
          flushSync(() => setActive(monitor.id));
          return { monitorId: monitor.id, title: monitor.title };
        },
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch { /* Standard browsers do not require WebMCP. */ }
    return () => lifecycle.abort();
  }, []);
  return <div className="monitor-hub">
    <header className="hub-header"><a className="hub-brand" href="/"><span><Activity size={23}/></span>MARKET <b>/ MONITOR</b></a><div className="hub-source">Hyperliquid <span>· XYZ 永续合约</span></div></header>
    <div className="hub-intro"><div><p className="eyebrow">跨市场价差观察</p><h1>市场监控</h1></div><a href="https://github.com/hxx344/market-spread-monitor" target="_blank" rel="noreferrer"><Layers3 size={16}/>项目与扩展说明<ArrowUpRight size={15}/></a></div>
    <Tabs value={active} onValueChange={value => setActive(String(value))} className="hub-tabs">
      <TabsList className="hub-tab-list" aria-label="选择监控市场">{monitors.map(monitor => <TabsTrigger key={monitor.id} value={monitor.id} className="hub-tab"><i style={{background:monitor.accent}}/><span>{monitor.title}<small>{monitor.subtitle}</small></span><em>{monitor.category}</em></TabsTrigger>)}</TabsList>
      {monitors.map(monitor => { const Panel = panels[monitor.id as keyof typeof panels]; return <TabsContent key={monitor.id} value={monitor.id} forceMount className="hub-content">{Panel ? <Panel /> : <p role="alert">该监控模块尚未提供面板。</p>}</TabsContent>; })}
    </Tabs>
  </div>;
}

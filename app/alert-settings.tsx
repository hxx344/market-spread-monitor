"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, ChevronDown, Plus, Save, Trash2 } from "lucide-react";
import type { AlertConfig, AlertRule, AlertView } from "../lib/alert-types";

const initial: AlertConfig = { enabled: false, cooldownSeconds: 300, hysteresis: 0.5, rules: [] };
const time = (value: string | number | null | undefined) => value == null ? "尚无记录" : `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;

export default function AlertSettings() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AlertView | null>(null);
  const [draft, setDraft] = useState<AlertConfig>(initial);
  const [revision, setRevision] = useState(0);
  const latestRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const markDirty = () => { dirtyRef.current = true; setDirty(true); setMessage(""); };
  const edit = (next: AlertConfig) => { markDirty(); setDraft(next); };
  const editRule = (id: string, values: Partial<AlertRule>) => edit({ ...draft, rules: draft.rules.map(rule => rule.id === id ? { ...rule, ...values } : rule) });

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/monitors/hynix/alerts", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("无法读取告警后台状态。");
        const next: AlertView = await response.json();
        if (controller.signal.aborted) return;
        setLoadError("");
        if (next.available && next.revision < latestRevision.current) return;
        latestRevision.current = next.revision ?? 0;
        setView(next);
        if (next.available && !dirtyRef.current) { setDraft(next.config); setRevision(next.revision); }
      } catch {
        if (!controller.signal.aborted) setLoadError("无法连接告警后台，请检查 Linux 服务是否正在运行。");
      } finally { pending = false; }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 10_000);
    window.addEventListener("feishu-settings-changed", load);
    return () => { controller.abort(); clearInterval(interval); window.removeEventListener("feishu-settings-changed", load); };
  }, []);

  const apply = (next: AlertView) => {
    if (next.revision < latestRevision.current) return false;
    latestRevision.current = next.revision;
    setView(next); setDraft(next.config); setRevision(next.revision);
    dirtyRef.current = false; setDirty(false);
    return true;
  };
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/monitors/hynix/alerts", { method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(25_000), body: JSON.stringify({ ...draft, revision }) });
      const result = await response.json() as AlertView & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "保存失败。");
      if (apply(result)) setMessage("配置已保存；后台将在下一轮检查时使用新阈值。");
      else setError("另一页面已有更新配置，请放弃修改并重载后再编辑。");
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(false); }
  }
  const connected = view?.available === true;
  return <section className="alert-panel" aria-label="飞书阈值告警">
    <button className="alert-heading" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="alert-settings-body">
      <span><Bell size={18}/><strong>飞书阈值告警</strong><span className="alert-summary">{!view ? "连接后台中…" : !connected ? "Linux 后台未连接" : view.config.enabled ? `已启用 · ${view.config.rules.filter(rule => rule.enabled).length} 档阈值` : "未启用"}</span></span><span>设置 <ChevronDown size={16} className={open ? "rotated" : ""}/></span>
    </button>
    {open && <div id="alert-settings-body" className="alert-body">
      {!connected ? <p className="alert-help">{view?.reason || loadError || "正在连接告警后台…"}</p> : <>
        <p className="alert-help">后台每 10 秒检查溢价率，关闭网页后仍会运行。首次启用时若已达到阈值，会立即告警；持续满足条件时不会重复发送。</p>
        <p className="alert-help">{view.config.webhookConfigured ? "使用整个面板的统一飞书机器人。" : "尚未配置共用机器人，可先保存阈值。"} <button className="shared-settings-link" type="button" onClick={() => window.dispatchEvent(new Event("open-feishu-settings"))}>打开统一设置</button></p>
        <form onSubmit={save}>
          <fieldset disabled={busy} className="alert-fields">
            <div className="alert-form-grid">
              <label>再次告警冷却（秒）<input type="number" min="0" max="86400" step="1" required value={Number.isFinite(draft.cooldownSeconds) ? draft.cooldownSeconds : ""} onChange={event => edit({ ...draft, cooldownSeconds: event.target.valueAsNumber })}/></label>
              <label>重新布防回差（百分点）<input type="number" min="0" max="100" step="any" required value={Number.isFinite(draft.hysteresis) ? draft.hysteresis : ""} onChange={event => edit({ ...draft, hysteresis: event.target.valueAsNumber })}/></label>
            </div>
            <div className="alert-rules-heading"><h3>梯度阈值</h3><button type="button" className="alert-button" disabled={draft.rules.length >= 20} onClick={() => edit({ ...draft, rules: [...draft.rules, { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: `档位 ${draft.rules.length + 1}`, direction: "above", threshold: Number.NaN, enabled: true }] })}><Plus size={15}/>添加阈值</button></div>
            <div className="alert-rules">{draft.rules.map(rule => <div className="alert-rule" key={rule.id}>
              <label className="alert-checkbox"><input type="checkbox" checked={rule.enabled} onChange={event => editRule(rule.id, { enabled: event.target.checked })}/><span>启用</span></label>
              <label><span className="sr-only">档位名称</span><input aria-label="档位名称" value={rule.name} required maxLength={40} onChange={event => editRule(rule.id, { name: event.target.value })}/></label>
              <label><span className="sr-only">触发方向</span><select aria-label={`${rule.name}触发方向`} value={rule.direction} onChange={event => editRule(rule.id, { direction: event.target.value as AlertRule["direction"] })}><option value="above">高于或等于 ≥</option><option value="below">低于或等于 ≤</option></select></label>
              <label className="alert-threshold"><span className="sr-only">溢价率阈值</span><input aria-label={`${rule.name}溢价率阈值`} type="number" step="any" min="-100" max="10000" required placeholder="输入阈值" value={Number.isFinite(rule.threshold) ? rule.threshold : ""} onChange={event => editRule(rule.id, { threshold: event.target.valueAsNumber })}/><span>%</span></label>
              <button type="button" className="alert-delete" aria-label={`删除${rule.name}`} onClick={() => edit({ ...draft, rules: draft.rules.filter(item => item.id !== rule.id) })}><Trash2 size={16}/></button>
            </div>)}</div>
            {!draft.rules.length && <p className="alert-help">添加一档或多档阈值，分别选择向上或向下触发。</p>}
            <p className="alert-help">例如上方阈值为 40%、回差为 0.5 个百分点：触发后需回落到 39.5% 以下才重新布防，再次达到 40% 且冷却结束后才告警。一次跨越多档会合并成一条消息。</p>
            <div className="alert-actions"><label className="alert-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => edit({ ...draft, enabled: event.target.checked })}/>启用飞书告警</label><div><button type="submit" className="alert-button primary"><Save size={14}/>{busy ? "处理中…" : "保存配置"}</button></div></div>
          </fieldset>
        </form>
        {dirty && <div className="alert-actions"><p className="alert-help">有尚未保存的阈值修改。</p><button type="button" className="alert-button" disabled={busy} onClick={() => { apply(view); setError(""); }}>放弃修改并重载</button></div>}
        {message && <p className="alert-feedback" role="status">{message}</p>}
        {error && <p className="alert-feedback failure" role="alert">{error}</p>}
        {loadError && <p className="alert-feedback failure" role="alert">{loadError}</p>}
        <div className="alert-monitor"><span>最近后台检查：{time(view.status.checkedAt)}</span><span>最近成功取价：{time(view.status.lastSuccessAt)}</span></div>
        {view.status.lastError && <p className="alert-feedback failure">{view.status.lastError}</p>}
        {view.history.length > 0 && <div className="alert-history"><h3>最近发送记录</h3>{view.history.slice(0, 8).map(item => <div key={item.id}><span>{time(item.time)}</span><strong className={item.status === "sent" ? "positive" : "negative"}>{item.status === "sent" ? "已发送" : "发送失败"}</strong><span>{item.kind === "test" ? "测试消息" : `${item.rules.join("、")} · ${item.premium?.toFixed(2)}%`}{item.error && ` · ${item.error}`}</span></div>)}</div>}
      </>}
    </div>}
  </section>;
}

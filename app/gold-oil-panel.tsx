"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { RefreshCw } from 'lucide-react';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_STALE_MS, GOLD_OIL_INTERVAL_MS, goldOilChartPoints, validateGoldOilQuote, validateGoldOilHistory, type GoldOilQuote, type GoldOilHistory } from '../lib/gold-oil';
import { goldOilSummary, summaryTimestamp, type SummaryProps } from '../lib/monitor-summary';
import type { InitialMarketData } from '../lib/initial-market';
import { startActivityPolling } from '../lib/polling';

const Chart = dynamic(() => import('./gold-oil-chart'), { ssr: false, loading: () => <p role="status">正在加载金油比图表…</p> });
async function request(action: string, signal: AbortSignal) {
  const response = await fetch(`/api/monitors/cl-xau/${action}`, { cache: 'no-store', signal });
  if (!response.ok) throw Error('金油比行情更新失败');
  return response.json() as Promise<unknown>;
}

export default function GoldOilPanel({ initial, active = true, summaryActive = true, onSummary }: SummaryProps & { initial?: InitialMarketData | null; active?: boolean; summaryActive?: boolean }) {
  const [quote, setQuote] = useState<GoldOilQuote | null>(initial?.['cl-xau']?.quote ?? null);
  const [history, setHistory] = useState<GoldOilHistory | null>(initial?.['cl-xau']?.history ?? null);
  const [quoteError, setQuoteError] = useState(false), [historyError, setHistoryError] = useState(false);
  const [days, setDays] = useState(7), [now, setNow] = useState(initial?.renderedAt ?? 0);
  const quotePoll = useRef<ReturnType<typeof startActivityPolling> | null>(null), historyPoll = useRef<ReturnType<typeof startActivityPolling> | null>(null);
  useEffect(() => {
    if (!summaryActive) return;
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_QUOTE_MS,
      load: async signal => validateGoldOilQuote(await request('quote', signal)),
      onData: value => { setQuote(value); setQuoteError(false); }, onError: () => setQuoteError(true) });
    quotePoll.current = poll;
    return () => { quotePoll.current = null; poll.stop(); };
  }, [summaryActive]);
  useEffect(() => {
    if (!active) return;
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_HISTORY_MS,
      load: async signal => validateGoldOilHistory(await request('history', signal)),
      onData: value => { setHistory(value); setHistoryError(false); }, onError: () => setHistoryError(true) });
    historyPoll.current = poll;
    return () => { historyPoll.current = null; poll.stop(); };
  }, [active]);
  useEffect(() => { onSummary?.(goldOilSummary(quote, quoteError)); }, [quote, quoteError, onSummary]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const points = useMemo(() => goldOilChartPoints(history, days), [history, days]);
  const paired = points.filter(point => point.ratio !== null), latest = paired.at(-1);
  const stale = quote && (quote.status === 'snapshot' || quoteError || now - Date.parse(quote.fetchedAt) > GOLD_OIL_STALE_MS);
  const historyStale = history && (history.status === 'snapshot' || historyError || now - Date.parse(history.fetchedAt) > 150_000 || !latest || now - latest.time - 2 * GOLD_OIL_INTERVAL_MS > 150_000);
  return <main className="gold-oil-panel">
    <div className="page-heading"><div><p className="eyebrow">CL-XAU · BINANCE</p><h1>金油比</h1><p>XAU ÷ CL · 每盎司黄金对应多少桶 WTI 原油</p></div><button className="refresh-button" onClick={() => { void quotePoll.current?.refresh(); void historyPoll.current?.refresh(); }}><RefreshCw size={16}/>刷新</button></div>
    <div className="data-status" role="status"><span>{!quote ? quoteError ? '行情暂不可用' : '正在获取行情' : stale ? '更新中断 · 保留数据' : '实时 · 每 30 秒更新'}</span><span>{quote ? `${summaryTimestamp(quote.fetchedAt)} 北京时间` : '等待两腿有效报价'}</span></div>
    <section className="metrics" aria-label="金油比报价">
      <article className="metric primary-metric"><p className="metric-label">金油比 XAU / CL</p><p className="metric-value">{quote?.ratio.toFixed(3) ?? '—'}</p><p className="metric-foot">桶/盎司</p></article>
      <article className="metric"><p className="metric-label">黄金 XAUUSDT</p><p className="metric-value">{quote?.xau.price.toFixed(2) ?? '—'}</p><p className="metric-foot">USDT/盎司 · 标记价格</p></article>
      <article className="metric"><p className="metric-label">原油 CLUSDT</p><p className="metric-value">{quote?.cl.price.toFixed(3) ?? '—'}</p><p className="metric-foot">USDT/桶 · 标记价格</p></article>
    </section>
    <section className="chart-panel" aria-label="金油比历史走势">
      <div className="chart-heading"><div><p className="section-kicker">XAU / CL · 桶/盎司</p><h2>金油比走势</h2></div><div className="segmented" aria-label="历史时间范围">{[1, 7].map(value => <button key={value} aria-pressed={days === value} className={days === value ? 'active' : ''} onClick={() => setDays(value)}>{value} 天</button>)}</div></div>
      <div className="chart-container" role="img" aria-label={`最近 ${days} 天金油比，${paired.length} 个有效的 15 分钟收盘样本${latest ? `，末值 ${latest.ratio?.toFixed(3)} 桶/盎司` : ''}`}>
        {paired.length ? active && <Chart points={points}/> : <div className="empty-chart"><p>{historyError ? '历史行情暂不可用' : '正在获取历史行情'}</p><span>等待同一时段的黄金和原油收盘价格</span></div>}
      </div>
      <div className="chart-caption"><span>15 分钟标记价格收盘值 · 北京时间 · 缺失时段断线</span><span>{historyStale ? '历史待更新 · 保留数据' : `有效样本 ${paired.length} / ${points.length}`}</span></div>
      {latest && <p className="gold-oil-history-time">最后有效时段：{summaryTimestamp(new Date(latest.time).toISOString())} 北京时间 · 金油比 {latest.ratio?.toFixed(3)} 桶/盎司</p>}
    </section>
    <p className="gold-oil-method">金油比 = 黄金标记价格（USDT/盎司）÷ 原油标记价格（USDT/桶）。比值上升表示黄金相对原油走强。历史仅使用同一 UTC 时段已收盘的两腿数据，不补零、不插值。</p>
  </main>;
}

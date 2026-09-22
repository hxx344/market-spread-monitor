"use client";

import { hubNavigate, cleanHubQuery } from "../lib/hub-bridge";
import { Fragment, memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Activity, ArrowDown, Bell, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { usePerpetualFeed } from "../hooks/use-perpetual-feed";
import { usePerpetualQuality } from "../hooks/use-perpetual-quality";
import { usePerpetualFx } from "../hooks/use-perpetual-fx";
import PerpetualFeeSettings from "./perpetual-fee-settings";
import { defaultQualityBudget, evaluateOpportunityQuality, pairQualityHistory, parseQualityBudget, qualityPairKey, type OpportunityQuality, type PerpetualQualityReport } from "../lib/perpetual-quality";
import { classifyPerpetualQuote, createPerpetualQuoteSelector, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, perpetualSpreadKey, quotePriceTime, type PerpetualFilters, type PerpetualSpread } from "../lib/perpetual-spreads";
import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from "../lib/perpetual-types";
import type { SummaryProps } from "../lib/monitor-summary";
import "./perpetual.css";

const PerpetualHealth = dynamic(() => import("./perpetual-health"));
const PerpetualManualPairs = dynamic(() => import("./perpetual-manual-pairs"));
const PerpetualAlerts = dynamic(() => import("./perpetual-alerts"));
const PerpetualExecution = dynamic(() => import("./perpetual-execution").then(module => module.PerpetualExecution));
const PerpetualHolding = dynamic(() => import("./perpetual-holding"));
const PerpetualTrend = dynamic(() => import("./perpetual-trend"));
const PerpetualExit = dynamic(() => import("./perpetual-exit"));
const PerpetualPaper = dynamic(() => import("./perpetual-paper"));
type DetailTab = "execution" | "quality" | "exit" | "quotes";

const preferencesKey = "market-monitor:perpetual:v1";
const qualityBudgetKey = "market-monitor:perpetual-quality-budget:v1";
const pageSize = 30;
const emptyQuotes: PerpetualQuote[] = [];
const emptyExchanges: PerpetualExchange[] = [];
const emptySpreads: PerpetualSpread[] = [];
const exchangeLabels = { connecting: "连接中", live: "实时", stale: "已过期", error: "连接异常", disabled: "未启用" };
const positioningVenues = [{ id: "binance", name: "Binance" }, { id: "bybit", name: "Bybit" }, { id: "okx", name: "OKX" }, { id: "bitget", name: "Bitget" }, { id: "gate", name: "Gate" }];
const positioningStatusLabels = { fresh: "已纳入", stale: "未纳入", pending: "采集中", unsupported: "不支持", unavailable: "暂无资料", error: "更新失败", "rate-limited": "请求限流" };
const clockFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const delistingFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const stamp = (value: number | null | undefined) => value && Number.isFinite(value) ? clockFormat.format(value) : "—";
const percent = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
const age = (time: number, now: number) => `${Math.max(0, Math.floor((now - time) / 1000))} 秒前`;
const priceFormats = [2, 4, 6, 12].map(maximumFractionDigits => new Intl.NumberFormat("en-US", { maximumFractionDigits }));
const usdFormat = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const share = (value: number | null | undefined, digits = 1) => finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const usd = (value: number | null | undefined) => finite(value) && value > 0 ? usdFormat.format(value) : "—";
const deviation = (value: number | null | undefined) => finite(value) ? `${value.toFixed(4)} 百分点` : "—";
function price(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 0.00000001) return value.toExponential(4);
  return priceFormats[value >= 1000 ? 0 : value >= 1 ? 1 : value >= 0.01 ? 2 : 3].format(value);
}

function pairName(key: string) {
  try { const [base, long, short] = JSON.parse(key) as string[]; return `${base} · 多 ${long} / 空 ${short}`; }
  catch { return key; }
}

function DelistingNotice({ quote, now }: { quote: PerpetualQuote; now: number }) {
  if (!quote.delisting) return null;
  const at = typeof quote.delistingAt === "number" && Number.isFinite(quote.delistingAt) && quote.delistingAt > 0 ? quote.delistingAt : null;
  const due = at !== null && now >= at;
  return <div className={`perp-delisting${due ? " is-due" : ""}`}>
    <span className="perp-delisting-label">{due ? "已到下架时间" : "即将下架"}</span>
    <span className="perp-delisting-time">{at === null ? "下架时间待公布" : <><time dateTime={new Date(at).toISOString()}>{delistingFormat.format(at)}</time> <span className="perp-delisting-zone">北京时间</span></>}</span>
  </div>;
}

function QualityCell({ quality, pairLabel, onInspect }: { quality: OpportunityQuality; pairLabel: string; onInspect: () => void }) {
  return <button type="button" className={`perp-quality-grade ${quality.grade}`} aria-label={`查看 ${pairLabel} 聚合质量依据：${quality.label}${quality.score === null ? "" : `，${quality.score} 分`}，数据覆盖 ${quality.coverage}%`} onClick={onInspect}>
    <strong>{quality.label}<b>{quality.score === null ? "—" : quality.score}<small>{quality.score === null ? "" : "/100"}</small></b></strong>
    <span>数据覆盖 {quality.coverage}%</span>
    <span className="perp-quality-signals">{Object.entries(quality.profiles).map(([key, profile]) => <span key={key} className={profile.status} title={profile.detail}>{profile.label}</span>)}</span>
  </button>;
}

function PositioningOverviewCard({ base, report, venues, now }: { base: string; report: PerpetualQualityReport | null; venues: Map<string, PerpetualExchange>; now: number }) {
  const overview = report?.positioningOverview?.[base];
  const stale = Boolean(overview?.observedAt && now - overview.observedAt > 900_000);
  const ready = Boolean(overview && overview.availableExchanges >= 2 && finite(overview.longRatio) && finite(overview.shortRatio) && overview.longRatio >= 0 && overview.longRatio <= 1 && overview.shortRatio >= 0 && overview.shortRatio <= 1 && Math.abs(overview.longRatio + overview.shortRatio - 1) <= 0.001);
  return <section className={`perp-positioning-overview${stale ? " is-stale" : ""}`} aria-label={`${base} 跨所账户多空概览`}>
    <div className="perp-positioning-overview-heading"><h4>{base} 跨所账户多空概览<small>USDT 合约全体持仓账户比例 · 5 分钟</small></h4><span className={stale || !ready ? "perp-positioning-state is-warning" : "perp-positioning-state"}>{stale ? "资料过期 · 保留上次值" : ready ? "免费跨所汇总" : overview ? "资料不足" : "资料采集中"}</span></div>
    {ready ? <div className="perp-positioning-composition"><div className="perp-positioning-overview-values"><strong>多 <b>{share(overview!.longRatio)}</b></strong><strong>空 <b>{share(overview!.shortRatio)}</b></strong></div><div className="perp-positioning-bar" aria-hidden="true"><span style={{ width: `${overview!.longRatio! * 100}%` }}/><span style={{ width: `${overview!.shortRatio! * 100}%` }}/></div></div> : <p className="perp-positioning-insufficient">{overview ? "资料不足，至少需要 2 家有效官方数据" : "等待交易所官方账户比例"}</p>}
    <div className="perp-positioning-coverage"><strong>{stale ? "上次有效覆盖" : "有效覆盖"} {overview?.availableExchanges ?? "—"} / {overview?.totalExchanges ?? 5} 家</strong><span>{overview ? `当前发现 ${overview.eligibleExchanges} 家有对应 USDT 市场` : "对应 USDT 市场待核对"}</span><span>数据时间 {stamp(overview?.observedAt)} 北京时间</span></div>
    <p className="perp-positioning-method">每家交易所等权：对有效的多头账户比例取平均，空头比例为 100% 减去多头比例；缺失数据不补 50%。这是跨所比例概览，不是全网真实人数，不参与两腿质量评分。</p>
    <details className="perp-positioning-breakdown"><summary>查看五家交易所明细 <ChevronDown size={14} aria-hidden="true"/></summary><ul>{positioningVenues.map(venue => {
      const item = overview?.constituents.find(entry => entry.exchange === venue.id);
      const ratio = item?.key ? report?.positioning[item.key] : undefined;
      const error = item?.key ? report?.positioningErrors[item.key] : undefined;
      const status = item?.status ?? "pending";
      const sourceStale = stale || Boolean(ratio && now - ratio.observedAt > 900_000);
      const statusLabel = status === "fresh" && sourceStale ? "资料过期" : status === "fresh" && error ? "已纳入 · 更新失败" : positioningStatusLabels[status];
      const reason = item?.reason || error;
      return <li key={venue.id}><div className="perp-positioning-venue-heading"><strong>{venues.get(venue.id)?.name ?? venue.name}</strong><span className={status === "fresh" && !sourceStale && !error ? "perp-positioning-state" : "perp-positioning-state is-warning"}>{statusLabel}</span></div><small>{item?.symbol ?? (item ? "无对应 USDT 合约" : "对应合约待核对")}</small>{ratio ? <><p className="perp-positioning-venue-values">{status === "fresh" && !sourceStale ? "官方值" : "上次官方值"} · 多 {share(ratio.longRatio)} / 空 {share(ratio.shortRatio)}</p><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方来源</a> : "官方来源"} · {stamp(ratio.observedAt)} 北京时间</small></> : null}{reason ? <p className="perp-positioning-reason">{reason}</p> : status === "pending" ? <p className="perp-positioning-reason">官方账户比例采集中</p> : sourceStale ? <p className="perp-positioning-reason">资料过期，保留上次值供核对</p> : null}</li>;
    })}</ul></details>
  </section>;
}

function QualityEvidence({ row, report, quality, venues, now, slippagePercent }: { row: PerpetualSpread; report: PerpetualQualityReport | null; quality: OpportunityQuality; venues: Map<string, PerpetualExchange>; now: number; slippagePercent: number }) {
  const asset = report?.assets[row.base];
  const history = pairQualityHistory(row, report);
  const spread = history?.spread, funding = history?.funding;
  const dilution = asset && finite(asset.marketCapUsd) && asset.marketCapUsd > 0 && finite(asset.fdvUsd) && asset.fdvUsd > 0 ? asset.marketCapUsd / asset.fdvUsd : null;
  const reportDelayed = Boolean(report && now - report.generatedAt > 180_000);
  const legs = [{ label: "做多腿", quote: row.long }, { label: "做空腿", quote: row.short }];
  return <div className="perp-quality-evidence">
    <div className="perp-quality-evidence-heading"><strong>聚合质量依据 <span>{quality.label}{quality.score === null ? "" : ` · ${quality.score} / 100`}</span></strong><span>{report ? `${reportDelayed ? "上次读取" : "最近读取"} ${stamp(report.generatedAt)} 北京时间` : "资料采集中"}</span></div>
    <div className="perp-quality-profiles">{Object.entries(quality.profiles).map(([key, profile]) => <section key={key} className={profile.status}><small>{key === "persistence" ? "价差持续性" : key === "convergence" ? "报价收窄证据" : "资金费收支方向"}</small><h4>{profile.label}</h4><p>{profile.detail}</p></section>)}</div>
    <section className="perp-convergence" aria-label="报价收窄历史"><h4>报价价差减半记录 <small>近 24h · 每 5 分钟真实采样</small></h4><p>以固定 UTC 时段的起点为基准，起始价差至少 0.05%；观察是否曾降至一半。各持有时长分别使用互不重叠的窗口；报价缺口整窗排除，尚未结束的窗口不计结果。</p>{history?.convergence ? <><div className="perp-convergence-scroll"><table><thead><tr><th>窗口</th><th>曾减半 / 完整窗口</th><th>减半占比</th><th>中位耗时</th><th>最大反向扩大</th><th>缺口 / 未结束</th></tr></thead><tbody>{history.convergence.horizons.map(item => <tr key={item.hours}><th>{item.hours}h</th><td>{item.successful} / {item.completed}</td><td>{share(item.successRatio)}</td><td>{item.medianMinutesToTarget === null ? "—" : `${item.medianMinutesToTarget} 分钟`}</td><td>{deviation(item.maxAdverseExpansionPercent)}</td><td>{item.incomplete} / {item.pending}</td></tr>)}</tbody></table></div><p>{history.convergence.samples} / 288 个样本 · 最近 {stamp(history.convergence.lastAt)}{history.convergence.lastAt && now - history.convergence.lastAt > 600_000 ? " · 已过期" : ""}。4h / 8h 窗口样本较少，仅展示记录。</p></> : <p>正在积累收窄历史；至少需要 12 小时采样与 6 个完整的 1h 窗口才参与评分。</p>}<p className="perp-quality-warning">这里衡量开仓报价的历史变化，未计退出买卖价、费用和成交容量，不是回测收益或盈利概率。</p></section>
    <PositioningOverviewCard base={row.base} report={report} venues={venues} now={now}/>
    <div className="perp-quality-grid">
      <section><h4>市值与 FDV <small>USD</small></h4><dl><div><dt>市值</dt><dd>{usd(asset?.marketCapUsd)}</dd></div><div><dt>完全稀释估值 / FDV</dt><dd>{usd(asset?.fdvUsd)}</dd></div><div><dt>市值 / FDV</dt><dd>{share(dilution)}</dd></div></dl><p>{asset ? <><a href={`https://www.coingecko.com/en/coins/${encodeURIComponent(asset.coinId)}`} target="_blank" rel="noopener noreferrer">{asset.name}</a> · CoinGecko · {stamp(asset.updatedAt)}</> : report?.assetErrors[row.base] || "市值资料采集中"}</p>{asset && (!asset.updatedAt || now - asset.updatedAt > 3_600_000) ? <p className="perp-quality-warning">市值资料已过期，未计入评分</p> : null}</section>
      <section><h4>交易所官方多空比例</h4>{legs.map(({ label, quote }) => {
        const key = `${quote.exchange}:${quote.symbol}`, ratio = report?.positioning[key], error = report?.positioningErrors[key];
        return <div className="perp-positioning-leg" key={key}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}</strong><small>{quote.symbol}</small>{ratio ? <><p className="perp-positioning-values">多 {share(ratio.longRatio)} <span>/</span> 空 {share(ratio.shortRatio)}</p><small>{ratio.kind === "accounts" ? "账户人数占比" : "持仓量占比"} · 范围：{ratio.scope}</small><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方数据</a> : "官方数据"} · {stamp(ratio.observedAt)}{now - ratio.observedAt > 900_000 ? " · 已过期" : ""}</small>{error ? <p className="perp-quality-warning">保留上次值 · {error}</p> : null}</> : <p>{error || "官方多空资料采集中"}</p>}</div>;
      })}<p>账户人数与持仓量口径不混算。</p></section>
      <section><h4>盘口价差稳定度 <small>近 1h</small></h4><p className="perp-quality-samples">{spread?.samples ? `${spread.samples} / ${spread.expectedSamples} 个样本 · 覆盖 ${share(spread.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>价差均值</dt><dd>{percent(spread?.mean ?? null, 4)}</dd></div><div><dt>标准差</dt><dd>{deviation(spread?.stddev)}</dd></div><div><dt>正价差占比</dt><dd>{share(spread?.positiveRatio)}</dd></div></dl><p>{spread?.lastAt ? `最近有效样本 ${stamp(spread.lastAt)}${now - spread.lastAt > 180_000 ? " · 已过期" : ""}` : "等待同一平台组合的有效盘口"}{spread?.samples && spread.samples < 30 ? " · 尚未满 30 个有效点" : ""}</p></section>
      <section><h4>资金费稳定度 <small>近 24h · 折算 / 8h</small></h4><p className="perp-quality-samples">{funding?.samples ? `${funding.samples} / ${funding.expectedSamples} 个样本 · 覆盖 ${share(funding.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>做多腿标准差</dt><dd>{deviation(funding?.longStddev)}</dd></div><div><dt>做空腿标准差</dt><dd>{deviation(funding?.shortStddev)}</dd></div><div><dt>两腿费差均值</dt><dd>{percent(funding?.mean ?? null, 4)}</dd></div></dl><p>{funding?.lastAt ? `最近有效样本 ${stamp(funding.lastAt)}${now - funding.lastAt > 600_000 ? " · 已过期" : ""} · ` : ""}采样为实时预估费率，非已结算资金费。</p></section>
    </div>
    <div className="perp-quality-rubric">{quality.dimensions.map(dimension => <details key={dimension.id}><summary>{dimension.label}<span>{dimension.score === null ? "缺失 / 未评分" : `${dimension.score} / 100`} · 权重 {dimension.weight}%</span></summary><p>{dimension.detail}</p></details>)}</div>
    <section className="perp-taker-evidence" aria-label="双腿 taker 手续费"><h4>双腿 taker 手续费 <small>单次成交 · 按名义本金</small></h4><div>{legs.map(({ label, quote }, index) => {
      const fee = index === 0 ? quality.fees.long : quality.fees.short;
      return <div key={label}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}<b>{fee.percent === null ? "—" : `${fee.percent.toFixed(4)}%`}</b></strong><small>{quote.symbol} · {fee.basis === "account" ? "账户覆盖" : fee.basis === "public" ? "公开普通费率" : "费率待核实"}</small><p>{fee.detail}</p>{fee.source ? <small><a href={fee.source} target="_blank" rel="noopener noreferrer">官方来源</a>{fee.checkedAt ? ` · 核对 ${delistingFormat.format(fee.checkedAt)} 北京时间` : ""}</small> : null}</div>;
    })}</div><p>往返手续费 <strong>{quality.fees.roundTripPercent === null ? "—" : `${quality.fees.roundTripPercent.toFixed(4)}%`}</strong> · 双腿往返滑点 <strong>{slippagePercent.toFixed(2)}%</strong></p><p>每腿开、平仓各计一次 taker；以每腿相同名义本金估算，平仓成交额变化后实际费用也会变化。</p></section>
    <div className="perp-quality-conclusion"><p>扣 taker 手续费与滑点后价差 <strong>{percent(quality.netSpreadPercent)}</strong>；未计持有期资金费与实际成交差异。</p>{quality.reasons.length ? <ul>{quality.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}<p>分数是筛选参考，不代表盈利概率；数据覆盖按可评分维度权重计算，缺失项未补零。</p></div>
  </div>;
}

function QuoteDetails({ quotes, venues, mode, now, staleAfterMs, standalone = false }: { quotes: PerpetualQuote[]; venues: Map<string, PerpetualExchange>; mode: PerpetualPriceMode; now: number; staleAfterMs: number; standalone?: boolean }) {
  return <div className={`perp-detail ${standalone ? "perp-all-quotes" : ""}`}>{!standalone ? <div className="perp-detail-heading"><strong>各平台报价</strong><span>按交易所展示，过期报价仅供核对</span></div> : null}
    <div className="perp-detail-scroll"><table><thead><tr><th>币种 / 交易所 / 合约</th><th>买一 / 卖一</th><th>标记价</th><th>资金费 / 原周期</th><th>折算 / 8h</th><th>下次结算</th><th>价格状态</th></tr></thead>
      <tbody>{quotes.map(quote => {
        const venue = venues.get(quote.exchange);
        const freshness = classifyPerpetualQuote(quote, mode, now, staleAfterMs);
        const fresh = venue?.status === "live" && freshness === "fresh";
        const priceTime = quotePriceTime(quote, mode);
        const normalized = normalizedFunding8h(quote, now);
        return <tr key={`${quote.exchange}:${quote.symbol}:${quote.quoteCurrency}`} className={fresh ? undefined : "perp-quote-stale"}>
          <th scope="row" className="perp-quote-identity"><strong>{quote.displayBase ?? quote.base}</strong><span>{venue?.name ?? quote.exchange}</span><small>{quote.symbol} · {quote.quoteCurrency}</small>{quote.comparable === false ? <small className="perp-unit-note">独立合约 · 不参与跨所排行</small> : null}{quote.contractUnit || quote.collateralCurrency ? <small>{quote.contractUnit ? `单位 ${quote.contractUnit}` : ""}{quote.collateralCurrency ? ` · 抵押 ${quote.collateralCurrency}` : ""}</small> : null}<DelistingNotice quote={quote} now={now}/></th>
          <td data-label="买一 / 卖一">{price(quote.bid)} / {price(quote.ask)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="标记价">{price(quote.mark)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="资金费 / 原周期">{normalized === null ? "—" : percent(quote.fundingRate! * 100, 4)}<small>{quote.fundingIntervalHours ? `每 ${quote.fundingIntervalHours}h` : "周期未知"}</small></td>
          <td data-label="折算 / 8h">{normalized === null ? "—" : percent(normalized * 100, 4)}</td>
          <td data-label="下次结算">{stamp(quote.nextFundingAt)}<small>北京时间</small></td>
          <td data-label="价格状态">{fresh ? "有效" : freshness === "stale" ? "已过期" : freshness === "unavailable" ? mode === "book" ? "暂无有效盘口" : "暂无标记价" : "平台未在线"}<small>{stamp(priceTime)} · {quote.transport.toUpperCase()}</small></td>
        </tr>;
      })}</tbody></table></div>
  </div>;
}

function PerpetualPanel({ active = true, onSummary, hubConnected = false }: SummaryProps & { active?: boolean; hubConnected?: boolean }) {
  const [workspace, setWorkspace] = useState<"opportunities" | "positions">("opportunities");
  const opportunitiesActive = active && workspace === "opportunities";
  const [inspection, setInspection] = useState<{ key: string; base: string; snapshot: PerpetualSnapshot; ranking: PerpetualSpread[]; page: number } | null>(null);
  // Leaving this monitor releases the captured view before its next activation.
  if (!active && inspection) setInspection(null);
  const paused = opportunitiesActive && inspection !== null;
  const { data: liveData, connection, error, now, refresh } = usePerpetualFeed(opportunitiesActive, paused);
  const data = paused ? inspection.snapshot : liveData;
  const [filters, setFilters] = useState<PerpetualFilters>(defaultPerpetualFilters);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [qualityBudget, setQualityBudget] = useState(defaultQualityBudget);
  const [qualityBudgetReady, setQualityBudgetReady] = useState(false);
  const [hubPair, setHubPair] = useState<{ longExchange?: string; shortExchange?: string }>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsVisited, setAlertsVisited] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>("execution");
  const [alertPair, setAlertPair] = useState<PerpetualSpread | null>(null);
  const expanded = paused ? inspection.key : null;
  const expandedBase = paused ? inspection.base : null;
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"rank" | "quotes">("rank");
  useEffect(() => {
    const restore = () => {
      const params = new URL(window.location.href).searchParams;
      const input = Object.fromEntries(['symbol', 'longExchange', 'shortExchange'].flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []));
      const query = cleanHubQuery(input); if (!query) return;
      if (query.symbol) { setFilters(previous => ({ ...previous, search: query.symbol!, favoritesOnly: false, minSpreadPercent: 0 })); setInspection(null); setWorkspace('opportunities'); setView('rank'); setPage(1); }
      setHubPair({ longExchange: query.longExchange, shortExchange: query.shortExchange });
    };
    // Preference hydration runs first; URL selection has priority.
    const timer = setTimeout(restore, 0); window.addEventListener('popstate', restore);
    return () => { clearTimeout(timer); window.removeEventListener('popstate', restore); };
  }, []);

  const search = useDeferredValue(filters.search);
  const quotes = data?.quotes ?? emptyQuotes;
  const exchanges = data?.exchanges ?? emptyExchanges;
  const expired = Boolean(data && now - data.generatedAt > data.staleAfterMs);
  const venues = useMemo(() => new Map(exchanges.map(exchange => [exchange.id, exchange])), [exchanges]);
  const selected = useMemo(() => filters.exchanges === null ? null : new Set(filters.exchanges), [filters.exchanges]);
  const favorites = useMemo(() => new Set(filters.favorites), [filters.favorites]);
  const favoritePairs = useMemo(() => new Set(filters.favoritePairs ?? []), [filters.favoritePairs]);
  const { data: fx, error: fxError } = usePerpetualFx(opportunitiesActive && filters.crossCurrency && !paused);
  const netSort = filters.sortBy === "net";
  const selectRanking = useMemo(() => createPerpetualRankingSelector(), []);
  const selectQuotes = useMemo(() => createPerpetualQuoteSelector(), []);
  const rankingFilters = useMemo(() => ({ ...filters, search }), [filters, search]);
  const fullRanking = useMemo(() => paused ? inspection.ranking : opportunitiesActive && view === "rank" && data && now ? selectRanking(data, rankingFilters, now, qualityBudget, fx) : emptySpreads, [paused, inspection, opportunitiesActive, view, data, rankingFilters, now, selectRanking, qualityBudget, fx]);
  const ranking = useMemo(() => fullRanking.filter(row => (!hubPair.longExchange || row.long.exchange === hubPair.longExchange) && (!hubPair.shortExchange || row.short.exchange === hubPair.shortExchange)), [fullRanking, hubPair]);
  const quoteSelection = useMemo(() => selectQuotes(quotes, rankingFilters), [quotes, rankingFilters, selectQuotes]);
  const availableBases = quoteSelection.baseCount;
  const liveExchanges = exchanges.filter(exchange => exchange.status === "live").length;
  const quoteQuality = useMemo(() => {
    const counts = { stale: 0, unavailable: 0 };
    if (!opportunitiesActive || !now) return counts;
    for (const key of quoteSelection.keys) {
      const status = classifyPerpetualQuote(quoteSelection.byKey.get(key)!, filters.priceMode, now, data?.staleAfterMs ?? 30_000);
      if (status !== "fresh") counts[status]++;
    }
    return counts;
  }, [opportunitiesActive, quoteSelection, filters.priceMode, now, data?.staleAfterMs]);
  const totalItems = view === "rank" ? ranking.length : quoteSelection.keys.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const visiblePage = paused ? inspection.page : Math.min(page, totalPages);
  const rows = useMemo(() => ranking.slice((visiblePage - 1) * pageSize, visiblePage * pageSize), [ranking, visiblePage]);
  const qualityPairs = useMemo(() => rows.map(row => ({ base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, ...(perpetualSpreadKey(row) === expanded ? { includeSeries: true } : {}) })), [rows, expanded]);
  const { report: qualityReport, loading: qualityLoading, error: qualityError } = usePerpetualQuality(qualityPairs, opportunitiesActive && view === "rank");
  const qualities = useMemo(() => new Map(rows.map(row => [qualityPairKey(row), evaluateOpportunityQuality(row, qualityReport, now, qualityBudget, filters.priceMode)])), [rows, qualityReport, now, qualityBudget, filters.priceMode]);
  const quoteRows = view === "quotes" ? quoteSelection.keys.slice((visiblePage - 1) * pageSize, visiblePage * pageSize).map(key => quoteSelection.byKey.get(key)!) : emptyQuotes;
  const detailQuotes = useMemo(() => expandedBase ? quotes.filter(quote => quote.base === expandedBase && (!selected || selected.has(quote.exchange))) : [], [quotes, expandedBase, selected]);
  const overview = useMemo(() => {
    let positive = 0, max: number | null = null;
    for (const row of ranking) if (finite(row.netSpreadPercent)) { if (row.netSpreadPercent > 0) positive++; if (max === null || row.netSpreadPercent > max) max = row.netSpreadPercent; }
    return { positive, max };
  }, [ranking]);

  useEffect(() => {
    function restorePreferences(event?: StorageEvent) {
      if (event && event.key !== preferencesKey) return;
      setInspection(null);
      try { setFilters(parsePerpetualPreferences(localStorage.getItem(preferencesKey))); } catch { /* Browser storage is optional. */ }
      setPreferencesReady(true);
    }
    restorePreferences();
    window.addEventListener("storage", restorePreferences);
    return () => window.removeEventListener("storage", restorePreferences);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify({ version: 2, ...filters })); } catch { /* Filtering remains available with storage disabled. */ }
  }, [filters, preferencesReady]);
  useEffect(() => {
    function restoreBudget(event?: StorageEvent) {
      if (event && event.key !== qualityBudgetKey) return;
      try { setQualityBudget(parseQualityBudget(localStorage.getItem(qualityBudgetKey))); } catch { /* Budget editing remains available without storage. */ }
      setQualityBudgetReady(true);
    }
    restoreBudget();
    window.addEventListener("storage", restoreBudget);
    return () => window.removeEventListener("storage", restoreBudget);
  }, []);
  useEffect(() => {
    if (!qualityBudgetReady) return;
    try { localStorage.setItem(qualityBudgetKey, JSON.stringify({ version: 2, ...qualityBudget })); } catch { /* Budget editing remains available without storage. */ }
  }, [qualityBudget, qualityBudgetReady]);
  const summaryStatus = !data ? "loading" : data.status === "unavailable" ? "error" : expired || connection === "error" || data.status === "snapshot" ? "stale" : data.status === "connecting" ? "loading" : "live";
  const summaryTime = data ? Math.floor(data.generatedAt / 5_000) * 5_000 : null;
  useEffect(() => {
    if (!onSummary) return;
    onSummary({
      status: summaryStatus,
      fetchedAt: summaryTime === null ? null : new Date(summaryTime).toISOString(),
      metrics: [{ label: "覆盖币种", value: summaryTime === null ? "—" : String(availableBases) }, { label: expired ? "上次在线" : "实时平台", value: summaryTime === null ? "—" : `${liveExchanges} / ${exchanges.length}` }],
      note: paused ? "查看详情 · 行情刷新已暂停" : expired ? "快照已过期 · 连接数量为上次状态" : "CEX / DEX 永续合约 · 买卖盘口价差",
    });
  }, [summaryStatus, summaryTime, onSummary, availableBases, liveExchanges, exchanges.length, expired, paused]);

  function inspect(row: PerpetualSpread, toggle = false, tab: DetailTab = "execution") {
    const key = perpetualSpreadKey(row), base = row.base;
    if (toggle && expanded === key) { setInspection(null); return; }
    setDetailTab(tab);
    if (data) setInspection(previous => previous ? { ...previous, key, base } : { key, base, snapshot: data, ranking, page: visiblePage });
  }
  function updateFilters(update: Partial<PerpetualFilters>) { setInspection(null); setFilters(previous => ({ ...previous, ...update })); setPage(1); }
  function changeView(next: "rank" | "quotes") { setInspection(null); setView(next); setPage(1); }
  function changePage(next: number) { setInspection(null); setPage(next); }
  function toggleExchange(id: string) {
    const next = new Set(filters.exchanges ?? exchanges.map(exchange => exchange.id));
    if (next.has(id)) next.delete(id); else next.add(id);
    updateFilters({ exchanges: next.size === exchanges.length ? null : [...next] });
  }
  function toggleFavorite(row: PerpetualSpread) {
    if (filters.favoritesOnly) setInspection(null);
    const key = perpetualSpreadKey(row);
    setFilters(previous => ({ ...previous, favoritePairs: (previous.favoritePairs ?? []).includes(key) ? previous.favoritePairs!.filter(item => item !== key) : [...(previous.favoritePairs ?? []), key].slice(-1000) }));
  }
  function resetFilters() { setHubPair({}); updateFilters({ ...defaultPerpetualFilters, favorites: filters.favorites, favoritePairs: filters.favoritePairs, blockedPairs: filters.blockedPairs }); }
  function blockPair(row: PerpetualSpread) { updateFilters({ blockedPairs: [...new Set([...(filters.blockedPairs ?? []), perpetualSpreadKey(row)])].slice(-1000) }); }
  function configureAlert(row: PerpetualSpread) {
    setAlertPair(row); setAlertsVisited(true); setAlertsOpen(true);
    requestAnimationFrame(() => document.getElementById("perpetual-alert-region")?.scrollIntoView({ behavior: "auto", block: "start" }));
  }

  const statusText = paused ? "查看详情 · 行情刷新已暂停" : connection === "paused" ? "已暂停更新" : !data ? error ? "行情连接异常" : "正在连接行情" : data.status === "unavailable" ? "采集服务未就绪" : expired ? "快照已过期" : connection === "error" ? "更新中断" : data.status === "snapshot" ? "保留快照" : data.status === "connecting" ? "等待首批报价" : data.status === "partial" ? "部分平台在线" : "行情实时更新";
  const transportText = paused ? "收起后恢复" : connection === "stream" ? "推送 / 1 秒" : connection === "polling" || connection === "error" ? "快照 / 5 秒" : connection === "paused" ? "切回后恢复" : "优先实时推送";
  const problem = error || data?.error || (data?.status === "unavailable" ? data.note || "请启动完整监控后台，连接交易所实时行情。" : "");
  const emptyMessage = !data ? "正在获取交易所与合约报价…" : data.status === "unavailable" ? "采集服务启动后，这里会显示实时合约价差。" : quotes.length === 0 ? "交易所正在连接，收到首批有效报价后自动更新。" : selected && selected.size < 2 ? "请至少选择两家交易所。" : filters.favoritesOnly && favorites.size + favoritePairs.size === 0 ? "点击组合旁的星标加入自选，再回来查看。" : netSort && filters.priceMode === "mark" ? "标记价仅供参考。切换买卖盘口可查看净价差排名。" : netSort ? "没有达到净价差阈值的组合；费用或汇率缺失的组合不计入。可降低阈值或切换毛价差核对。" : "当前筛选下没有有效价差。可以降低阈值、增加平台或切换报价口径。";

  return <section className="perpetual-panel" aria-label="CEX 与 DEX 合约价差监控">
    <header className="perp-heading"><div><h2>合约价差</h2><p>发现组合，核对成本与成交条件</p></div><div className="perp-heading-actions" hidden={workspace === "positions"}><button className="perp-refresh" type="button" aria-expanded={healthOpen} onClick={() => setHealthOpen(value => !value)}><Activity size={15}/>报价健康</button><button className="perp-refresh" type="button" aria-expanded={alertsOpen} onClick={() => { setAlertsVisited(true); setAlertsOpen(value => !value); }}><Bell size={15}/>机会提醒</button><button className="perp-refresh" type="button" onClick={() => paused ? setInspection(null) : refresh()} disabled={!paused && connection === "paused"}><RefreshCw size={15}/>{paused ? "收起并恢复" : "刷新"}</button></div></header>
    <nav className="perp-workspace-nav" aria-label="合约价差工作区"><button type="button" aria-current={workspace === "opportunities" ? "page" : undefined} onClick={() => setWorkspace("opportunities")}>发现机会</button><button id="perp-positions-tab" type="button" aria-current={workspace === "positions" ? "page" : undefined} onClick={() => { setInspection(null); setWorkspace("positions"); }}>持仓跟踪</button></nav>
    {workspace === "positions" ? <PerpetualPaper active={active}/> : <>
    <div className="perp-health"><div className={`perp-connection ${expired || error || data?.status === "unavailable" ? "is-warning" : ""}`} role="status"><i aria-hidden="true"/>{statusText}<span>{transportText}</span></div><span>覆盖 <b>{data ? availableBases : "—"}</b> 币种 <span className="perp-health-divider">/</span> {expired ? "上次状态：" : ""}<b>{liveExchanges}</b> / {exchanges.length || "—"} 平台在线</span></div>
    {problem ? <div className="perp-notice" role="status">{problem}</div> : null}
    {data?.storageError ? <div className="perp-notice" role="status">快照保存异常：{data.storageError}</div> : null}
    {view === "rank" ? <div className="perp-overview" aria-label="当前筛选机会概览">
      <div><span>有效组合</span><strong>{data ? ranking.length.toLocaleString() : "—"}</strong><small>{netSort ? "按净价差筛选" : "按毛价差筛选"} · {paused ? "查看时快照" : "当前列表"}</small></div>
      <button type="button" onClick={() => updateFilters({ sortBy: "net", priceMode: "book", minSpreadPercent: 0 })}><span>扣费后为正</span><strong>{data && filters.priceMode === "book" ? overview.positive.toLocaleString() : "—"}</strong><small>当前筛选内 · 查看净价差</small></button>
      <div><span>最大净价差</span><strong className={overview.max !== null && overview.max > 0 ? "is-positive" : ""}>{percent(overview.max)}</strong><small>扣往返 taker 与滑点预算</small></div>
      <button type="button" onClick={() => setHealthOpen(true)}><span>报价有效率</span><strong>{quoteSelection.keys.length ? `${Math.round((1 - (quoteQuality.stale + quoteQuality.unavailable) / quoteSelection.keys.length) * 100)}%` : "—"}</strong><small>{quoteQuality.stale} 过期 / {quoteQuality.unavailable} 暂缺 · 查看原因</small></button>
    </div> : null}
    <div className="perp-venue-strip" role="group" aria-label="快速选择交易所">{exchanges.map(exchange => <button key={exchange.id} type="button" aria-pressed={!selected || selected.has(exchange.id)} aria-label={`${!selected || selected.has(exchange.id) ? "排除" : "启用"} ${exchange.name}`} title={`${exchange.name} · ${expired ? "快照过期" : exchangeLabels[exchange.status]} · ${exchange.freshBookCount ?? exchange.quoteCount} 个有效盘口`} onClick={() => toggleExchange(exchange.id)}><i className={expired ? "stale" : exchange.status} aria-hidden="true"/><span>{exchange.name}</span><small>{exchange.freshBookCount ?? exchange.quoteCount}</small></button>)}</div>
    <PerpetualManualPairs snapshot={data} mode={filters.priceMode} now={now} budget={qualityBudget} active={active} paused={paused}/>
    {healthOpen ? <PerpetualHealth active={active} defaultOpen/> : null}
    <div id="perpetual-alert-region" hidden={!alertsOpen}>{alertsVisited ? <PerpetualAlerts active={active && alertsOpen} pair={alertPair} budget={qualityBudget} defaultOpen/> : null}</div>

    <div className="perp-toolbar"><label className="perp-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索币种" placeholder="搜索币种，如 BTC、ETH" value={filters.search} maxLength={40} onChange={event => updateFilters({ search: event.target.value.toUpperCase() })}/>{filters.search ? <button type="button" aria-label="清空搜索" onClick={() => updateFilters({ search: "" })}><X size={14}/></button> : null}</label>
      <button type="button" className="perp-tool-button" title="选择七所并按现货买卖汇率比较；模拟资格由 CrossEx 模块再次核对" onClick={() => { changeView("rank"); updateFilters({ exchanges: ["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"], crossCurrency: true, pairMode: "all", priceMode: "book", search: "", favoritesOnly: false, sortBy: "gross", minSpreadPercent: 0 }); }}>CrossEx 七所</button>
      {view === "rank" ? <label className="perp-sort"><span className="perp-sr-only">价差排序</span><select aria-label="价差排序" value={netSort ? "net" : "gross"} onChange={event => updateFilters({ sortBy: event.target.value as "net" | "gross" })}><option value="gross">毛价差从高到低</option><option value="net">净价差从高到低</option></select></label> : null}
      <button type="button" className={`perp-tool-button ${filters.favoritesOnly ? "is-selected" : ""}`} aria-pressed={filters.favoritesOnly} onClick={() => updateFilters({ favoritesOnly: !filters.favoritesOnly })}><Star size={16}/>自选<span>{favoritePairs.size}{favorites.size ? ` + ${favorites.size} 币` : ""}</span></button><button type="button" className={`perp-tool-button ${filtersOpen ? "is-selected" : ""}`} aria-expanded={filtersOpen} aria-controls="perpetual-filters" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={16}/>筛选<span>{selected ? selected.size : exchanges.length} 平台</span></button>
    </div>
    {filtersOpen ? <div className="perp-filters" id="perpetual-filters"><fieldset><legend>交易所 <button type="button" onClick={() => updateFilters({ exchanges: null })}>全选</button><button type="button" onClick={() => updateFilters({ exchanges: [] })}>清空</button></legend><div className="perp-exchange-options">{exchanges.map(exchange => <label key={exchange.id}><input type="checkbox" checked={!selected || selected.has(exchange.id)} onChange={() => toggleExchange(exchange.id)}/>{exchange.name}<small>{exchange.kind.toUpperCase()}</small><span className={`perp-exchange-state ${exchange.status}`}>{exchangeLabels[exchange.status]}</span></label>)}</div></fieldset>
      <div className="perp-filter-fields"><label>报价口径<select value={filters.priceMode} onChange={event => updateFilters({ priceMode: event.target.value as PerpetualPriceMode })}><option value="book">买卖盘口</option><option value="mark">标记价格 · 仅供参考</option></select></label><label>平台组合<select value={filters.pairMode} onChange={event => updateFilters({ pairMode: event.target.value as PerpetualPairMode })}><option value="all">全部组合</option><option value="cex-dex">CEX ↔ DEX</option><option value="cex-cex">CEX ↔ CEX</option><option value="dex-dex">DEX ↔ DEX</option></select></label><label>最低{netSort ? "净" : "毛"}价差 / %<input type="number" min={-100} max={1000} step="0.01" value={filters.minSpreadPercent} onChange={event => { const value = event.target.valueAsNumber; updateFilters({ minSpreadPercent: Number.isFinite(value) ? Math.max(-100, Math.min(1000, value)) : 0 }); }}/></label><label>计价币范围<select value={filters.crossCurrency ? "cross" : "same"} onChange={event => updateFilters({ crossCurrency: event.target.value === "cross" })}><option value="same">仅相同计价币</option><option value="cross">跨计价币 · 按现货汇率校正</option></select></label></div>
      {favorites.size ? <div className="perp-saved-legacy"><span>旧版币种自选（包含全部组合）</span>{filters.favorites.map(base => <button type="button" key={base} onClick={() => updateFilters({ favorites: filters.favorites.filter(item => item !== base) })}>{base}<X size={12}/><span className="perp-sr-only">移除币种自选</span></button>)}</div> : null}
      {favoritePairs.size ? <details className="perp-blocked"><summary>管理 {favoritePairs.size} 个自选组合</summary><ul>{filters.favoritePairs!.map(key => <li key={key}><span>{pairName(key)}</span><button type="button" onClick={() => updateFilters({ favoritePairs: filters.favoritePairs!.filter(item => item !== key) })}>取消收藏</button></li>)}</ul></details> : null}
      {(filters.blockedPairs?.length ?? 0) > 0 ? <details className="perp-blocked"><summary>已屏蔽 {filters.blockedPairs!.length} 个组合</summary><ul>{filters.blockedPairs!.map(key => <li key={key}><span>{pairName(key)}</span><button type="button" onClick={() => updateFilters({ blockedPairs: filters.blockedPairs!.filter(item => item !== key) })}>恢复</button></li>)}</ul></details> : null}
      <div className="perp-filter-footer"><span>筛选与组合自选保存在当前浏览器</span><button type="button" onClick={resetFilters}>重置筛选</button><button type="button" className="perp-filter-done" onClick={() => setFiltersOpen(false)}>完成</button></div>
    </div> : null}

    <div className="perp-ranking-heading"><div><div className="perp-view-tabs" role="group" aria-label="行情视图"><button type="button" aria-pressed={view === "rank"} onClick={() => changeView("rank")}>价差排名 {view === "rank" ? <span>{ranking.length} 组合</span> : null}</button><button type="button" aria-pressed={view === "quotes"} onClick={() => changeView("quotes")}>全部报价 <span>{quoteSelection.keys.length}</span></button></div><p>{view === "rank" ? `每个组合独立按${netSort ? "净" : "毛"}价差降序；展开详情暂停刷新` : "包含单平台、未配对及过期报价"}</p></div><div className="perp-price-mode" aria-label="报价口径"><button type="button" aria-pressed={filters.priceMode === "book"} className={filters.priceMode === "book" ? "active" : ""} onClick={() => updateFilters({ priceMode: "book" })}>买卖盘口</button><button type="button" aria-pressed={filters.priceMode === "mark"} className={filters.priceMode === "mark" ? "active" : ""} onClick={() => updateFilters({ priceMode: "mark" })}>标记价格</button></div></div>
    <div className="perp-basis"><span>WS 优先 · 快照补充</span><span>{filters.crossCurrency ? "跨计价币 · 现货买卖价换算至 USDT" : "仅比较相同计价币"}</span><span>{filters.priceMode === "book" ? "毛价差未扣手续费与滑点" : "标记价仅供估值参考，不代表可成交价格"}</span>{quoteQuality.stale ? <button type="button" className="perp-stale-count perp-inline-button" onClick={() => setHealthOpen(true)}>{quoteQuality.stale} 条报价过期 · 查看原因</button> : null}{quoteQuality.unavailable ? <span>{quoteQuality.unavailable} 条{filters.priceMode === "book" ? "暂无有效盘口" : "暂无标记价"}</span> : null}</div>
    {view === "rank" ? <>
      <PerpetualFeeSettings budget={qualityBudget} onChange={next => { setInspection(null); setQualityBudget(next); }}/>
      <div className="perp-quality-caption"><span>分别核对：价差持续性、报价收窄证据与资金费收支</span><span>{qualityLoading ? "质量资料更新中 · 保留已获取资料" : qualityReport ? `最近读取 ${stamp(qualityReport.generatedAt)} · 各项按来源时间判断有效性` : "质量资料采集中"}</span></div>
      {qualityError || qualityReport?.error ? <p className="perp-quality-notice" role="status">{qualityError || qualityReport?.error}</p> : null}
    </> : null}
    {filters.crossCurrency ? <p className="perp-currency-warning">{fxError || (fx ? `汇率快照 ${stamp(fx.generatedAt)} · 仅纳入有新鲜买卖汇率的组合；USD 等缺失汇率不假定等于 1。换汇手续费另计。` : "正在读取现货汇率，缺失汇率的跨币组合暂不参与排名。")}</p> : null}
    {filters.crossCurrency && fx ? <details className="perp-fx-details"><summary>查看每条汇率的来源时间与买卖价</summary><div>{["USDC", "USD1", "USDG", "USD"].map(currency => { const rate = fx.rates[currency]; return <p key={currency}><strong>{currency} / USDT</strong> · {rate ? <>买 {rate.bid.toFixed(6)} / 卖 {rate.ask.toFixed(6)} · 源时间 {stamp(rate.at)}{now - rate.at > fx.staleAfterMs ? " · 已过期" : ""}</> : "未纳入"}{fx.reasons?.[currency] ? <span> · {fx.reasons[currency]}</span> : null}</p>; })}</div></details> : null}
    {view === "quotes" ? <><p className="perp-quotes-caption">平台组合与价差阈值仅影响排名。此处保留原始合约单位，独立合约不参与跨所比较。</p><div className="perp-table-wrap"><QuoteDetails quotes={quoteRows} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000} standalone/>{!quoteRows.length ? <div className="perp-empty"><strong>暂无符合条件的报价</strong><p>{!data || !quotes.length ? emptyMessage : "可以调整币种搜索或交易所筛选。"}</p></div> : null}</div></> : <div className="perp-table-wrap"><table className="perp-table"><thead><tr><th scope="col">币种</th><th scope="col">做多 / {filters.priceMode === "book" ? "买入卖一" : "标记价"}</th><th scope="col">做空 / {filters.priceMode === "book" ? "卖出买一" : "标记价"}</th><th scope="col" aria-sort="descending">{netSort ? "净价差" : "毛价差"} <ArrowDown size={12}/><small className="perp-th-note">{netSort ? "扣往返费用 / 滑点" : "附扣费后估算"}</small></th><th scope="col">聚合质量</th><th scope="col">资金费差 / 8h</th><th scope="col">报价时间</th><th scope="col"><span className="perp-sr-only">展开报价</span></th></tr></thead>
      <tbody>{rows.map(row => {
        const rowKey = perpetualSpreadKey(row), isExpanded = expanded === rowKey;
        const detailId = `perp-detail-${encodeURIComponent(rowKey)}`;
        const pairLabel = `${row.base}，做多 ${venues.get(row.long.exchange)?.name ?? row.long.exchange} ${row.long.symbol}，做空 ${venues.get(row.short.exchange)?.name ?? row.short.exchange} ${row.short.symbol}`;
        const quality = qualities.get(rowKey)!;
        const primarySpread = netSort ? row.netSpreadPercent ?? null : row.spreadPercent;
        const isFavorite = favoritePairs.has(rowKey);
        const history = pairQualityHistory(row, qualityReport);
        const historicalDeviation = history && !row.crossCurrency && filters.priceMode === "book" && history.spread.samples >= 30 && history.spread.coverage >= .5 && history.spread.lastAt && now - history.spread.lastAt <= 180_000 && finite(history.spread.mean) ? (row.spreadPercent - history.spread.mean) * 100 : null;
        const longFunding = normalizedFunding8h(row.long, now), shortFunding = normalizedFunding8h(row.short, now);
        const fundingSpread = longFunding === null || shortFunding === null ? null : shortFunding - longFunding;
        return <Fragment key={rowKey}><tr className={isExpanded ? "perp-row-expanded" : undefined}>
          <th scope="row" className="perp-base-cell"><button type="button" className={`perp-star ${isFavorite ? "is-favorite" : ""}`} aria-label={`${isFavorite ? "移除" : "收藏"}组合：${pairLabel}`} aria-pressed={isFavorite} onClick={() => toggleFavorite(row)}><Star size={17} fill={isFavorite ? "currentColor" : "none"}/></button><div><strong>{row.base}</strong><small>{row.crossCurrency ? `${row.long.quoteCurrency} / ${row.short.quoteCurrency}` : row.long.quoteCurrency}<span>{row.fxAdjusted ? "已换汇" : "永续"}</span></small>{favorites.has(row.base) ? <small className="perp-legacy-label">币种自选</small> : null}</div></th>
          <td className="perp-leg perp-long"><span className="perp-mobile-label">做多</span><strong>{venues.get(row.long.exchange)?.name ?? row.long.exchange}<small>{venues.get(row.long.exchange)?.kind.toUpperCase()}</small></strong><small className="perp-leg-symbol">{row.long.symbol}</small><span title={String(row.buyPrice)}>{price(row.buyPrice)} <small>{row.long.quoteCurrency}</small></span><DelistingNotice quote={row.long} now={now}/></td>
          <td className="perp-leg perp-short"><span className="perp-mobile-label">做空</span><strong>{venues.get(row.short.exchange)?.name ?? row.short.exchange}<small>{venues.get(row.short.exchange)?.kind.toUpperCase()}</small></strong><small className="perp-leg-symbol">{row.short.symbol}</small><span title={String(row.sellPrice)}>{price(row.sellPrice)} <small>{row.short.quoteCurrency}</small></span><DelistingNotice quote={row.short} now={now}/></td>
          <td className={`perp-spread ${primarySpread !== null && primarySpread > 0 ? "positive" : primarySpread !== null && primarySpread < 0 ? "negative" : ""}`}><strong>{percent(primarySpread)}</strong><span className="perp-mobile-label">{netSort ? "净价差" : "毛价差"}</span><small className="perp-secondary-spread">{netSort ? "毛" : "净"} {percent(netSort ? row.spreadPercent : row.netSpreadPercent ?? null)}</small>{historicalDeviation !== null ? <small className="perp-deviation">较 1h 均值 {historicalDeviation >= 0 ? "+" : ""}{historicalDeviation.toFixed(1)} bp</small> : null}</td>
          <td className="perp-quality-cell"><span className="perp-mobile-label">聚合质量</span><QualityCell quality={quality} pairLabel={pairLabel} onInspect={() => inspect(row, false, "quality")}/></td>
          <td className={`perp-funding ${fundingSpread !== null && fundingSpread < 0 ? "negative" : ""}`}><span className="perp-mobile-label">费差 / 8h</span><strong>{fundingSpread === null ? "—" : percent(fundingSpread * 100, 4)}</strong></td>
          <td className="perp-time"><time dateTime={new Date(row.updatedAt).toISOString()}>{stamp(row.updatedAt)}</time><small>{age(row.updatedAt, now)}{paused ? now - row.updatedAt > (data?.staleAfterMs ?? 30_000) ? " · 已过期" : " · 已暂停" : ""}</small></td>
          <td className="perp-expand-cell"><button type="button" aria-label={`${isExpanded ? "收起" : "展开"} ${pairLabel} 质量依据与各平台报价`} aria-expanded={isExpanded} aria-controls={detailId} onClick={() => inspect(row, true)}><ChevronDown size={17}/></button></td>
        </tr>{isExpanded ? <tr className="perp-detail-row" id={detailId}><td colSpan={8}>
          <div className="perp-inspection-bar"><p role="status"><strong>行情已暂停</strong> · 保留 {stamp(data?.generatedAt)} 的排名与报价{expired ? " · 已过期，仅供核对" : ""}</p><button type="button" onClick={() => setInspection(null)}>收起并恢复</button></div>
          <div className="perp-detail-navigation"><div role="tablist" aria-label="组合详情" onKeyDown={event => { const tabs: DetailTab[] = ["execution", "quality", "exit", "quotes"]; const index = tabs.indexOf(detailTab); const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null; if (next) { event.preventDefault(); setDetailTab(next); document.getElementById(`${detailId}-tab-${next}`)?.focus(); } }}>{([{ id: "execution", label: "成交与持有" }, { id: "quality", label: "质量依据" }, { id: "exit", label: "平仓与跟踪" }, { id: "quotes", label: "各平台报价" }] as const).map(tab => <button type="button" role="tab" key={tab.id} id={`${detailId}-tab-${tab.id}`} aria-selected={detailTab === tab.id} tabIndex={detailTab === tab.id ? 0 : -1} aria-controls={`${detailId}-content`} onClick={() => setDetailTab(tab.id)}>{tab.label}</button>)}</div><div className="perp-detail-actions">{hubConnected && [row.long.exchange, row.short.exchange].every(id => ["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"].includes(id)) && <button type="button" onClick={() => hubNavigate("crossex", { symbol: row.base, longExchange: row.long.exchange, shortExchange: row.short.exchange })}>在 CrossEx 查看</button>}<button type="button" onClick={() => configureAlert(row)}><Bell size={13}/>设置提醒</button><button type="button" onClick={() => blockPair(row)}><X size={13}/>屏蔽组合</button></div></div>
          <div role="tabpanel" id={`${detailId}-content`} aria-labelledby={`${detailId}-tab-${detailTab}`} className="perp-detail-content">
            {detailTab === "execution" ? <><PerpetualExecution long={row.long} short={row.short} active={active} now={now}/><PerpetualHolding row={row} budget={qualityBudget} now={now} mode={filters.priceMode}/><PerpetualTrend history={history} now={now} crossCurrency={row.crossCurrency}/></> : detailTab === "quality" ? <QualityEvidence row={row} report={qualityReport} quality={quality} venues={venues} now={now} slippagePercent={qualityBudget.slippagePercent}/> : detailTab === "exit" ? <PerpetualExit long={row.long} short={row.short} budget={qualityBudget} active={opportunitiesActive} now={now} onRegistered={() => { setInspection(null); setWorkspace("positions"); document.getElementById("perp-positions-tab")?.focus(); }}/> : <QuoteDetails quotes={detailQuotes} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000}/>}
          </div>
        </td></tr> : null}</Fragment>;
      })}</tbody></table>
      {!rows.length ? <div className="perp-empty"><span aria-hidden="true">—</span><strong>{!data || data.status === "connecting" ? "等待实时报价" : "暂无符合条件的价差"}</strong><p>{emptyMessage}</p>{quotes.length > 0 ? <button type="button" onClick={resetFilters}>重置筛选</button> : null}</div> : null}
    </div>}
    <div className="perp-pagination"><span>{totalItems ? `${(visiblePage - 1) * pageSize + 1}–${Math.min(visiblePage * pageSize, totalItems)} / ${totalItems} ${view === "rank" ? "组合" : "报价"}` : `0 ${view === "rank" ? "组合" : "报价"}`}<small>每页 {pageSize} 条</small></span><div><button type="button" aria-label="上一页" disabled={visiblePage <= 1} onClick={() => changePage(visiblePage - 1)}><ChevronLeft size={16}/></button><span>{visiblePage} / {totalPages}</span><button type="button" aria-label="下一页" disabled={visiblePage >= totalPages} onClick={() => changePage(visiblePage + 1)}><ChevronRight size={16}/></button></div></div>
    <details className="perp-method"><summary>计算口径与数据时间</summary><p>毛价差 =（做空平台价格 ÷ 做多平台价格 − 1）× 100%。买卖盘口取买入卖一、卖出买一；标记价格取两平台标记价。做多与做空必须来自不同在线平台，两腿价格时间相差不超过 5 秒；同一币种的所有有效平台与合约组合分别参与排名，按所选毛价差或净价差从高到低排列。净价差扣除双腿 taker 往返费与滑点预算，尚未计持有期资金费和退出价差；缺失费率的组合不参与净排序。</p><p>资金费差 = 做空腿费率 × 8 ÷ 该腿周期小时数 − 做多腿费率 × 8 ÷ 该腿周期小时数。正值表示按当前费率估算的净收入，负值为净支出；不是已结算收益。资金费或实际周期缺失、超过 5 分钟未更新时显示「—」。</p><p>价格超过 {(data?.staleAfterMs ?? 30_000) / 1000} 秒未更新会退出排名，成交价不会代替缺失盘口。报价时间取两腿较早的价格时间，所有时钟均为北京时间。毛价差未计手续费、滑点、深度和资金费；跨平台对冲仍存在成交差异。</p><p>筛选分权重：市值、市值 / FDV、官方多空拥挤度各 10%，近 1 小时价差持续性 10%，近 24 小时报价收窄证据 40%，资金费收入方向 20%。价差持续存在不代表会收窄；冷启动收窄统计至少积累 12 小时，且需 6 个完整 1h 窗口。只使用真实采样，缺失项不补零；资料不足时暂不评分，分数不代表盈利概率。质量、手续费和资金费差均对应当前行的做多与做空合约组合；净排序依据为扣费后的估算价差，质量分不代表成交容量。1h 历史偏离仅在至少 30 个有效样本、覆盖不低于 50% 时展示，1 bp = 0.01 个百分点。</p><p>每 5 分钟核对交易所公开合约目录；未标记不代表尚未公告，公开接口信息可能不完整。</p><p>最近快照 {stamp(data?.generatedAt)}。展开详情时保留当前列表、页码、平台组合及报价，并暂停本页行情接收；来源时间继续计时，过期值仅供核对。收起、翻页或修改筛选后恢复，后台采集与低频质量资料查询继续运行。页面隐藏或切换监控后暂停接收，返回立即刷新；实时推送中断时自动切换为每 5 秒快照，并尝试恢复推送。</p></details>
    </>}
  </section>;
}

export default memo(PerpetualPanel);

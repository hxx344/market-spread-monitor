"use client";

import { Fragment, memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { ArrowDown, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, Star } from "lucide-react";
import { usePerpetualFeed } from "../hooks/use-perpetual-feed";
import { createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, quoteIsFresh, quotePriceTime, type PerpetualFilters } from "../lib/perpetual-spreads";
import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote } from "../lib/perpetual-types";
import type { SummaryProps } from "../lib/monitor-summary";
import "./perpetual.css";

const preferencesKey = "market-monitor:perpetual:v1";
const pageSize = 30;
const emptyQuotes: PerpetualQuote[] = [];
const emptyExchanges: PerpetualExchange[] = [];
const exchangeLabels = { connecting: "连接中", live: "实时", stale: "已过期", error: "连接异常", disabled: "未启用" };
const clockFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const stamp = (value: number | null | undefined) => value && Number.isFinite(value) ? clockFormat.format(value) : "—";
const percent = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
const age = (time: number, now: number) => `${Math.max(0, Math.floor((now - time) / 1000))} 秒前`;
function price(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 0.00000001) return value.toExponential(4);
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 12 });
}

function QuoteDetails({ quotes, venues, mode, now, staleAfterMs, standalone = false }: { quotes: PerpetualQuote[]; venues: Map<string, PerpetualExchange>; mode: PerpetualPriceMode; now: number; staleAfterMs: number; standalone?: boolean }) {
  return <div className={`perp-detail ${standalone ? "perp-all-quotes" : ""}`}>{!standalone ? <div className="perp-detail-heading"><strong>各平台报价</strong><span>按交易所展示，过期报价仅供核对</span></div> : null}
    <div className="perp-detail-scroll"><table><thead><tr><th>币种 / 交易所 / 合约</th><th>买一 / 卖一</th><th>标记价</th><th>资金费 / 原周期</th><th>折算 / 8h</th><th>下次结算</th><th>价格状态</th></tr></thead>
      <tbody>{quotes.map(quote => {
        const venue = venues.get(quote.exchange);
        const fresh = venue?.status === "live" && quoteIsFresh(quote, mode, now, staleAfterMs);
        const priceTime = quotePriceTime(quote, mode);
        const normalized = normalizedFunding8h(quote, now);
        return <tr key={`${quote.exchange}:${quote.symbol}:${quote.quoteCurrency}`} className={fresh ? undefined : "perp-quote-stale"}>
          <th scope="row" className="perp-quote-identity"><strong>{quote.displayBase ?? quote.base}</strong><span>{venue?.name ?? quote.exchange}</span><small>{quote.symbol} · {quote.quoteCurrency}</small>{quote.comparable === false ? <small className="perp-unit-note">独立合约 · 不参与跨所排行</small> : null}{quote.contractUnit || quote.collateralCurrency ? <small>{quote.contractUnit ? `单位 ${quote.contractUnit}` : ""}{quote.collateralCurrency ? ` · 抵押 ${quote.collateralCurrency}` : ""}</small> : null}</th>
          <td data-label="买一 / 卖一">{price(quote.bid)} / {price(quote.ask)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="标记价">{price(quote.mark)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="资金费 / 原周期">{normalized === null ? "—" : percent(quote.fundingRate! * 100, 4)}<small>{quote.fundingIntervalHours ? `每 ${quote.fundingIntervalHours}h` : "周期未知"}</small></td>
          <td data-label="折算 / 8h">{normalized === null ? "—" : percent(normalized * 100, 4)}</td>
          <td data-label="下次结算">{stamp(quote.nextFundingAt)}<small>北京时间</small></td>
          <td data-label="价格状态">{fresh ? "有效" : Number.isFinite(priceTime) ? "已过期" : mode === "book" ? "暂无盘口" : "暂无标记价"}<small>{stamp(priceTime)} · {quote.transport.toUpperCase()}</small></td>
        </tr>;
      })}</tbody></table></div>
  </div>;
}

function PerpetualPanel({ active = true, onSummary }: SummaryProps & { active?: boolean }) {
  const { data, connection, error, now, refresh } = usePerpetualFeed(active);
  const [filters, setFilters] = useState<PerpetualFilters>(defaultPerpetualFilters);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"rank" | "quotes">("rank");
  const search = useDeferredValue(filters.search);
  const quotes = data?.quotes ?? emptyQuotes;
  const exchanges = data?.exchanges ?? emptyExchanges;
  const venues = useMemo(() => new Map(exchanges.map(exchange => [exchange.id, exchange])), [exchanges]);
  const selected = useMemo(() => filters.exchanges === null ? null : new Set(filters.exchanges), [filters.exchanges]);
  const favorites = useMemo(() => new Set(filters.favorites), [filters.favorites]);
  const selectRanking = useMemo(() => createPerpetualRankingSelector(), []);
  const rankingFilters = useMemo(() => ({ ...filters, search }), [filters, search]);
  const ranking = useMemo(() => data && now ? selectRanking(data, rankingFilters, now) : [], [data, rankingFilters, now, selectRanking]);
  const filteredQuotes = useMemo(() => quotes.filter(quote => (!selected || selected.has(quote.exchange))
    && (!search.trim() || `${quote.base} ${quote.displayBase ?? ""} ${quote.symbol}`.toUpperCase().includes(search.trim().toUpperCase()))
    && (!filters.favoritesOnly || favorites.has(quote.base)))
    .sort((a, b) => a.base.localeCompare(b.base) || a.exchange.localeCompare(b.exchange) || a.symbol.localeCompare(b.symbol)), [quotes, selected, search, filters.favoritesOnly, favorites]);
  const availableBases = useMemo(() => new Set(quotes.map(quote => quote.base)).size, [quotes]);
  const liveExchanges = exchanges.filter(exchange => exchange.status === "live").length;
  const staleQuotes = useMemo(() => now ? quotes.filter(quote => !quoteIsFresh(quote, filters.priceMode, now, data?.staleAfterMs ?? 30_000)).length : 0, [quotes, filters.priceMode, now, data?.staleAfterMs]);
  const totalItems = view === "rank" ? ranking.length : filteredQuotes.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const visiblePage = Math.min(page, totalPages);
  const rows = ranking.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);
  const quoteRows = filteredQuotes.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);
  const detailQuotes = useMemo(() => expanded ? quotes.filter(quote => quote.base === expanded && (!selected || selected.has(quote.exchange))) : [], [quotes, expanded, selected]);

  useEffect(() => {
    function restorePreferences(event?: StorageEvent) {
      if (event && event.key !== preferencesKey) return;
      try { setFilters(parsePerpetualPreferences(localStorage.getItem(preferencesKey))); } catch { /* Browser storage is optional. */ }
      setPreferencesReady(true);
    }
    restorePreferences();
    window.addEventListener("storage", restorePreferences);
    return () => window.removeEventListener("storage", restorePreferences);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify({ version: 1, ...filters })); } catch { /* Filtering remains available with storage disabled. */ }
  }, [filters, preferencesReady]);
  useEffect(() => {
    if (!onSummary) return;
    onSummary({
      status: !data ? "loading" : data.status === "unavailable" ? "error" : connection === "error" || data.status === "snapshot" ? "stale" : data.status === "connecting" ? "loading" : "live",
      fetchedAt: data ? new Date(data.generatedAt).toISOString() : null,
      metrics: [{ label: "覆盖币种", value: data ? String(availableBases) : "—" }, { label: "实时平台", value: data ? `${liveExchanges} / ${exchanges.length}` : "—" }],
      note: "CEX / DEX 永续合约 · 买卖盘口价差",
    });
  }, [data, connection, onSummary, availableBases, liveExchanges, exchanges.length]);

  function updateFilters(update: Partial<PerpetualFilters>) { setFilters(previous => ({ ...previous, ...update })); setPage(1); }
  function toggleExchange(id: string) {
    const next = new Set(filters.exchanges ?? exchanges.map(exchange => exchange.id));
    if (next.has(id)) next.delete(id); else next.add(id);
    updateFilters({ exchanges: next.size === exchanges.length ? null : [...next] });
  }
  function toggleFavorite(base: string) {
    setFilters(previous => ({ ...previous, favorites: previous.favorites.includes(base) ? previous.favorites.filter(item => item !== base) : [...previous.favorites, base] }));
  }
  function resetFilters() { updateFilters({ ...defaultPerpetualFilters, favorites: filters.favorites }); }

  const expired = Boolean(data && now - data.generatedAt > data.staleAfterMs);
  const statusText = connection === "paused" ? "已暂停更新" : !data ? error ? "行情连接异常" : "正在连接行情" : data.status === "unavailable" ? "采集服务未就绪" : expired ? "快照已过期" : connection === "error" ? "更新中断" : data.status === "snapshot" ? "保留快照" : data.status === "connecting" ? "等待首批报价" : data.status === "partial" ? "部分平台在线" : "行情实时更新";
  const transportText = connection === "stream" ? "推送 / 1 秒" : connection === "polling" || connection === "error" ? "快照 / 5 秒" : connection === "paused" ? "切回后恢复" : "优先实时推送";
  const problem = error || data?.error || (data?.status === "unavailable" ? data.note || "请启动完整监控后台，连接交易所实时行情。" : "");
  const emptyMessage = !data ? "正在获取交易所与合约报价…" : data.status === "unavailable" ? "采集服务启动后，这里会显示实时合约价差。" : quotes.length === 0 ? "交易所正在连接，收到首批有效报价后自动更新。" : selected?.size === 0 ? "请至少选择两家交易所。" : filters.favoritesOnly && favorites.size === 0 ? "点击币种旁的星标加入自选，再回来查看。" : "当前筛选下没有有效价差。可以降低阈值、增加平台或切换报价口径。";

  return <section className="perpetual-panel" aria-label="CEX 与 DEX 合约价差监控">
    <header className="perp-heading"><div><h2>合约价差</h2><p>同一币种，比较跨平台做多与做空价格</p></div><button className="perp-refresh" type="button" onClick={refresh} disabled={connection === "paused"}><RefreshCw size={15}/>刷新报价</button></header>
    <div className="perp-health"><div className={`perp-connection ${expired || error || data?.status === "unavailable" ? "is-warning" : ""}`} role="status"><i aria-hidden="true"/>{statusText}<span>{transportText}</span></div><span>覆盖 <b>{data ? availableBases : "—"}</b> 币种 <span className="perp-health-divider">/</span> <b>{liveExchanges}</b> / {exchanges.length || "—"} 平台在线</span></div>
    {problem ? <div className="perp-notice" role="status">{problem}</div> : null}
    {data?.storageError ? <div className="perp-notice" role="status">快照保存异常：{data.storageError}</div> : null}
    <details className="perp-sources"><summary>交易所连接状态<span>{exchanges.length ? `${liveExchanges} / ${exchanges.length} 实时` : "等待连接"}</span><ChevronDown size={14}/></summary><div className="perp-source-list">{exchanges.map(exchange => <div key={exchange.id} className={`perp-source ${exchange.status}`}><strong><i aria-hidden="true"/>{exchange.name}<small>{exchange.kind.toUpperCase()}</small></strong><span>{exchangeLabels[exchange.status]} · {exchange.quoteCount} / {exchange.marketCount} 合约</span>{exchange.error ? <p>{exchange.error}</p> : null}<small>最近消息 {stamp(exchange.lastMessageAt)}</small></div>)}{!exchanges.length ? <p>采集服务连接后显示各平台状态。</p> : null}</div></details>

    <div className="perp-toolbar"><label className="perp-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索币种" placeholder="搜索币种，如 BTC、ETH" value={filters.search} maxLength={40} onChange={event => updateFilters({ search: event.target.value.toUpperCase() })}/></label><button type="button" className={`perp-tool-button ${filters.favoritesOnly ? "is-selected" : ""}`} aria-pressed={filters.favoritesOnly} onClick={() => updateFilters({ favoritesOnly: !filters.favoritesOnly })}><Star size={16}/>自选<span>{favorites.size}</span></button><button type="button" className={`perp-tool-button ${filtersOpen ? "is-selected" : ""}`} aria-expanded={filtersOpen} aria-controls="perpetual-filters" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={16}/>筛选<span>{selected ? selected.size : exchanges.length} 平台</span></button></div>
    {filtersOpen ? <div className="perp-filters" id="perpetual-filters"><fieldset><legend>交易所 <button type="button" onClick={() => updateFilters({ exchanges: null })}>全选</button><button type="button" onClick={() => updateFilters({ exchanges: [] })}>清空</button></legend><div className="perp-exchange-options">{exchanges.map(exchange => <label key={exchange.id}><input type="checkbox" checked={!selected || selected.has(exchange.id)} onChange={() => toggleExchange(exchange.id)}/>{exchange.name}<small>{exchange.kind.toUpperCase()}</small><span className={`perp-exchange-state ${exchange.status}`}>{exchangeLabels[exchange.status]}</span></label>)}</div></fieldset><div className="perp-filter-fields"><label>平台组合<select value={filters.pairMode} onChange={event => updateFilters({ pairMode: event.target.value as PerpetualPairMode })}><option value="all">全部组合</option><option value="cex-dex">CEX ↔ DEX</option><option value="cex-cex">CEX ↔ CEX</option><option value="dex-dex">DEX ↔ DEX</option></select></label><label>最低毛价差 / %<input type="number" min={-100} max={1000} step="0.01" value={filters.minSpreadPercent} onChange={event => { const value = event.target.valueAsNumber; updateFilters({ minSpreadPercent: Number.isFinite(value) ? Math.max(-100, Math.min(1000, value)) : 0 }); }}/></label><label>计价币范围<select value={filters.crossCurrency ? "cross" : "same"} onChange={event => updateFilters({ crossCurrency: event.target.value === "cross" })}><option value="same">仅相同计价币</option><option value="cross">USD / USDT / USDC / USD1 / USDG 跨币比较</option></select></label></div><div className="perp-filter-footer"><span>筛选与自选保存在当前浏览器</span><button type="button" onClick={resetFilters}>重置筛选</button><button type="button" className="perp-filter-done" onClick={() => setFiltersOpen(false)}>完成</button></div></div> : null}

    <div className="perp-ranking-heading"><div><div className="perp-view-tabs" role="group" aria-label="行情视图"><button type="button" aria-pressed={view === "rank"} onClick={() => { setView("rank"); setPage(1); }}>价差排名 <span>{ranking.length}</span></button><button type="button" aria-pressed={view === "quotes"} onClick={() => { setView("quotes"); setPage(1); }}>全部报价 <span>{filteredQuotes.length}</span></button></div><p>{view === "rank" ? "每币种保留最佳组合，按毛价差降序" : "包含单平台、未配对及过期报价"}</p></div><div className="perp-price-mode" aria-label="报价口径"><button type="button" aria-pressed={filters.priceMode === "book"} className={filters.priceMode === "book" ? "active" : ""} onClick={() => updateFilters({ priceMode: "book" })}>买卖盘口</button><button type="button" aria-pressed={filters.priceMode === "mark"} className={filters.priceMode === "mark" ? "active" : ""} onClick={() => updateFilters({ priceMode: "mark" })}>标记价格</button></div></div>
    <div className="perp-basis"><span>{filters.crossCurrency ? "跨计价币比较 · 未做汇率换算" : "仅比较相同计价币"}</span><span>{filters.priceMode === "book" ? "毛价差未扣手续费与滑点" : "标记价仅供估值参考，不代表可成交价格"}</span>{staleQuotes ? <span className="perp-stale-count">{staleQuotes} 条过期报价已排除</span> : null}</div>
    {filters.crossCurrency ? <p className="perp-currency-warning">USD、USDT、USDC、USD1、USDG 按数值直接比较，未换汇；价差可能包含稳定币偏离。</p> : null}
    {view === "quotes" ? <><p className="perp-quotes-caption">平台组合与价差阈值仅影响排名。此处保留原始合约单位，独立合约不参与跨所比较。</p><div className="perp-table-wrap"><QuoteDetails quotes={quoteRows} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000} standalone/>{!quoteRows.length ? <div className="perp-empty"><strong>暂无符合条件的报价</strong><p>{!data || !quotes.length ? emptyMessage : "可以调整币种搜索或交易所筛选。"}</p></div> : null}</div></> : <div className="perp-table-wrap"><table className="perp-table"><thead><tr><th scope="col">币种</th><th scope="col">做多 / {filters.priceMode === "book" ? "买入卖一" : "标记价"}</th><th scope="col">做空 / {filters.priceMode === "book" ? "卖出买一" : "标记价"}</th><th scope="col" aria-sort="descending">毛价差 <ArrowDown size={12}/></th><th scope="col">资金费差 / 8h</th><th scope="col">报价时间</th><th scope="col"><span className="perp-sr-only">展开报价</span></th></tr></thead>
      <tbody>{rows.map(row => <Fragment key={row.base}><tr className={expanded === row.base ? "perp-row-expanded" : undefined}><th scope="row" className="perp-base-cell"><button type="button" className={`perp-star ${favorites.has(row.base) ? "is-favorite" : ""}`} aria-label={`${favorites.has(row.base) ? "移除" : "添加"} ${row.base} 自选`} aria-pressed={favorites.has(row.base)} onClick={() => toggleFavorite(row.base)}><Star size={17} fill={favorites.has(row.base) ? "currentColor" : "none"}/></button><div><strong>{row.base}</strong><small>{row.crossCurrency ? `${row.long.quoteCurrency} / ${row.short.quoteCurrency}` : row.long.quoteCurrency}<span>{row.crossCurrency ? "未换汇" : "永续"}</span></small></div></th><td className="perp-leg perp-long"><span className="perp-mobile-label">做多</span><strong>{venues.get(row.long.exchange)?.name ?? row.long.exchange}<small>{venues.get(row.long.exchange)?.kind.toUpperCase()}</small></strong><span title={String(row.buyPrice)}>{price(row.buyPrice)} <small>{row.long.quoteCurrency}</small></span></td><td className="perp-leg perp-short"><span className="perp-mobile-label">做空</span><strong>{venues.get(row.short.exchange)?.name ?? row.short.exchange}<small>{venues.get(row.short.exchange)?.kind.toUpperCase()}</small></strong><span title={String(row.sellPrice)}>{price(row.sellPrice)} <small>{row.short.quoteCurrency}</small></span></td><td className={`perp-spread ${row.spreadPercent > 0 ? "positive" : row.spreadPercent < 0 ? "negative" : ""}`}><strong>{percent(row.spreadPercent)}</strong><span className="perp-mobile-label">毛价差</span></td><td className={`perp-funding ${row.fundingSpread8h !== null && row.fundingSpread8h < 0 ? "negative" : ""}`}><span className="perp-mobile-label">费差 / 8h</span><strong>{row.fundingSpread8h === null ? "—" : percent(row.fundingSpread8h * 100, 4)}</strong></td><td className="perp-time"><time dateTime={new Date(row.updatedAt).toISOString()}>{stamp(row.updatedAt)}</time><small>{age(row.updatedAt, now)}</small></td><td className="perp-expand-cell"><button type="button" aria-label={`${expanded === row.base ? "收起" : "展开"} ${row.base} 各平台报价`} aria-expanded={expanded === row.base} aria-controls={`perp-detail-${row.base}`} onClick={() => setExpanded(value => value === row.base ? null : row.base)}><ChevronDown size={17}/></button></td></tr>{expanded === row.base ? <tr className="perp-detail-row" id={`perp-detail-${row.base}`}><td colSpan={7}><QuoteDetails quotes={detailQuotes} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000}/></td></tr> : null}</Fragment>)}</tbody></table>
      {!rows.length ? <div className="perp-empty"><span aria-hidden="true">—</span><strong>{!data || data.status === "connecting" ? "等待实时报价" : "暂无符合条件的价差"}</strong><p>{emptyMessage}</p>{quotes.length > 0 ? <button type="button" onClick={resetFilters}>重置筛选</button> : null}</div> : null}
    </div>}
    <div className="perp-pagination"><span>{totalItems ? `${(visiblePage - 1) * pageSize + 1}–${Math.min(visiblePage * pageSize, totalItems)} / ${totalItems} ${view === "rank" ? "币种" : "报价"}` : `0 ${view === "rank" ? "币种" : "报价"}`}<small>每页 {pageSize} 条</small></span><div><button type="button" aria-label="上一页" disabled={visiblePage <= 1} onClick={() => setPage(visiblePage - 1)}><ChevronLeft size={16}/></button><span>{visiblePage} / {totalPages}</span><button type="button" aria-label="下一页" disabled={visiblePage >= totalPages} onClick={() => setPage(visiblePage + 1)}><ChevronRight size={16}/></button></div></div>
    <details className="perp-method"><summary>计算口径与数据时间</summary><p>毛价差 =（做空平台价格 ÷ 做多平台价格 − 1）× 100%。买卖盘口取买入卖一、卖出买一；标记价格取两平台标记价。做多与做空必须来自不同在线平台，两腿价格时间相差不超过 5 秒；每币种选择满足筛选条件的最高价差。</p><p>资金费差 = 做空腿费率 × 8 ÷ 该腿周期小时数 − 做多腿费率 × 8 ÷ 该腿周期小时数。正值表示按当前费率估算的净收入，负值为净支出；不是已结算收益。资金费或实际周期缺失、超过 5 分钟未更新时显示「—」。</p><p>价格超过 {(data?.staleAfterMs ?? 30_000) / 1000} 秒未更新会退出排名，成交价不会代替缺失盘口。报价时间取两腿较早的价格时间，所有时钟均为北京时间。毛价差未计手续费、滑点、深度和资金费；跨平台对冲仍存在成交差异。</p><p>最近快照 {stamp(data?.generatedAt)}。页面隐藏或切换监控后暂停接收，返回立即刷新；实时推送中断时自动切换为每 5 秒快照，并尝试恢复推送。</p></details>
  </section>;
}

export default memo(PerpetualPanel);

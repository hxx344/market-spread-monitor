"use client";

import { memo, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { calculateExchangeSpread, exchangeContracts, exchangeNames, externalExchanges, externalQuoteStale, type Exchange, type ExchangeQuote, type ExternalQuoteSet, type SpreadMarket } from "../lib/exchange-quotes";
import { useExchangeQuotes } from "../hooks/use-exchange-quotes";
import { summaryTimestamp } from "../lib/monitor-summary";
import { startActivityPolling } from "../lib/polling";

const exchanges: Exchange[] = ["hyperliquid", ...externalExchanges];
const signed = (value: number | null | undefined, digits = 2, suffix = "") => { if (value == null) return "—"; const rounded = Number(value.toFixed(digits)); return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(digits)}${suffix}`; };
const tone = (value: number | null | undefined) => value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const price = (value: number | undefined, digits: number) => value === undefined ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rate = (value: number | null) => signed(value === null ? null : value * 100, 5, "%");

function ExchangeComparison({ monitorId, primary, initial, renderedAt, active = true }: { monitorId: SpreadMarket; primary?: ExchangeQuote; initial?: ExternalQuoteSet; renderedAt?: number; active?: boolean }) {
  const { quotes, errors, loading, refresh } = useExchangeQuotes(monitorId, initial, active);
  const [now, setNow] = useState(() => renderedAt ?? Date.now());
  const contracts = exchangeContracts[monitorId], oil = monitorId === "oil";
  useEffect(() => {
    if (!active) return;
    const clock = startActivityPolling({ intervalMs: 5000, load: async () => Date.now(), onData: setNow, onError: () => {} });
    return () => clock.stop();
  }, [active]);
  const rows = exchanges.map(exchange => {
    const secondary = quotes[exchange];
    const quote = primary?.exchange === exchange && (!secondary || Date.parse(primary.fetchedAt) >= Date.parse(secondary.fetchedAt)) ? primary : secondary;
    const error = errors[exchange];
    const stale = Boolean(quote && (error || externalQuoteStale(quote, now)));
    return { exchange, quote, metrics: quote ? calculateExchangeSpread(quote) : null, stale, status: !quote ? error ? "暂不可用" : "等待首次采集" : stale ? "保留数据 · 待更新" : quote.fundingError ? "价格已更新 · 资金费缺失" : "已更新" };
  });
  return <section className="exchange-comparison" aria-label={`${oil ? "原油" : "海力士"}交易所实时对比`} data-exchange-market={monitorId}>
    <div className="exchange-heading"><div><h2>交易所实时对比</h2><p>{oil ? "布伦特 − WTI · 等桶数" : "ADR − 正股 ÷ 10 · 10 份 ADR 对 1 股正股"}</p></div><div><span>Bybit / Binance 每 15 秒更新</span><button type="button" className="refresh-button" onClick={refresh} disabled={loading} aria-label={`刷新${oil ? "原油" : "海力士"}交易所报价`}><RefreshCw size={14} className={loading ? "spinning" : ""}/>{loading ? "更新中" : "刷新"}</button></div></div>
    <Table className="exchange-table">
      <TableHeader><TableRow><TableHead>交易所 / 报价口径</TableHead><TableHead>{contracts.leftLabel} / {oil ? "WTI" : "正股 ÷ 10"}</TableHead><TableHead>价差</TableHead><TableHead>{oil ? "布伦特溢价率" : "ADR 溢价率"}</TableHead><TableHead>做空价差年化</TableHead><TableHead>做多价差年化</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(({ exchange, quote, metrics, stale, status }) => <TableRow key={exchange} data-exchange={exchange} data-stale={stale}>
        <TableCell className="exchange-identity"><strong>{exchangeNames[exchange]}</strong><span>{quote?.currency ?? (exchange === "hyperliquid" ? "USD" : "USDT")} · {quote?.priceBasis === "mid" || (exchange === "hyperliquid" && !oil) ? "中间价" : "标记价"}</span><small className={stale || !quote ? "exchange-stale" : ""}>{status}</small>{quote && <time dateTime={quote.fetchedAt}>{summaryTimestamp(quote.fetchedAt)} 北京时间</time>}</TableCell>
        <TableCell data-label={`${contracts.leftLabel} / ${oil ? "WTI" : "正股 ÷ 10"}`}><span className="exchange-prices"><span>{price(quote?.left.price, oil ? 3 : 2)}</span><span className="exchange-separator" aria-hidden="true">/</span><span>{price(metrics?.equivalent, oil ? 3 : 2)}</span></span><small className="exchange-pair-symbols">{quote ? `${quote.left.symbol} / ${quote.right.symbol}` : `${exchange === "hyperliquid" ? oil ? "xyz:BRENTOIL / xyz:CL" : "xyz:SKHY / xyz:SKHX" : `${contracts.left} / ${contracts.right}`}`}</small></TableCell>
        <TableCell data-label="价差"><strong className={tone(metrics?.spread)}>{signed(metrics?.spread, oil ? 3 : 2)}</strong></TableCell>
        <TableCell data-label={oil ? "布伦特溢价率" : "ADR 溢价率"}><strong className={tone(metrics?.premium)}>{signed(metrics?.premium, 2, "%")}</strong></TableCell>
        <TableCell data-label="做空价差年化"><strong className={tone(metrics?.shortAnnualized)}>{signed(metrics?.shortAnnualized == null ? null : metrics.shortAnnualized * 100, 2, "%")}</strong></TableCell>
        <TableCell data-label="做多价差年化"><strong className={tone(metrics?.longAnnualized)}>{signed(metrics?.longAnnualized == null ? null : metrics.longAnnualized * 100, 2, "%")}</strong></TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <p className="exchange-caption">正值收款，负值付款；按当前费率简单年化，以两腿总名义金额为分母。{oil ? "做空：空布伦特、多 WTI；做多反向。" : "做空：空 ADR、多正股；做多反向。"}</p>
    <details className="exchange-details"><summary>资金费周期与计算口径</summary><div className="exchange-details-body">
      {rows.map(({ exchange, quote }) => <article key={exchange}><strong>{exchangeNames[exchange]}</strong>{quote ? <><p>{quote.left.symbol}：{rate(quote.left.fundingRate)} / {quote.left.fundingIntervalHours ?? "—"} 小时；{quote.right.symbol}：{rate(quote.right.fundingRate)} / {quote.right.fundingIntervalHours ?? "—"} 小时。</p>{quote.fundingFetchedAt && <p>资金费采集：{summaryTimestamp(quote.fundingFetchedAt)} 北京时间。</p>}{quote.left.nextFundingAt && <p>下次结算：{contracts.leftLabel} {summaryTimestamp(quote.left.nextFundingAt)}；{contracts.rightLabel} {summaryTimestamp(quote.right.nextFundingAt)} 北京时间。</p>}{quote.fundingError && <p className="exchange-stale">{quote.fundingError}</p>}</> : <p>尚未取得有效报价。</p>}</article>)}
      <p>净年化 =（空腿名义 × 空腿费率 ÷ 空腿周期小时 − 多腿名义 × 多腿费率 ÷ 多腿周期小时）÷ 两腿总名义 × 8,760。Hyperliquid 名义金额用预言机价格；Bybit、Binance 用标记价格。各腿按各自周期换算。</p>
      <p>{oil ? "布伦特溢价率 =（布伦特价格 ÷ WTI 价格 − 1）× 100%。" : "ADR 溢价率 =（ADR 价格 ÷（正股价格 ÷ 10）− 1）× 100%。USDT 接口报价已完成币种换算，不额外换算韩元。"}USD 与 USDT 分别标注，不假定两者严格等值；各行只计算同一交易所内的两腿。{!oil && "Hyperliquid 沿用当前中间价，另两家使用标记价。"}</p>
      <p>本区为当前费率预估，实际结算费率可能变化。下方历史图表及告警使用 {oil ? 'Binance' : 'Hyperliquid'}。</p>
      <div className="exchange-source-links"><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 规则 ↗</a><a href="https://www.bybit.com/en/help-center/article/Funding-fee-calculation" target="_blank" rel="noreferrer">Bybit 规则 ↗</a><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">Binance 规则 ↗</a></div>
    </div></details>
  </section>;
}

export default memo(ExchangeComparison);

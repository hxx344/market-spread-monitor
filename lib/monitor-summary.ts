import type { LiveQuote } from "./market";

export type SummaryStatus = "loading" | "live" | "snapshot" | "stale" | "error";
export type SummaryMetric = { label: string; value: string; tone?: "positive" | "negative" };
export type MonitorSummary = { status: SummaryStatus; fetchedAt: string | null; metrics: SummaryMetric[]; note?: string };
export type SummaryProps = { onSummary?: (summary: MonitorSummary) => void };
export type OilSummaryUpdate = {
  status: SummaryStatus;
  spread: number | null;
  fundingHourlyRate: number | null;
  fundingBasis: "quantity" | "notional";
  fetchedAt: string | null;
};

function metric(label: string, value: number | null | undefined, digits: number, unit: string): SummaryMetric {
  if (value == null || !Number.isFinite(value)) return { label, value: "—" };
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return { label, value: `${sign}${Math.abs(rounded).toFixed(digits)}${unit}`, tone: rounded > 0 ? "positive" : rounded < 0 ? "negative" : undefined };
}

export function hynixSummary(quote: LiveQuote | null, error = ""): MonitorSummary {
  return {
    status: quote ? error ? "stale" : "live" : error ? "error" : "loading",
    fetchedAt: quote?.fetchedAt ?? null,
    metrics: [metric("ADR 溢价率", quote?.premium, 2, "%"), metric("每份价差 · 美元", quote?.spread, 2, "")],
    note: "1 股正股 = 10 份 ADR",
  };
}

export function oilSummary(update?: OilSummaryUpdate): MonitorSummary {
  return {
    status: update?.status ?? "loading",
    fetchedAt: update?.fetchedAt ?? null,
    metrics: [
      metric("价差 · 美元 / 桶", update?.spread, 3, ""),
      metric("净资金费 / 小时", update?.fundingHourlyRate == null ? null : update.fundingHourlyRate * 100, 5, "%"),
    ],
    note: `空布伦特、多 WTI · ${update?.fundingBasis === "notional" ? "等名义" : "等桶数"}`,
  };
}

const timestamps = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function summaryTimestamp(fetchedAt: string | null) {
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return null;
  return timestamps.format(new Date(fetchedAt));
}

export const summaryStatusLabels: Record<SummaryStatus, string> = {
  loading: "正在获取行情", live: "实时", snapshot: "备用快照", stale: "更新中断 · 保留报价", error: "行情暂不可用",
};

export function summaryExpired(summary: MonitorSummary, intervalMs: number, now: number) {
  return summary.status === "live" && summary.fetchedAt !== null && now - Date.parse(summary.fetchedAt) > intervalMs + 15_000;
}

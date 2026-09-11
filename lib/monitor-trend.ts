export type TrendPoint = { time: number; value: number };
export type TrendHistory = { points: TrendPoint[]; status: "live" | "snapshot" | "stale"; fetchedAt: string };
export type MonitorTrend = {
  points: TrendPoint[];
  intervalMs: number;
  label: string;
  shortLabel: string;
  unit: string;
  status: TrendHistory["status"] | "loading" | "error";
  fetchedAt: string | null;
};

export function createTrend(history: TrendHistory | undefined, options: { days: number; intervalMs: number; label: string; shortLabel: string; unit: string }, error = false): MonitorTrend {
  const valid = [...new Map((history?.points ?? []).filter(point => Number.isFinite(point.time) && Number.isFinite(point.value)).map(point => [point.time, point])).values()].sort((a, b) => a.time - b.time);
  const end = valid.length ? valid.at(-1)!.time + options.intervalMs : 0;
  // Use completed candle periods; a full window contains exactly 30 days / 168 hours.
  const points = valid.filter(point => point.time >= end - options.days * 86_400_000);
  return { ...options, points, status: history ? error ? "stale" : history.status : error ? "error" : "loading", fetchedAt: history?.fetchedAt ?? null };
}

export function trendExpired(trend: MonitorTrend, now: number) {
  const last = trend.points.at(-1);
  return trend.status === "live" && Boolean(last && now - last.time > trend.intervalMs * 2);
}

export function trendGeometry(points: TrendPoint[], intervalMs: number) {
  if (points.length < 2) return null;
  const width = 120, height = 42, padding = 3;
  const first = points[0], last = points.at(-1)!;
  const values = points.map(point => point.value);
  const low = Math.min(...values), high = Math.max(...values);
  const range = high - low;
  const y = (value: number) => range === 0 ? height / 2 : padding + (high - value) / range * (height - padding * 2);
  const plotted = points.map(point => ({ x: padding + (point.time - first.time) / (last.time - first.time) * (width - padding * 2), y: y(point.value) }));
  const groups: typeof plotted[] = [];
  for (let i = 0; i < plotted.length; i++) {
    if (i === 0 || points[i].time - points[i - 1].time > intervalMs) groups.push([]);
    groups.at(-1)!.push(plotted[i]);
  }
  const coord = (point: { x: number; y: number }) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  return {
    segments: groups.filter(group => group.length > 1).map(group => ({
      line: `M${group.map(coord).join(" L")}`,
      area: `M${group[0].x.toFixed(2)},${height} L${group.map(coord).join(" L")} L${group.at(-1)!.x.toFixed(2)},${height} Z`,
    })),
    isolated: groups.filter(group => group.length === 1).map(group => group[0]),
    end: plotted.at(-1)!,
  };
}

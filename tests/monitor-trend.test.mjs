import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrend, trendGeometry, trendExpired } from "../lib/monitor-trend.ts";
import { hynixSummary, oilSummary } from "../lib/monitor-summary.ts";

const hour = 3_600_000, day = hour * 24;
const options = { days: 7, intervalMs: hour, label: "7 天小时线", shortLabel: "7天", unit: "%" };
const history = { status: "live", fetchedAt: "2026-09-11T07:00:00Z" };

test("fixed windows include exactly 168 completed hours or 30 days", () => {
  const hourly = Array.from({ length: 200 }, (_, i) => ({ time: i * hour, value: i }));
  const weekly = createTrend({ ...history, points: hourly }, options);
  assert.equal(weekly.points.length, 168);
  assert.equal(weekly.points[0].time, 32 * hour);
  const daily = Array.from({ length: 50 }, (_, i) => ({ time: i * day, value: i }));
  assert.equal(createTrend({ ...history, points: daily }, { ...options, days: 30, intervalMs: day }).points.length, 30);
});

test("trend input retains valid zero and negative values, sorts and deduplicates without mutation", () => {
  const points = [{ time: 2 * hour, value: -2 }, { time: 0, value: 0 }, { time: hour, value: 8 }, { time: hour, value: -1 }, { time: 3 * hour, value: NaN }];
  const trend = createTrend({ ...history, points }, options);
  assert.deepEqual(trend.points.map(p => p.value), [0, -1, -2]);
  assert.equal(points[0].time, 2 * hour);
});

test("missing hours break both line and fill, while X positions preserve elapsed time", () => {
  const geometry = trendGeometry([0, 1, 4, 5].map(i => ({ time: i * hour, value: i })), hour);
  assert.equal(geometry.segments.length, 2);
  assert.match(geometry.segments[0].line, /^M3\.00,39\.00 L25\.80,/);
  assert.match(geometry.segments[1].line, /^M94\.20,/);
  assert.equal(geometry.end.x, 117);
  assert.equal(geometry.end.y, 3);
});

test("flat series stays centered and insufficient history never creates a fabricated line", () => {
  assert.equal(trendGeometry([], hour), null);
  assert.equal(trendGeometry([{ time: 0, value: 10 }], hour), null);
  const flat = trendGeometry([{ time: 0, value: -5 }, { time: hour, value: -5 }], hour);
  assert.equal(flat.segments[0].line, "M3.00,21.00 L117.00,21.00");
  const isolated = trendGeometry([{ time: 0, value: 1 }, { time: 2 * hour, value: 2 }], hour);
  assert.equal(isolated.segments.length, 0);
  assert.equal(isolated.isolated.length, 2);
});

test("history snapshot status and closing points stay separate from fresh current quotes", () => {
  const snapshot = createTrend({ ...history, status: "snapshot", points: [{ time: 0, value: 10 }, { time: hour, value: 11 }] }, options);
  const summary = hynixSummary({ ordinary: 1000, equivalent: 100, adr: 150, spread: 50, premium: 50, fetchedAt: history.fetchedAt }, "", snapshot);
  assert.equal(summary.status, "live");
  assert.equal(summary.trend.status, "snapshot");
  assert.equal(summary.trend.points.at(-1).value, 11);
  assert.equal(summary.metrics[0].value, "+50.00%");
  assert.equal(createTrend(undefined, options, true).status, "error");
  assert.equal(createTrend({ ...history, points: [] }, options, true).status, "stale");
});

test("oil uses historical 15-minute spreads independently of the current mark spread", () => {
  const summary = oilSummary({ status: "live", spread: 4.25, fundingHourlyRate: 0, fundingBasis: "quantity", fetchedAt: history.fetchedAt, history: { ...history, status: "stale", points: [{ time: 0, value: 3 }, { time: 900_000, value: 3.5 }] } });
  assert.equal(summary.metrics[0].value, "+4.250");
  assert.equal(summary.trend.points.at(-1).value, 3.5);
  assert.equal(summary.trend.status, "stale");
  assert.equal(summary.trend.intervalMs, 900_000);
});

test("old completed candles are marked pending independently of live quote freshness", () => {
  const trend = createTrend({ ...history, points: [{ time: hour, value: 10 }, { time: 2 * hour, value: 11 }] }, options);
  assert.equal(trendExpired(trend, 4 * hour), false);
  assert.equal(trendExpired(trend, 4 * hour + 1), true);
  assert.equal(trendExpired({ ...trend, status: "snapshot" }, 5 * hour), false);
  assert.equal(trendExpired(createTrend(undefined, options), 5 * hour), false);
});

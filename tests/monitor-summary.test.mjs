import { test } from "node:test";
import assert from "node:assert/strict";
import { hynixSummary, oilSummary, summaryExpired, summaryTimestamp } from "../lib/monitor-summary.ts";

const fetchedAt = "2026-09-11T07:00:00.000Z";
const quote = { ordinary: 1500, adr: 180, equivalent: 150, spread: 30, premium: 20, fetchedAt };

test("Hynix card retains last quote and its time when updates fail, then recovers", () => {
  const live = hynixSummary(quote);
  const stale = hynixSummary(quote, "offline");
  assert.equal(live.status, "live");
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.metrics, live.metrics);
  assert.equal(stale.fetchedAt, fetchedAt);
  assert.equal(hynixSummary(null).status, "loading");
  const failed = hynixSummary(null, "offline");
  assert.equal(failed.status, "error");
  assert.ok(failed.metrics.every(metric => metric.value === "—"));
  assert.equal(failed.fetchedAt, null);
  assert.equal(hynixSummary(quote).status, "live");
});

test("oil card converts decimal hourly funding to percent and labels the selected basis", () => {
  const update = { status: "snapshot", spread: 5.4321, fundingHourlyRate: -0.00003125, fundingBasis: "quantity", fetchedAt };
  const snapshot = oilSummary(update);
  assert.equal(snapshot.status, "snapshot");
  assert.equal(snapshot.metrics[0].value, "+5.432");
  assert.equal(snapshot.metrics[1].value, "−0.00313%");
  assert.equal(snapshot.metrics[1].tone, "negative");
  assert.match(snapshot.note, /等桶数/);
  const switched = oilSummary({ ...update, fundingBasis: "notional", fundingHourlyRate: 0.00002 });
  assert.equal(switched.metrics[1].value, "+0.00200%");
  assert.match(switched.note, /等名义/);
  assert.equal(switched.fetchedAt, fetchedAt);
  assert.equal(oilSummary({ ...update, status: "stale" }).status, "stale");
});

test("missing values stay empty and rounded zero never appears negative", () => {
  assert.ok(oilSummary().metrics.every(metric => metric.value === "—"));
  const nearZero = hynixSummary({ ...quote, spread: -0.00001, premium: -0.00001 });
  assert.deepEqual(nearZero.metrics.map(metric => metric.value), ["0.00%", "0.00"]);
  assert.ok(nearZero.metrics.every(metric => !metric.tone));
});

test("summary timestamps include the date and use Beijing time for old retained quotes", () => {
  assert.equal(summaryTimestamp(fetchedAt), "2026/09/11 15:00:00");
  assert.equal(summaryTimestamp(null), null);
  assert.equal(summaryTimestamp("invalid"), null);
});

test("a paused or delayed poll cannot keep an old quote marked live", () => {
  const live = hynixSummary(quote);
  const now = Date.parse(fetchedAt);
  assert.equal(summaryExpired(live, 10_000, now + 25_000), false);
  assert.equal(summaryExpired(live, 10_000, now + 25_001), true);
  assert.equal(summaryExpired({ ...live, status: "snapshot" }, 10_000, now + 60_000), false);
  assert.equal(summaryExpired(hynixSummary(null), 10_000, now), false);
});

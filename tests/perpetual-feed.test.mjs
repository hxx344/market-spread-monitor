import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerpetualSnapshotAccumulator, parsePerpetualSnapshot, startPerpetualFeed } from "../lib/perpetual-feed.ts";

const snapshot = generatedAt => ({ schemaVersion: 1, monitorId: "perpetual", generatedAt, staleAfterMs: 30000, status: "live", exchanges: [], quotes: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetchSnapshot = async () => snapshot(1)) {
  const streams = [], timers = new Map(), data = [], statuses = [], errors = [];
  let id = 0;
  const feed = startPerpetualFeed({
    fetchSnapshot,
    createStream: () => { const stream = { onmessage: null, onerror: null, closed: false, close() { this.closed = true; } }; streams.push(stream); return stream; },
    onData: value => data.push(value), onConnection: value => statuses.push(value), onError: value => errors.push(value),
    schedule: (callback, delay) => { const timer = ++id; timers.set(timer, { callback, delay }); return timer; }, cancel: timer => timers.delete(timer),
  });
  function run(delay) { const timer = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(timer, `missing ${delay}ms timer`); timers.delete(timer[0]); timer[1].callback(); }
  return { feed, streams, timers, data, statuses, errors, run };
}

test("perpetual stream ignores old snapshots, falls back on error and retries streaming", async () => {
  const f = fixture(); await tick();
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(10)) });
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(9)) });
  assert.deepEqual(f.data.map(item => item.generatedAt), [10]);
  assert.equal(f.statuses.at(-1), "stream");
  f.streams[0].onerror(); await tick();
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.statuses.at(-1), "polling");
  f.run(30000); assert.equal(f.streams.length, 2);
  f.streams[1].onmessage({ data: JSON.stringify(snapshot(11)) });
  assert.equal(f.statuses.at(-1), "stream");
  assert.equal([...f.timers.values()].some(timer => timer.delay === 5000), false);
  f.feed.stop(); assert.equal(f.timers.size, 0);
});

test("stop aborts pending requests and rejects late stream callbacks", async () => {
  let finish, signal;
  const f = fixture(input => { signal = input; return new Promise(resolve => { finish = resolve; }); });
  f.feed.refresh();
  const onmessage = f.streams[0].onmessage;
  f.feed.stop();
  assert.equal(signal.aborted, true); assert.equal(f.streams[0].closed, true);
  finish(snapshot(10)); onmessage({ data: JSON.stringify(snapshot(11)) }); await tick();
  assert.equal(f.data.length, 0); assert.equal(f.timers.size, 0);
});

test("silent streams switch to polling, failed requests retry without replacing prior data", async () => {
  let fail = false, calls = 0;
  const f = fixture(async () => { calls++; if (fail) throw Error("offline"); return snapshot(1); });
  await tick(); assert.equal(calls, 0); f.streams[0].onmessage({ data: JSON.stringify(snapshot(1)) }); fail = true;
  f.run(12000); await tick();
  assert.equal(f.statuses.at(-1), "error"); assert.equal(f.data.length, 1);
  f.run(5000); await tick(); assert.equal(calls, 2);
  f.feed.stop();
});

test("delta snapshots preserve untouched quote identities and no-change array identities", () => {
  const merge = createPerpetualSnapshotAccumulator();
  const first = merge({ ...snapshot(1), quotes: [{ exchange: "a", symbol: "BTCUSDT", bid: 100 }, { exchange: "b", symbol: "BTCUSDT", bid: 101 }] });
  const delta = { ...snapshot(2), type: "delta", updates: [], removed: [] }; delete delta.quotes;
  const unchanged = merge(delta); assert.equal(unchanged.quotes, first.quotes);
  const second = merge({ ...delta, generatedAt: 3, updates: [{ exchange: "b", symbol: "BTCUSDT", bid: 102 }] });
  assert.notEqual(second.quotes, first.quotes); assert.equal(second.quotes[0], first.quotes[0]); assert.equal(second.quotes[1].bid, 102);
  const synced = merge(JSON.parse(JSON.stringify({ ...second, generatedAt: 4 })));
  assert.equal(synced.quotes, second.quotes);
  const removed = merge({ ...delta, generatedAt: 5, removed: ["a:BTCUSDT"] });
  assert.equal(removed.quotes.length, 1); assert.equal(removed.quotes[0], second.quotes[1]);
  assert.equal(merge({ ...delta, generatedAt: 4, removed: ["b:BTCUSDT"] }), null);
});

test("a delta without a baseline triggers one snapshot recovery instead of rendering partial markets", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return snapshot(3); });
  await tick(); assert.equal(requests, 0);
  f.streams[0].onmessage({ data: JSON.stringify({ ...snapshot(2), type: "delta", updates: [], removed: [] }) });
  await tick(); assert.equal(requests, 1); assert.equal(f.streams[0].closed, true); assert.equal(f.data[0].generatedAt, 3);
  f.feed.stop();
});

test("visibility lifecycle can stop a feed and resume with a new stream without leaked polls", async () => {
  let requests = 0;
  const hidden = fixture(async () => { requests++; return snapshot(2); });
  hidden.streams[0].onmessage({ data: JSON.stringify(snapshot(1)) }); hidden.feed.stop();
  const resumed = fixture(async () => { requests++; return snapshot(3); });
  resumed.streams[0].onmessage({ data: JSON.stringify(snapshot(3)) }); await tick();
  assert.equal(requests, 0); assert.equal(hidden.timers.size, 0); assert.equal(resumed.data[0].generatedAt, 3);
  resumed.feed.stop();
});

test("invalid schema fails visibly instead of entering the data model", () => {
  assert.throws(() => parsePerpetualSnapshot({ ...snapshot(1), quotes: null }));
  assert.throws(() => parsePerpetualSnapshot({ ...snapshot(1), staleAfterMs: 0 }));
  const f = fixture(); f.streams[0].onmessage({ data: "bad json" });
  assert.equal(f.statuses.at(-1), "polling"); f.feed.stop();
});

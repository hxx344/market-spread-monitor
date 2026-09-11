import { test } from "node:test";
import assert from "node:assert/strict";
import { startPolling, QUOTE_REFRESH_MS } from "../lib/polling.ts";
import { loadQuote } from "../lib/quote-service.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("fetch immediately and at 10-second intervals without overlapping manual refresh",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  let calls=0,resolvePending;
  const results=[];
  const poll=startPolling({intervalMs:QUOTE_REFRESH_MS,load:()=>{calls++;return new Promise(resolve=>{resolvePending=resolve;});},onData:v=>results.push(v),onError:assert.fail});
  await flush(); assert.equal(calls,1);
  t.mock.timers.tick(10_000); void poll.refresh();
  await flush(); assert.equal(calls,1);
  resolvePending(1); await flush();
  t.mock.timers.tick(9_999); await flush(); assert.equal(calls,1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls,2);
  resolvePending(2); await flush();
  assert.deepEqual(results,[1,2]);
  poll.stop(); t.mock.timers.tick(30_000); await flush(); assert.equal(calls,2);
});

test("cancel on unmount and ignore a late result even if transport ignores abort",async()=>{
  let signal,resolvePending;
  const results=[];
  const poll=startPolling({intervalMs:10_000,load:s=>{signal=s;return new Promise(resolve=>{resolvePending=resolve;});},onData:v=>results.push(v),onError:assert.fail});
  await flush(); poll.stop(); assert.equal(signal.aborted,true);
  resolvePending("late"); await flush(); assert.deepEqual(results,[]);
});

test("recover next cycle after a request failure without replacing the last success",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  let calls=0,errors=0,last;
  const poll=startPolling({intervalMs:10_000,load:async()=>{calls++;if(calls===2)throw new Error("offline");return calls;},onData:v=>{last=v;},onError:()=>{errors++;}});
  await flush(); assert.equal(last,1);
  t.mock.timers.tick(10_000); await flush(); assert.equal(last,1);assert.equal(errors,1);
  t.mock.timers.tick(10_000); await flush(); assert.equal(last,3);
  poll.stop();
});

test("read both current mids together and request funding alongside them",async()=>{
  const time=Date.parse("2026-09-11T07:00:00Z");
  const requests=[];
  const quote=await loadQuote(async(url,init)=>{
    assert.equal(url,"https://api.hyperliquid.xyz/info");
    const body=JSON.parse(init.body);
    requests.push(body);
    if(body.type==="metaAndAssetCtxs") return Response.json([{universe:[{name:"xyz:SKHX"},{name:"xyz:SKHY"}]},[{oraclePx:"1500",funding:"0"},{oraclePx:"180",funding:"0"}]]);
    return Response.json({"xyz:SKHX":"1500","xyz:SKHY":"180"});
  },()=>time);
  assert.deepEqual(requests,[{type:"allMids",dex:"xyz"},{type:"metaAndAssetCtxs",dex:"xyz"}]);
  assert.equal(quote.equivalent,150);assert.equal(quote.spread,30);
  assert.ok(Math.abs(quote.premium-20)<1e-10);
  assert.equal(quote.fetchedAt,"2026-09-11T07:00:00.000Z");
  assert.equal(quote.funding.annualizedRate,0);
  assert.equal(quote.funding.fetchedAt,quote.fetchedAt);
});

test("partial, zero, invalid or failed live quotes never become a fresh pair",async()=>{
  for(const body of [{"xyz:SKHX":"1500"},{"xyz:SKHX":"0","xyz:SKHY":"180"},{"xyz:SKHX":"NaN","xyz:SKHY":"180"},null]){
    await assert.rejects(loadQuote(async()=>Response.json(body)));
  }
  await assert.rejects(loadQuote(async()=>Response.json({error:"limited"},{status:429})));
});

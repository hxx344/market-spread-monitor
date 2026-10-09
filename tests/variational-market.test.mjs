import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOilDexReader } from '../lib/oil-dex.ts';
import { parseVariationalFunding, parseVariationalMark, readVariationalAuthenticatedQuote } from '../lib/variational-market.ts';
import { requestVariational } from '../lib/variational-api.ts';
import { calculateExchangeSpread } from '../lib/exchange-quotes.ts';

const NOW = Date.UTC(2026, 9, 9, 10, 32), ORIGIN = 'https://omni.variational.io';
const token = label => `e30.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600, label })).toString('base64url')}.test`;
const TOKEN = token('first'), NEXT_TOKEN = token('second');
const instrument = symbol => ({ underlying: symbol, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' });
const mark = (symbol, now = NOW) => ({ instrument: instrument(symbol), qty: '1', bid: '90', ask: '110', mark_price: symbol === 'BZ' ? '102' : '95', timestamp: new Date(now).toISOString() });
const funding = (symbol, now = NOW) => ({ predicted_funding_rate: symbol === 'BZ' ? '0.2' : '-0.1', funding_interval_s: 14400, next_funding_time: new Date(now + 3_600_000).toISOString() });
const stats = () => ({ listings: [{ ticker: 'BZ', mark_price: '101', funding_interval_s: 14400, funding_rate: '99' }, { ticker: 'CL', mark_price: '94', funding_interval_s: 14400, funding_rate: '99' }] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const delay = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function transport({ calls = [], response = (path, symbol) => path === '/api/quotes/indicative' ? mark(symbol) : funding(symbol) } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(parsed.origin, ORIGIN);
    const symbol = body?.instrument.underlying || parsed.searchParams.get('underlying');
    return await response(parsed.pathname, symbol, options, body, url);
  };
}
function readerFixture({ response, initial = { token: TOKEN, revision: 1 }, publicRequest = async () => stats() } = {}) {
  let state = initial, now = NOW, publicCalls = 0;
  const calls = [], reports = [], keys = [], cache = new Map();
  const session = {
    current: () => ({ ...state }),
    report(revision, status) {
      reports.push({ revision, status });
      if (state.revision === revision && status === 'rejected') state = { ...state, token: null };
    },
  };
  const shared = async (key, ttl, load) => {
    keys.push(key);
    const old = cache.get(key);
    if (old && now < old.until) return old.promise;
    const promise = Promise.resolve().then(load);
    cache.set(key, { until: now + ttl, promise });
    promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
    return promise;
  };
  const fetcher = transport({ calls, response: response || ((path, symbol) => json(path === '/api/quotes/indicative' ? mark(symbol, now) : funding(symbol, now))) });
  const reader = createOilDexReader({ variationalSession: session, shared, fetcher, clock: () => now, request: async url => { publicCalls++; return publicRequest(url); } });
  return { reader, calls, reports, keys, setState: value => { state = value; }, setNow: value => { now = value; }, publicCalls: () => publicCalls };
}

test('authenticated marks require exact CL/BZ commodity identity, quantity, valid bid/ask and fresh source timestamps', () => {
  assert.deepEqual(parseVariationalMark(mark('BZ'), 'BZ', NOW), { price: 102, sourceTime: NOW });
  for (const patch of [
    { instrument: instrument('CL') }, { instrument: { ...instrument('BZ'), kind: 'index' } },
    { instrument: { ...instrument('BZ'), underlying: 'UKOILP' } }, { qty: '2' },
    { mark_price: '' }, { mark_price: null }, { mark_price: '0x10' }, { mark_price: '0' },
    { ask: '89' }, { timestamp: new Date(NOW - 30_001).toISOString() }, { timestamp: new Date(NOW + 2001).toISOString() },
    { timestamp: '2026-10-09T10:32:00' },
  ]) assert.throws(() => parseVariationalMark({ ...mark('BZ'), ...patch }, 'BZ', NOW));
});

test('frontend annual decimal funding converts to period decimal and preserves signed and zero rates', () => {
  const result = parseVariationalFunding(funding('BZ'), NOW);
  assert.equal(result.fundingRate, 0.2 * 4 / 8760);
  assert.equal(result.fundingIntervalHours, 4);
  assert.equal(result.nextFundingAt, '2026-10-09T11:32:00.000Z');
  assert.equal(parseVariationalFunding(funding('CL'), NOW).fundingRate, -0.1 * 4 / 8760);
  assert.equal(parseVariationalFunding({ ...funding('BZ'), predicted_funding_rate: '0' }, NOW).fundingRate, 0);
  for (const patch of [
    { predicted_funding_rate: '' }, { predicted_funding_rate: null }, { predicted_funding_rate: 'Infinity' },
    { funding_interval_s: 0 }, { funding_interval_s: 14401 }, { funding_interval_s: 90000 },
    { next_funding_time: new Date(NOW).toISOString() }, { next_funding_time: new Date(NOW + 14400 * 1000 + 60_001).toISOString() },
  ]) assert.throws(() => parseVariationalFunding({ ...funding('BZ'), ...patch }, NOW));
});

test('reader consumes token on exactly four read-only requests, caches by revision and estimates from current marks', async () => {
  const fixture = readerFixture();
  const [quote, second] = await Promise.all([fixture.reader('variational'), fixture.reader('variational')]);
  assert.deepEqual(quote, second); assert.equal(fixture.calls.length, 4); assert.equal(fixture.publicCalls(), 0);
  assert.equal(quote.left.price, 102); assert.equal(quote.right.price, 95); assert.equal(quote.timestampBasis, 'source');
  assert.equal(quote.fundingError, ''); assert.equal(quote.left.fundingPrice, quote.left.price);
  assert.ok(Math.abs(calculateExchangeSpread(quote).shortAnnualized - (102 * 0.2 + 95 * 0.1) / 197) < 1e-12);
  const post = fixture.calls.filter(call => call.options.method === 'POST');
  assert.deepEqual(post.map(call => JSON.parse(call.options.body)), ['BZ', 'CL'].map(symbol => ({ instrument: instrument(symbol), qty: '1' })));
  for (const { options } of fixture.calls) {
    assert.equal(options.headers.Cookie, `vr-token=${TOKEN}`); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
  }
  assert.deepEqual(fixture.calls.filter(call => call.options.method === 'GET').map(call => call.url), ['BZ', 'CL'].map(symbol => `${ORIGIN}/api/funding/v2?underlying=${symbol}&instrument_type=perpetual_rwa_future`));
  assert.ok(fixture.keys.every(key => !key.includes(TOKEN) && !key.includes(NEXT_TOKEN)));
  assert.ok(!JSON.stringify(quote).includes(TOKEN));
  fixture.setNow(NOW + 500); assert.equal((await fixture.reader('variational')).fetchedAt, quote.fetchedAt);
  assert.equal(fixture.calls.length, 4);
});

test('one missing or invalid funding leg preserves authenticated marks and removes both rates', async () => {
  for (const failure of ['network', 'schema', 'past']) {
    const fixture = readerFixture({ response: (path, symbol) => {
      if (path === '/api/quotes/indicative') return json(mark(symbol));
      if (symbol === 'BZ') {
        if (failure === 'network') throw Error('private upstream details');
        return json({ ...funding(symbol), ...(failure === 'schema' ? { predicted_funding_rate: null } : { next_funding_time: new Date(NOW - 1).toISOString() }) });
      }
      return json(funding(symbol));
    } });
    const quote = await fixture.reader('variational');
    assert.equal(quote.left.price, 102); assert.equal(quote.right.price, 95);
    assert.equal(quote.left.fundingRate, null); assert.equal(quote.right.fundingRate, null); assert.equal(quote.fundingFetchedAt, null);
    assert.equal(calculateExchangeSpread(quote).shortAnnualized, null); assert.equal(fixture.publicCalls(), 0);
    assert.match(quote.fundingError, /预测资金费/); assert.equal(fixture.reports.at(-1).status, 'unavailable');
  }
});

test('a rejected token from any authenticated endpoint falls back to public marks without public or old funding', async () => {
  const fixture = readerFixture({ response: (path, symbol) => path === '/api/funding/v2' && symbol === 'CL' ? json({ error: TOKEN }, 401) : json(path === '/api/quotes/indicative' ? mark(symbol) : funding(symbol)) });
  const quote = await fixture.reader('variational');
  assert.equal(quote.left.price, 101); assert.equal(quote.right.price, 94); assert.equal(quote.timestampBasis, 'received');
  assert.equal(quote.left.fundingRate, null); assert.equal(quote.right.fundingRate, null); assert.equal(quote.fundingFetchedAt, null);
  assert.match(quote.fundingError, /token 已失效或被拒绝/); assert.ok(!JSON.stringify(quote).includes(TOKEN));
  assert.deepEqual(fixture.reports, [{ revision: 1, status: 'rejected' }]);
  await fixture.reader('variational'); assert.equal(fixture.calls.length, 4);
});

test('transient mark failure or mismatched source timestamps uses public marks and keeps token retryable', async () => {
  for (const failure of ['network', 'skew']) {
    const fixture = readerFixture({ response: (path, symbol) => {
      if (path === '/api/quotes/indicative' && symbol === 'CL') {
        if (failure === 'network') throw Error(TOKEN);
        return json(mark(symbol, NOW - 15001));
      }
      return json(path === '/api/quotes/indicative' ? mark(symbol) : funding(symbol));
    } });
    const quote = await fixture.reader('variational');
    assert.equal(quote.left.price, 101); assert.match(quote.fundingError, /认证行情暂不可用/);
    assert.equal(quote.left.fundingRate, null); assert.equal(quote.fundingFetchedAt, null);
    assert.deepEqual(fixture.reports, [{ revision: 1, status: 'unavailable' }]);
  }
});

test('old successful or rejected in-flight revisions are discarded and retried using the new token', async () => {
  for (const oldDenied of [false, true]) {
    const gate = delay(), started = delay(); let oldCalls = 0;
    const fixture = readerFixture({ response: async (path, symbol, options) => {
      if (options.headers.Cookie === `vr-token=${TOKEN}`) {
        if (++oldCalls === 4) started.resolve();
        await gate.promise;
        if (oldDenied) return json({}, 403);
      }
      return json(path === '/api/quotes/indicative' ? mark(symbol) : funding(symbol));
    } });
    const pending = fixture.reader('variational'); await started.promise;
    fixture.setState({ token: NEXT_TOKEN, revision: 2 }); gate.resolve();
    const quote = await pending;
    assert.equal(quote.left.price, 102); assert.equal(fixture.calls.length, 8); assert.equal(fixture.publicCalls(), 0);
    assert.deepEqual(fixture.reports, [{ revision: 2, status: 'ready' }]);
    assert.ok(fixture.keys.includes('variational/oil/authenticated/2'));
  }
});

test('a token saved while public fallback is pending supersedes either its stale success or failure', async () => {
  for (const failed of [false, true]) {
    const gate = delay(), started = delay();
    const fixture = readerFixture({ initial: { token: null, revision: 0 }, publicRequest: async () => { started.resolve(); await gate.promise; if (failed) throw Error('old public failure'); return stats(); } });
    const pending = fixture.reader('variational'); await started.promise;
    fixture.setState({ token: TOKEN, revision: 1 }); gate.resolve();
    const quote = await pending;
    assert.equal(quote.timestampBasis, 'source'); assert.equal(quote.left.price, 102); assert.equal(fixture.calls.length, 4);
  }
});

test('missing token only calls public stats and explicitly withholds funding', async () => {
  const fixture = readerFixture({ initial: { token: null, revision: 0 } });
  const quote = await fixture.reader('variational');
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.publicCalls(), 1); assert.equal(quote.left.fundingRate, null);
  assert.match(quote.fundingError, /尚无有效 Var token/);
});

test('expired and previously rejected sessions remain explicit while using public marks', async () => {
  for (const [status, reason] of [['expired', /token 已过期/], ['rejected', /token 已失效或被拒绝/]]) {
    const fixture = readerFixture({ initial: { token: null, revision: 1, status } });
    const quote = await fixture.reader('variational');
    assert.equal(fixture.calls.length, 0); assert.equal(quote.fundingFetchedAt, null); assert.match(quote.fundingError, reason);
  }
});

test('a cached prediction is withheld immediately when its settlement timestamp passes', async () => {
  const fixture = readerFixture({ response: (path, symbol) => json(path === '/api/quotes/indicative' ? mark(symbol) : { ...funding(symbol), next_funding_time: new Date(NOW + 300).toISOString() }) });
  const initial = await fixture.reader('variational'); assert.notEqual(initial.left.fundingRate, null);
  fixture.setNow(NOW + 500);
  const quote = await fixture.reader('variational');
  assert.equal(fixture.calls.length, 4); assert.equal(quote.left.price, 102);
  assert.equal(quote.left.fundingRate, null); assert.equal(quote.right.fundingRate, null); assert.equal(quote.fundingFetchedAt, null);
  assert.match(quote.fundingError, /结算时间已到/);
});

test('funding transport runtime allowlist cannot send credentials to foreign hosts, other markets, or arbitrary query parameters', async () => {
  let calls = 0;
  for (const path of ['https://evil.invalid/api/funding/v2', '/funding/v2', '/funding/v2?underlying=BTC&instrument_type=perpetual_rwa_future', '/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future&redirect=https://evil.invalid', '/funding/v2?underlying=BZ&instrument_type=swap', '/orders/new/market']) {
    await assert.rejects(requestVariational(path, TOKEN, { fetcher: async () => { calls++; return json({}); } }));
  }
  assert.equal(calls, 0);
});

test('no invalid authenticated mark can be relabeled as a mark using bid/ask', async () => {
  const fetcher = transport({ response: (path, symbol) => json(path === '/api/quotes/indicative' ? { ...mark(symbol), mark_price: undefined } : funding(symbol)) });
  await assert.rejects(readVariationalAuthenticatedQuote(TOKEN, { fetcher, clock: () => NOW }), /数值无效/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { initialCrossExSettings, openCrossExSettingsStore } from '../server/perpetual-crossex-store.mjs';
import { createCrossExFilterService } from '../server/perpetual-crossex-service.mjs';
import { parseSpotTransfer, createSpotTransferReader, spotTransferEvidence, SPOT_TRANSFER_TTL_MS } from '../server/perpetual-spot-transfer.mjs';
import { createOpportunitiesV2Reader, createPerpetualOpportunitiesV2 } from '../server/perpetual-opportunities-v2.mjs';
import { createPerpetualOpportunities } from '../server/perpetual-opportunities.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';
import { createHandler } from '../server/http.mjs';

const NOW = 1790000000000, ADDRESS = '0x1234567890123456789012345678901234567890';
const bMarket = (base = 'BTC') => ({ symbol: `${base}USDT`, baseAsset: base, status: 'TRADING', isSpotTradingAllowed: true });
const bCoin = (base = 'BTC', network = 'BTC', contract = null) => ({ coin: base, trading: true, isLegalMoney: false, depositAllEnable: true, withdrawAllEnable: true, depositHideAll: false, withdrawHideAll: false,
  networkList: [{ coin: base, network, contractAddress: contract, depositEnable: true, withdrawEnable: true, depositHideEnable: false, withdrawHideEnable: false, busy: false }] });
const gMarket = (base = 'BTC') => ({ id: `${base}_USDT`, base, trade_status: 'tradable' });
const gCoin = (base = 'BTC', name = 'BTC', addr = '') => ({ currency: base, delisted: false, trade_disabled: false, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false,
  chains: [{ name, addr, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false }] });
const parsed = (exchange, base = 'BTC', coin) => exchange === 'binance'
  ? parseSpotTransfer(exchange, { symbols: [bMarket(base)] }, { code: '000000', data: [coin ?? bCoin(base)] })
  : parseSpotTransfer(exchange, [gMarket(base)], [coin ?? gCoin(base)]);
const leg = (exchange, base = 'BTC', bid = exchange === 'binance' ? 99 : 103) => ({ exchange, symbol: `${base}${exchange === 'gate' ? '_' : ''}USDT`, base, rawBase: base, quoteCurrency: 'USDT', collateralCurrency: 'USDT', multiplier: 1, assetClass: 'crypto', identityVerified: true, crossexVerified: true, identitySource: 'official fixture', comparable: true, delisting: false, delistingAt: null, bid, ask: bid + 1, bidAskAt: NOW, receivedAt: NOW });
const data = (at = NOW) => new Map(['binance', 'gate'].map(id => [id, { at, assets: parsed(id) }]));
const memoryStore = (enabled = false) => { let state = initialCrossExSettings(); state.config.requireSpotTransfer = enabled; return { get: () => structuredClone(state), save: async next => { state = structuredClone(next); } }; };
const snapshot = quotes => ({ status: 'live', quotes, exchanges: [...new Set(quotes.map(q => q.exchange))].map(id => ({ id, kind: 'cex', status: 'live' })) });
const project = (quotes, filter, now = NOW) => createPerpetualOpportunitiesV2(snapshot(quotes), now, (exchange, symbol) => quotes.find(q => q.exchange === exchange && q.symbol === symbol), null, filter);
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-crossex-filter-'));
  t.after(async () => { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('monitor-crossex-filter-')) throw new Error('Unsafe cleanup'); await rm(dir, { force: true, recursive: true }); });
  return dir;
}

test('requires both tradable spot assets and a shared bidirectional network with matching identity', () => {
  const metadata = data();
  assert.deepEqual(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), { networks: ['BTC'], checkedAt: NOW, expiresAt: NOW + SPOT_TRANSFER_TTL_MS });
  for (const patch of [{ status: 'BREAK' }, { isSpotTradingAllowed: false }, { isSpotTradingAllowed: undefined }]) {
    const assets = parseSpotTransfer('binance', { symbols: [{ ...bMarket(), ...patch }] }, { code: '000000', data: [bCoin()] });
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), new Map([...metadata, ['binance', { at: NOW, assets }]]), NOW), null);
  }
  const b = bCoin('ABC', 'ETH', ADDRESS), g = gCoin('ABC', 'ETH', ADDRESS.toUpperCase().replace('0X', '0x'));
  const pair = () => new Map([['binance', { at: NOW, assets: parsed('binance', 'ABC', b) }], ['gate', { at: NOW, assets: parsed('gate', 'ABC', g) }]]);
  assert.ok(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW));
  g.chains[0].addr = `0x${'f'.repeat(40)}`;
  assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW), null);
  g.chains[0].addr = ''; b.networkList[0].contractAddress = '';
  assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW), null, 'unknown tokens cannot inherit native identities');
});

test('suspended, delayed, hidden, missing status, mismatched network and split deposit/withdraw paths fail closed', () => {
  for (const mutate of [
    c => { c.withdraw_disabled = true; }, c => { c.withdraw_delayed = true; }, c => { c.trade_disabled = true; }, c => { c.delisted = true; },
    c => { c.chains[0].deposit_disabled = true; }, c => { delete c.chains[0].withdraw_disabled; }, c => { c.chains[0].withdraw_delayed = true; },
    c => { c.chains[0].name = 'LIGHTNING'; }, c => { c.chains = []; },
    c => { c.chains[0].withdraw_disabled = true; c.chains.push({ ...c.chains[0], deposit_disabled: true, withdraw_disabled: false }); },
  ]) {
    const coin = gCoin(); mutate(coin); const metadata = data(); metadata.get('gate').assets = parsed('gate', 'BTC', coin);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  for (const mutate of [c => { c.withdrawAllEnable = false; }, c => { c.depositHideAll = true; }, c => { c.networkList[0].busy = true; }, c => { delete c.networkList[0].depositEnable; }]) {
    const coin = bCoin(); mutate(coin); const metadata = data(); metadata.get('binance').assets = parsed('binance', 'BTC', coin);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  assert.throws(() => parseSpotTransfer('gate', [gMarket()], [gCoin(), gCoin()]), /重复/);
});

test('missing, failed, stale and future evidence cannot be revived by the response clock', () => {
  for (const at of [NOW - SPOT_TRANSFER_TTL_MS, NOW + 1, null, NaN]) assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), data(at), NOW), null);
  const metadata = data(); metadata.get('gate').error = 'unavailable';
  assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  assert.equal(spotTransferEvidence(leg('binance'), leg('bybit'), data(), NOW), null);
});

test('public adapters enforce HTTP/result schema and proxy-cache age without credentials', async () => {
  const calls = [];
  const read = createSpotTransferReader({ clock: () => NOW, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return Response.json(url.includes('exchangeInfo') ? { symbols: [bMarket()] } : { code: '000000', data: [bCoin()] }, { headers: { Age: '10' } });
  } });
  const result = await read('binance', new AbortController().signal);
  assert.equal(result.at, NOW - 10000); assert.ok(result.assets.get('BTC').spotSymbols.length);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.init.method === 'GET' && c.init.redirect === 'error' && !c.init.headers.Authorization));
  for (const response of [Response.json({}, { status: 401 }), Response.json({}, { headers: { Age: '180' } }), Response.json({ code: 'oops' })]) {
    const fail = createSpotTransferReader({ clock: () => NOW, fetchImpl: async () => response.clone() });
    await assert.rejects(fail('binance', new AbortController().signal));
  }
});

test('server configuration persists, validates inputs and serializes revision conflicts', async t => {
  const dir = await directory(t), store = await openCrossExSettingsStore(dir), service = createCrossExFilterService({ store, clock: () => NOW });
  assert.equal(service.view().config.requireSpotTransfer, false);
  await service.update({ revision: 0, config: { requireSpotTransfer: true } });
  const reopened = await openCrossExSettingsStore(dir); assert.equal(reopened.get().config.requireSpotTransfer, true);
  for (const config of [{}, { requireSpotTransfer: 'true' }, { requireSpotTransfer: true, extra: true }]) await assert.rejects(service.update({ revision: 1, config }));
  const results = await Promise.allSettled([service.update({ revision: 1, config: { requireSpotTransfer: false } }), service.update({ revision: 1, config: { requireSpotTransfer: true } })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.status, 409);
  const broken = createCrossExFilterService({ store: { get: reopened.get, save: async () => { throw new Error('disk'); } } });
  await assert.rejects(broken.update({ revision: 1, config: { requireSpotTransfer: false } }), /保存失败/);
  assert.equal(broken.view().config.requireSpotTransfer, true);
  await writeFile(join(dir, 'crossex-settings.json'), '{bad'); await assert.rejects(openCrossExSettingsStore(dir), /无法读取/);
});

test('optional filter precedes the 200-signal cap and retains every quote for existing positions', () => {
  const quotes = Array.from({ length: 230 }, (_, n) => [leg('binance', `T${n}`), leg('gate', `T${n}`, 500 - n)]).flat();
  const plain = project(quotes); assert.equal(plain.signals.length, 200);
  const filter = { enabled: true, evaluate: (long) => Number(long.base.slice(1)) >= 205 ? { networks: ['ETH'], checkedAt: NOW, expiresAt: NOW + 500 } : null };
  const filtered = project(quotes, filter); assert.equal(filtered.signals.length, 25); assert.deepEqual(filtered.quotes, plain.quotes);
  assert.ok(filtered.signals.every(s => s.expiresAt === NOW + 500 && Number(s.base.slice(1)) >= 205));
  assert.deepEqual(project(quotes, { enabled: false }).signals, plain.signals);
  const legacyQuotes = [leg('binance'), leg('bybit')], legacy = snapshot(legacyQuotes);
  assert.equal(createPerpetualOpportunities(legacy, NOW, undefined, { enabled: true, evaluate: () => null }).signals.length, 0);
  assert.equal(createPerpetualOpportunities(legacy, NOW, undefined, { enabled: true, evaluate: () => null }).quotes.length, 2);
});

test('background updates invalidate cached projections; requests never poll and failures never freshen metadata', async t => {
  let now = NOW, calls = 0, fails = false;
  const service = createCrossExFilterService({ store: memoryStore(), clock: () => now, read: async exchange => { calls++; if (fails) throw new Error('offline'); return { at: now - SPOT_TRANSFER_TTL_MS + 1000, assets: parsed(exchange) }; } });
  t.after(() => service.stop()); service.start(); await service.refresh(); assert.equal(calls, 0);
  const quotes = [leg('binance'), leg('gate')], input = snapshot(quotes), read = createOpportunitiesV2Reader();
  const readFeed = () => read(input, now, (e, s) => quotes.find(q => q.exchange === e && q.symbol === s), null, 'same-book', service.filter());
  assert.equal(readFeed().signals.length, 1);
  await service.update({ revision: 0, config: { requireSpotTransfer: true } }); await service.refresh();
  assert.equal(readFeed().signals.length, 1); assert.equal(readFeed().signals[0].expiresAt, NOW + 1000); assert.equal(calls, 2);
  now += 1000; assert.equal(readFeed().signals.length, 0); assert.equal(calls, 2);
  await service.refresh(); assert.equal(readFeed().signals.length, 1);
  const at = service.view().venues[0].checkedAt; fails = true; await service.refresh();
  assert.equal(readFeed().signals.length, 0); assert.equal(service.view().venues[0].checkedAt, at); assert.equal(service.view().venues[0].state, 'error');
  await service.update({ revision: 1, config: { requireSpotTransfer: false } }); assert.equal(readFeed().signals.length, 1);
});

test('disabled settings cancel in-flight metadata; the late result cannot revive the old generation', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createCrossExFilterService({ store: memoryStore(true), clock: () => NOW, read: async exchange => { await pending; return { at: NOW, assets: parsed(exchange) }; } });
  t.after(() => service.stop()); service.start();
  await service.update({ revision: 0, config: { requireSpotTransfer: false } }); release(); await service.refresh();
  assert.ok(service.view().venues.every(v => v.checkedAt === null));
});

test('settings HTTP shares existing authentication and persists changes without signal GET network access', async t => {
  const dir = await directory(t); let calls = 0;
  const store = await openCrossExSettingsStore(dir), service = createPerpetualService({ exchanges: [], crossexOptions: { store, read: async () => { calls++; throw new Error('offline'); } } });
  const server = createServer(createHandler({ services: new Map([['perpetual', service]]), username: 'fixture', password: 'fixture-password', nextHandler: (_q, r) => { r.writeHead(404); r.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.stop(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/`, headers = { Authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}crossex-settings`)).status, 401);
  const body = JSON.stringify({ revision: 0, config: { requireSpotTransfer: true } });
  assert.equal((await fetch(`${url}crossex-settings`, { headers: { ...headers, Origin: 'https://example.com' }, method: 'PUT', body })).status, 403);
  const saved = await fetch(`${url}crossex-settings`, { headers, method: 'PUT', body }); assert.equal(saved.status, 200); assert.equal((await saved.json()).config.requireSpotTransfer, true);
  assert.equal((await fetch(`${url}crossex-settings`, { headers, method: 'PUT', body })).status, 409);
  const response = await fetch(`${url}opportunities-v2`, { headers }); assert.equal(response.status, 200); assert.equal(calls, 0);
  assert.equal((await openCrossExSettingsStore(dir)).get().config.requireSpotTransfer, true);
});

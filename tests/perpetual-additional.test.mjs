import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDITIONAL_EXCHANGES, discoverAdditionalMarkets, createAdditionalSubscriptions, parseAdditionalMessage, getAdditionalControlResponse } from '../modules/perpetual/additional-exchanges.mjs';

const rhData = { code: 200, order_book_details: [
  { symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active' },
  { symbol: 'OPENAI', market_id: 3, market_type: 'perp', status: 'active' },
  { symbol: 'ETH/USDG', market_id: 2048, market_type: 'spot', status: 'active' },
  { symbol: 'OLD', market_id: 4, market_type: 'perp', status: 'inactive' },
  { symbol: 'SNDK', market_id: 5, market_type: 'perp', status: 'active' },
  { symbol: 'AI', market_id: 6, market_type: 'perp', status: 'active' },
] };
const entropyData = { collateralToken: 0, universe: [{ name: 'io:SNDK' }, { name: 'io:OAI' }, { name: 'io:DRAM' }, { name: 'io:NEW' }, { name: 'io:OLD', isDelisted: true }, { name: 'xyz:SNDK' }] };
const response = value => async () => ({ ok: true, json: async () => value });

test('additional discovery uses separate production venues and isolates nonstandard units', async () => {
  assert.deepEqual(ADDITIONAL_EXCHANGES.map(item => item.id), ['rh-lighter', 'entropy']);
  const calls = [];
  const rh = await discoverAdditionalMarkets('rh-lighter', { fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => rhData }; } });
  assert.equal(calls[0].url, 'https://api.rh.lighter.xyz/api/v1/orderBookDetails');
  assert.equal(rh.length, 4);
  assert.equal(rh[0].quoteCurrency, 'USDG');
  assert.equal(rh[0].marketId, 0);
  assert.notEqual(rh[1].base, 'OPENAI');
  assert.equal(rh[2].base, 'EQUITY:SNDK');
  assert.notEqual(rh[3].base, 'AI');
  assert.equal(rh[3].comparable, false);
  const entropy = await discoverAdditionalMarkets('entropy', { fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => entropyData }; } });
  assert.deepEqual(JSON.parse(calls[1].options.body), { type: 'meta', dex: 'io' });
  assert.equal(entropy.length, 4);
  assert.equal(entropy[0].base, 'EQUITY:SNDK');
  assert.equal(entropy[0].quoteCurrency, 'USDC');
  assert.equal(entropy[1].displayBase, 'OAI');
  assert.notEqual(entropy[1].base, 'OAI');
  assert.match(entropy[1].contractUnit, /10 亿/);
  assert.notEqual(entropy[2].base, 'DRAM');
  assert.notEqual(entropy[3].base, 'NEW');
  await assert.rejects(discoverAdditionalMarkets('entropy', { fetchImpl: response({ ...entropyData, collateralToken: 8 }) }), /抵押/);
  await assert.rejects(discoverAdditionalMarkets('rh-lighter', { fetchImpl: response({ code: 500 }) }), /目录/);
});

test('subscriptions use BBO streams, bounded batches, heartbeat and correct market namespaces', async () => {
  const rh = await discoverAdditionalMarkets('rh-lighter', { fetchImpl: response(rhData) });
  const entropy = await discoverAdditionalMarkets('entropy', { fetchImpl: response(entropyData) });
  const first = createAdditionalSubscriptions('rh-lighter', [...rh, ...entropy])[0];
  assert.equal(first.url, 'wss://api.rh.lighter.xyz/stream?readonly=true');
  assert.deepEqual(first.subscribe.slice(0, 2), [{ type: 'subscribe', channel: 'market_stats/all' }, { type: 'subscribe', channel: 'ticker/0' }]);
  assert.deepEqual(getAdditionalControlResponse('rh-lighter', { type: 'ping' }), { type: 'pong' });
  const second = createAdditionalSubscriptions('entropy', [...rh, ...entropy])[0];
  assert.equal(second.url, 'wss://api.hyperliquid.xyz/ws');
  assert.equal(second.subscribe[0].subscription.coin, 'io:SNDK');
  assert.equal(second.subscribe[0].subscription.type, 'bbo');
  assert.equal(second.subscribe[1].subscription.type, 'activeAssetCtx');
  assert.deepEqual(createAdditionalSubscriptions('entropy', rh), []);
});

test('rh-Lighter BBO timestamps, zero-sized removal and funding percentage stay distinct', async () => {
  const markets = await discoverAdditionalMarkets('rh-lighter', { fetchImpl: response(rhData) });
  const context = {};
  const bbo = { channel: 'ticker:0', type: 'subscribed/ticker', ticker: { s: 'ETH', b: { price: '2634.64', size: '14.2' }, a: { price: '2635.12', size: '1.4' }, last_updated_at: 1789825429882830 } };
  const [first] = parseAdditionalMessage('rh-lighter', bbo, markets, 1789825429900, context);
  assert.equal(first.sourceTime, 1789825429882);
  assert.equal(first.bid, 2634.64);
  assert.equal(first.ask, 2635.12);
  const stale = { ...bbo, ticker: { ...bbo.ticker, last_updated_at: 1789825429000000 } };
  assert.deepEqual(parseAdditionalMessage('rh-lighter', stale, markets, 1789825430000, context), []);
  const [removed] = parseAdditionalMessage('rh-lighter', { ...bbo, ticker: { ...bbo.ticker, a: { price: '2635.12', size: '0' } } }, markets);
  assert.equal(removed.ask, null);
  const stats = { channel: 'market_stats:all', type: 'update/market_stats', timestamp: 1789825430000, market_stats: { 0: { symbol: 'ETH', market_id: 0, mark_price: '2634.88', last_trade_price: '2634.97', current_funding_rate: '0.0012', funding_rate: '9', best_bid_price: '2600' } } };
  const [current] = parseAdditionalMessage('rh-lighter', stats, markets);
  assert.ok(Math.abs(current.fundingRate - 0.000012) < 1e-15);
  assert.equal(current.fundingIntervalHours, 1);
  assert.equal(Object.hasOwn(current, 'bid'), false);
  stats.market_stats[0].current_funding_rate = '0';
  assert.equal(parseAdditionalMessage('rh-lighter', stats, markets)[0].fundingRate, 0);
  assert.deepEqual(parseAdditionalMessage('rh-lighter', { ...bbo, ticker: { ...bbo.ticker, s: 'BTC' } }, markets), []);
});

test('Entropy accepts only its own BBO and context without inventing quote or event times', async () => {
  const markets = await discoverAdditionalMarkets('entropy', { fetchImpl: response(entropyData) });
  const bbo = { channel: 'bbo', data: { coin: 'io:SNDK', time: 1789825353896, bbo: [{ px: '1781.7', sz: '0.1254' }, { px: '1781.8', sz: '1.0867' }] } };
  const [first] = parseAdditionalMessage('entropy', bbo, markets);
  assert.equal(first.bid, 1781.7);
  assert.equal(first.ask, 1781.8);
  assert.equal(first.sourceTime, 1789825353896);
  assert.equal(first.contractUnit, '每股');
  assert.equal(first.comparable, true);
  const [preipo] = parseAdditionalMessage('entropy', { ...bbo, data: { ...bbo.data, coin: 'io:OAI' } }, markets);
  assert.equal(preipo.comparable, false);
  assert.match(preipo.contractUnit, /10 亿/);
  assert.deepEqual(parseAdditionalMessage('entropy', { ...bbo, data: { ...bbo.data, coin: 'SNDK' } }, markets), []);
  const [removed] = parseAdditionalMessage('entropy', { ...bbo, data: { ...bbo.data, bbo: [null, { px: '1781.8', sz: '1' }] } }, markets);
  assert.equal(removed.bid, null);
  const [ctx] = parseAdditionalMessage('entropy', { channel: 'activeAssetCtx', data: { coin: 'io:SNDK', ctx: { funding: '-0.0000026713', markPx: '1780.1', midPx: '1781.75' } } }, markets);
  assert.equal(ctx.fundingRate, -0.0000026713);
  assert.equal(ctx.mark, 1780.1);
  assert.equal(ctx.sourceTime, null);
  assert.equal(Object.hasOwn(ctx, 'bid'), false);
  assert.equal(Object.hasOwn(ctx, 'last'), false);
});

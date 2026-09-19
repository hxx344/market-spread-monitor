import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGES, normalizeUnderlying, classifyMarketIdentity, discoverMarkets, createSubscriptions, parseMessage, getControlResponse } from '../modules/perpetual/exchanges.mjs';

const NOW = 1_789_820_000_000;
function market(exchange, symbol = 'BTCUSDT', extra = {}) {
  return { id: `${exchange}:${symbol}`, exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, fundingIntervalHours: 8, ...extra };
}
function reader(handler) {
  return async (url, options) => ({ ok: true, status: 200, json: async () => handler(url, options) });
}

test('normalizes explicit contract baskets without guessing arbitrary digit or namespace symbols', () => {
  assert.deepEqual(normalizeUnderlying('1000PEPE'), { base: 'PEPE', multiplier: 1000 });
  assert.deepEqual(normalizeUnderlying('1000000MOG'), { base: 'MOG', multiplier: 1000000 });
  assert.deepEqual(normalizeUnderlying('kBONK', 'hyperliquid'), { base: 'BONK', multiplier: 1000 });
  for (const base of ['1INCH', '1000NEW', 'KAS', 'XYZ:TSLA']) assert.deepEqual(normalizeUnderlying(base), { base, multiplier: 1 });
});

test('Binance market discovery excludes inverse, delivery, delisted and TradFi; reads funding intervals', async () => {
  const good = { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' };
  const result = await discoverMarkets('binance', { fetchImpl: reader(url => url.endsWith('fundingInfo') ? [{ symbol: good.symbol, fundingIntervalHours: 4 }] : { symbols: [good, { ...good, symbol: 'BTCUSDT', baseAsset: 'BTC' }, { ...good, symbol: 'OLD', status: 'SETTLING' }, { ...good, symbol: 'INVERSE', marginAsset: 'PEPE' }, { ...good, symbol: 'FUTURE', contractType: 'CURRENT_QUARTER' }, { ...good, symbol: 'STOCK', contractType: 'TRADIFI_PERPETUAL' }] }) });
  assert.equal(result.length, 2);
  assert.equal(result.find(row => row.base === 'PEPE').multiplier, 1000);
  assert.equal(result.find(row => row.base === 'PEPE').fundingIntervalHours, 4);
  assert.equal(result.find(row => row.base === 'BTC').fundingIntervalHours, 8);
});

test('failed funding metadata never assigns a guessed funding interval', async () => {
  const fetchImpl = reader(url => {
    if (url.endsWith('fundingInfo')) throw new Error('timeout');
    return { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' }] };
  });
  assert.equal((await discoverMarkets('binance', { fetchImpl }))[0].fundingIntervalHours, null);
});

test('Bybit follows pagination and filters prelisting or dated contracts', async () => {
  const good = { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', fundingInterval: 240 };
  const calls = [];
  const result = await discoverMarkets('bybit', { fetchImpl: reader(url => {
    calls.push(url);
    return { retCode: 0, result: { list: url.includes('cursor=') ? [{ ...good, symbol: 'ETHUSDT', baseCoin: 'ETH' }, { ...good, symbol: 'PRE', isPreListing: true }, { ...good, symbol: 'FUT', contractType: 'LinearFutures' }] : [good], nextPageCursor: url.includes('cursor=') ? '' : 'page+2' } };
  }) });
  assert.equal(result.length, 2);
  assert.equal(result[0].fundingIntervalHours, 4);
  assert.match(calls[1], /cursor=page%2B2/);
  await assert.rejects(discoverMarkets('bybit', { fetchImpl: reader(() => ({ retCode: 0, result: { list: [], nextPageCursor: 'repeat' } })) }), /repeated pagination/);
});

test('discovery respects Hyperliquid denomination and excludes spot or inactive Lighter markets', async () => {
  const hl = await discoverMarkets('hyperliquid', { fetchImpl: reader(() => ({ universe: [{ name: 'BTC' }, { name: 'HYPE' }, { name: 'PURR' }, { name: 'kPEPE' }, { name: 'xyz:BTC' }, { name: 'OLD', isDelisted: true }] })) });
  assert.equal(hl.length, 4);
  assert.equal(hl.find(row => row.base === 'BTC').quoteCurrency, 'USDT');
  assert.equal(hl.find(row => row.base === 'HYPE').quoteCurrency, 'USDC');
  assert.equal(hl.find(row => row.base === 'PEPE').multiplier, 1000);
  const lighter = await discoverMarkets('lighter', { fetchImpl: reader(() => ({ code: 200, order_book_details: [{ symbol: '1000PEPE', market_id: 4, status: 'active', market_type: 'perp', multiplier: '1', funding_premium_multiplier: 100 }, { symbol: 'BTC/USDC', market_id: 2001, status: 'active', market_type: 'spot' }, { symbol: 'OLD', market_id: 10, status: 'inactive', market_type: 'perp' }] })) });
  assert.equal(lighter.length, 1);
  assert.equal(lighter[0].multiplier, 1000);
  assert.equal(lighter[0].marketId, 4);
});

test('Binance and Aster book ticker prices normalize while mark frames never refresh the book', () => {
  for (const exchange of ['binance', 'aster']) {
    const markets = [market(exchange, '1000PEPEUSDT', { base: 'PEPE', multiplier: 1000 })];
    const [book] = parseMessage(exchange, JSON.stringify({ stream: '1000pepeusdt@bookTicker', data: { e: 'bookTicker', s: '1000PEPEUSDT', b: '.01', a: '.0101', T: NOW - 1 } }), markets, NOW);
    assert.equal(book.bid, .00001); assert.equal(book.ask, .0000101); assert.equal(book.sourceTime, NOW - 1);
    const [mark] = parseMessage(exchange, { e: 'markPriceUpdate', s: '1000PEPEUSDT', p: '.01', r: '0', T: NOW + 10000, E: NOW }, markets, NOW);
    assert.equal(mark.fundingRate, 0); assert.equal(mark.mark, .00001); assert.equal(Object.hasOwn(mark, 'bid'), false); assert.equal(Object.hasOwn(mark, 'ask'), false);
    assert.deepEqual(parseMessage(exchange, { e: 'bookTicker', s: '1000PEPEUSDT', b: '1', a: '2', st: 2 }, markets, NOW), []);
  }
});

test('Bybit delta preserves missing fields and invalid or empty quote explicitly clears an old value', () => {
  const markets = [market('bybit')], context = {};
  parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'snapshot', ts: NOW, data: { symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '101', fundingRate: '0.0001' } }, markets, NOW, context);
  const [delta] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', type: 'delta', ts: NOW + 1, data: { markPrice: '105' } }, markets, NOW + 1, context);
  assert.equal(delta.mark, 105); assert.equal(Object.hasOwn(delta, 'bid'), false); assert.equal(Object.hasOwn(delta, 'fundingRate'), false);
  const [empty] = parseMessage('bybit', { topic: 'tickers.BTCUSDT', ts: NOW, data: { bid1Price: '', ask1Price: 'NaN' } }, markets, NOW);
  assert.equal(empty.bid, null); assert.equal(empty.ask, null);
  assert.deepEqual(parseMessage('bybit', { op: 'subscribe', success: true }, markets), []);
});

test('OKX funding uses upcoming fundingTime and derives interval without emitting prices', () => {
  const [row] = parseMessage('okx', { arg: { channel: 'funding-rate' }, data: [{ instId: 'BTC-USDT-SWAP', fundingRate: '-0.0001', fundingTime: String(NOW + 1000), nextFundingTime: String(NOW + 1000 + 4 * 3600000), ts: String(NOW) }] }, [market('okx', 'BTC-USDT-SWAP')], NOW);
  assert.equal(row.nextFundingAt, NOW + 1000); assert.equal(row.fundingIntervalHours, 4); assert.equal(row.fundingRate, -.0001); assert.equal(Object.hasOwn(row, 'mark'), false);
});

test('Gate and Bitget parse ticker prices without inventing executable BBOs from last or mark', () => {
  const [gate] = parseMessage('gate', { channel: 'futures.tickers', event: 'update', time_ms: NOW, result: [{ contract: 'BTC_USDT', mark_price: '101', last: '102', funding_rate: '0' }] }, [market('gate', 'BTC_USDT')], NOW);
  assert.equal(gate.fundingRate, 0); assert.equal(Object.hasOwn(gate, 'bid'), false); assert.equal(Object.hasOwn(gate, 'nextFundingAt'), false);
  const [bitget] = parseMessage('bitget', { arg: { channel: 'ticker', instId: 'BTCUSDT' }, data: [{ bidPr: '100', askPr: '101', lastPr: '102', ts: String(NOW), fundingRate: '' }] }, [market('bitget')], NOW);
  assert.equal(bitget.bid, 100); assert.equal(bitget.ask, 101); assert.equal(bitget.fundingRate, null);
});

test('Hyperliquid distinguishes BBO, mark and missing source timestamp', () => {
  const markets = [market('hyperliquid', 'BTC')];
  const [book] = parseMessage('hyperliquid', { channel: 'bbo', data: { coin: 'BTC', time: NOW, bbo: [{ px: '100' }, null] } }, markets, NOW);
  assert.equal(book.bid, 100); assert.equal(book.ask, null);
  const [ctx] = parseMessage('hyperliquid', { channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { markPx: '101', funding: '0.00001' } } }, markets, NOW);
  assert.equal(ctx.sourceTime, null); assert.equal(ctx.fundingIntervalHours, 1); assert.equal(Object.hasOwn(ctx, 'bid'), false);
});

test('Lighter BBO uses market ID, handles microseconds, and funding uses current percentage points only', () => {
  const markets = [market('lighter', '1000PEPE', { marketId: 4, base: 'PEPE', multiplier: 1000, quoteCurrency: 'USDC' })];
  const [book] = parseMessage('lighter', { channel: 'ticker:4', type: 'update/ticker', ticker: { a: { price: '.0101' }, b: { price: '.01' }, last_updated_at: NOW * 1000 } }, markets, NOW);
  assert.equal(book.bid, .00001); assert.equal(book.sourceTime, NOW);
  const [stats] = parseMessage('lighter', { channel: 'market_stats:all', timestamp: NOW, market_stats: { 4: { market_id: 4, current_funding_rate: '0.0012', funding_rate: '0.08', mark_price: '.01', best_bid_price: '5', best_ask_price: '6' } } }, markets, NOW);
  assert.ok(Math.abs(stats.fundingRate - 0.000012) < 1e-12); assert.equal(stats.fundingIntervalHours, 1); assert.equal(Object.hasOwn(stats, 'bid'), false);
  const [missing] = parseMessage('lighter', { channel: 'market_stats:4', timestamp: NOW, market_stats: { market_id: 4, funding_rate: '0.08', mark_price: '.01' } }, markets, NOW);
  assert.equal(Object.hasOwn(missing, 'fundingRate'), false);
});

test('subscription shards fit connection caps and keep Binance public/market endpoints separate', () => {
  assert.equal(EXCHANGES.length, 10);
  const markets = Array.from({ length: 451 }, (_, i) => market('lighter', `COIN${i}`, { marketId: i }));
  const lighter = createSubscriptions('lighter', markets);
  assert.equal(lighter.length, 2); assert.equal(lighter[0].subscribe.length, 451); assert.equal(lighter[0].sendIntervalMs, 400); assert.ok(lighter[1].startDelayMs >= 180000);
  const aster = createSubscriptions('aster', markets.map(row => ({ ...row, exchange: 'aster' })));
  assert.ok(aster.every(spec => spec.subscribe[0].params.length <= 200));
  const binance = createSubscriptions('binance', [market('binance')]);
  assert.ok(binance[0].url.includes('/public/')); assert.ok(binance[1].url.includes('/market/'));
  assert.deepEqual(createSubscriptions('okx', []), []);
});

test('application heartbeats are answered and malformed control messages yield no quotes', () => {
  assert.deepEqual(getControlResponse('lighter', '{"type":"ping"}'), { type: 'pong' });
  assert.equal(getControlResponse('okx', 'ping'), 'pong');
  assert.equal(getControlResponse('bitget', 'pong'), null);
  assert.deepEqual(parseMessage('binance', 'broken', []), []);
});

test('Bybit orderbook level 1 snapshots confirm unchanged current prices independently of ticker deltas', () => {
  const [book] = parseMessage('bybit', { topic: 'orderbook.1.BTCUSDT', type: 'snapshot', ts: NOW, cts: NOW - 60000, data: { s: 'BTCUSDT', b: [['100', '2']], a: [['101', '0']], u: 44 } }, [market('bybit')], NOW);
  assert.equal(book.bid, 100); assert.equal(book.ask, null); assert.equal(book.sourceTime, NOW);
  const specs = createSubscriptions('bybit', [market('bybit')]);
  assert.ok(specs[0].subscribe[0].args.includes('orderbook.1.BTCUSDT'));
});

test('subscription errors surface for reconnection; OKX mark-price specifies instrument type', () => {
  for (const [exchange, payload] of [['bybit', { success: false, ret_msg: 'Invalid symbol' }], ['okx', { event: 'error', code: '60012', msg: 'Invalid request' }], ['hyperliquid', { channel: 'error', data: 'Invalid subscription' }], ['gate', { error: { code: 2, message: 'Invalid request' } }]]) assert.throws(() => parseMessage(exchange, payload, []), /WebSocket/);
  const specs = createSubscriptions('okx', [market('okx', 'BTC-USDT-SWAP')]);
  assert.ok(specs[0].subscribe.flatMap(row => row.args).filter(row => row.channel === 'mark-price').every(row => row.instType === 'SWAP'));
});

test('official asset categories prevent stock-versus-token collisions for BB, CAT and ON', () => {
  const cases = [
    ['okx', 'BB', { instCategory: '3', ruleType: 'normal' }],
    ['gate', 'CAT', { contract_type: 'stocks', is_pre_market: false }],
    ['bybit', 'ON', { symbolType: 'stock', marketRegion: 'US', underlyingTicker: 'ON' }],
    ['aster', 'NVDA', { underlyingSubType: ['STOCK', 'Semiconductor'], symbolType: 1 }],
    ['lighter', 'BB', { funding_premium_multiplier: 50 }],
  ];
  for (const [exchange, raw, metadata] of cases) {
    const identity = classifyMarketIdentity(exchange, raw, metadata);
    assert.notEqual(identity.base, raw);
    assert.equal(identity.comparable, false);
    assert.equal(identity.multiplier, 1);
  }
  assert.equal(classifyMarketIdentity('binance', 'BB', { contractType: 'PERPETUAL', underlyingSubType: [] }).assetClass, 'crypto');
  assert.equal(classifyMarketIdentity('gate', 'ON', { contract_type: '' }).assetClass, 'crypto');
});

test('pre-IPO specifications and missing Lighter identity metadata stay venue-specific', () => {
  const identities = [
    classifyMarketIdentity('okx', 'OPENAI', { instCategory: '3', ruleType: 'pre_market' }),
    classifyMarketIdentity('gate', 'OPENAI', { contract_type: 'stocks', is_pre_market: true }),
    classifyMarketIdentity('aster', 'OPENAI', { underlyingSubType: ['pre-launch', 'STOCK'], symbolType: 1 }),
    classifyMarketIdentity('lighter', 'OPENAI', { funding_premium_multiplier: 1 }),
  ];
  assert.equal(new Set(identities.map(row => row.base)).size, identities.length);
  assert.ok(identities.every(row => row.comparable === false));
  assert.equal(classifyMarketIdentity('lighter', 'BTC', {}).base, 'LIGHTER:UNVERIFIED:BTC');
  assert.equal(classifyMarketIdentity('lighter', 'BTC', { funding_premium_multiplier: 100 }).assetClass, 'crypto');
  assert.equal(classifyMarketIdentity('gate', 'EDGE', {}).base, 'GATE:EDGE:DEFINITIVE');
  assert.equal(classifyMarketIdentity('binance', 'EDGE', {}).base, undefined);
  assert.equal(classifyMarketIdentity('lighter', 'AI', { funding_premium_multiplier: 100 }).base, 'LIGHTER:AI:ARTIFICIAL-INU');
  assert.equal(classifyMarketIdentity('aster', 'MEME', { symbolType: 0 }).base, 'ASTER:MEME:A-MEME-COIN');
  const asterAI = classifyMarketIdentity('aster', 'AI', { symbolType: 0 });
  assert.equal(asterAI.base, 'ASTER:AI:CONTRACT');
  assert.equal(asterAI.comparable, false);
  assert.match(asterAI.identitySource, /0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18/);
  assert.equal(classifyMarketIdentity('okx', 'AI', { instCategory: '1' }).base, undefined);
});

test('verified US share contracts match Entropy while crypto or unknown units never inherit that identity', () => {
  for (const base of ['SNDK', 'NBIS', 'GPRO', 'IONQ']) {
    const metadata = { symbolType: 'stock', marketRegion: 'US', underlyingTicker: base };
    const identity = classifyMarketIdentity('bybit', base, metadata);
    assert.equal(identity.base, `EQUITY:${base}`); assert.equal(identity.comparable, true); assert.equal(identity.multiplier, 1);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, marketRegion: 'HK' }).base, identity.base);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, underlyingTicker: 'OTHER' }).base, identity.base);
    assert.notEqual(classifyMarketIdentity('bybit', base, { ...metadata, symbolType: '' }).base, identity.base);
  }
});

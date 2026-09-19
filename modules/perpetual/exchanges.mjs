/** Public, unauthenticated perpetual market adapters. No trading/account endpoints.
 * Protocol references were checked on 2026-09-19; see EXCHANGES[].docsUrl.
 * Prices are per underlying coin; fundingRate is a decimal per funding interval.
 * parseMessage returns PARTIAL updates. Missing fields must never refresh old BBOs.
 */
import { ADDITIONAL_EXCHANGES, discoverAdditionalMarkets, createAdditionalSubscriptions, parseAdditionalMessage, getAdditionalControlResponse } from './additional-exchanges.mjs';

export const EXCHANGES = Object.freeze([
  { id: 'binance', name: 'Binance', type: 'cex', website: 'https://www.binance.com', docsUrl: 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public' },
  { id: 'bybit', name: 'Bybit', type: 'cex', website: 'https://www.bybit.com', docsUrl: 'https://bybit-exchange.github.io/docs/v5/websocket/public/ticker' },
  { id: 'okx', name: 'OKX', type: 'cex', website: 'https://www.okx.com', docsUrl: 'https://www.okx.com/docs-v5/en/' },
  { id: 'bitget', name: 'Bitget', type: 'cex', website: 'https://www.bitget.com', docsUrl: 'https://www.bitget.com/api-doc/classic/contract/websocket/public/Tickers-Channel' },
  { id: 'gate', name: 'Gate', type: 'cex', website: 'https://www.gate.com', docsUrl: 'https://www.gate.com/docs/developers/futures/ws/en/' },
  { id: 'hyperliquid', name: 'Hyperliquid', type: 'dex', website: 'https://app.hyperliquid.xyz', docsUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions' },
  { id: 'lighter', name: 'Lighter', type: 'dex', website: 'https://app.lighter.xyz', docsUrl: 'https://apidocs.lighter.xyz/docs/websocket-reference' },
  { id: 'aster', name: 'Aster', type: 'dex', website: 'https://www.asterdex.com', docsUrl: 'https://asterdex.github.io/aster-api-website/futures/websocket-market-streams/' },
  ...ADDITIONAL_EXCHANGES,
].map(row => ({ ...row, kind: row.type })));

const HOUR = 3_600_000;
const STABLE_QUOTES = new Set(['USDT', 'USDC', 'USD1']);
// Explicit underlying names avoid stripping numbers from actual tokens such as 1INCH.
const SCALED_BASES = new Set(['PEPE', 'SHIB', 'BONK', 'FLOKI', 'LUNC', 'XEC', 'SATS', 'RATS', 'CAT', 'CHEEMS', 'BABYDOGE', 'WHY', 'MOG', 'TOSHI', 'NOT', 'BTT', 'DOGS', 'TURBO', 'MUMU', 'NEIRO', 'APU']);
const HL_SCALED = new Set(['kPEPE', 'kSHIB', 'kBONK', 'kFLOKI', 'kLUNC', 'kDOGS']);
const VERIFIED_US_SHARES = new Set(['SNDK', 'NBIS', 'GPRO', 'IONQ']);

function number(value, positive = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && (!positive || result > 0) ? result : null;
}

function timestamp(value, unit = 'ms') {
  const n = number(value, true);
  if (n === null) return null;
  return unit === 's' ? n * 1000 : unit === 'us' ? Math.floor(n / 1000) : n;
}

export function normalizeUnderlying(rawBase, exchange = '') {
  const raw = String(rawBase ?? '');
  if (exchange === 'hyperliquid' && HL_SCALED.has(raw)) return { base: raw.slice(1).toUpperCase(), multiplier: 1000 };
  const match = raw.toUpperCase().match(/^(1000|10000|100000|1000000|10000000)([A-Z][A-Z0-9]*)$/);
  if (match && SCALED_BASES.has(match[2])) return { base: match[2], multiplier: Number(match[1]) };
  // Preserve namespaces, e.g. HIP-3 assets, instead of guessing equivalence.
  return { base: raw.toUpperCase(), multiplier: 1 };
}

function market(exchange, symbol, rawBase, quoteCurrency, extra = {}) {
  return { id: `${exchange}:${symbol}`, exchange, symbol, rawBase, ...normalizeUnderlying(rawBase, exchange), quoteCurrency, ...extra };
}

/** Symbols are not asset identities. Classified non-crypto contracts are isolated
 * until their underlying, unit and corporate-action treatment are verified.
 * Official fields: Bybit symbolType/underlyingTicker; OKX instCategory/ruleType;
 * Gate contract_type/is_pre_market; Aster underlyingSubType/symbolType.
 * Lighter's documented FundingPremiumMultiplier is 1 for crypto, 1/2 for RWA,
 * 1/100 for pre-IPO; orderBookDetails encodes those as 100, 50 and 1.
 * https://docs.lighter.xyz/trading/funding
 */
export function classifyMarketIdentity(exchange, rawBase, metadata = {}) {
  const raw = String(rawBase).toUpperCase();
  // Gate's EDGE is Definitive on Base, not edgeX (Binance's EDGE).
  // https://api.gateio.ws/api/v4/spot/currencies/EDGE
  if (exchange === 'gate' && raw === 'EDGE') return { base: 'GATE:EDGE:DEFINITIVE', displayBase: raw, assetClass: 'crypto', comparable: false, contractUnit: 'Definitive (Base)，与 edgeX 不同标的', identitySource: 'Gate spot currencies/EDGE: Definitive; 0xed6e000def95780fb89734c07ee2ce9f6dcaf110' };
  // Mainnet's official asset registry names this AI "Artificial Inu";
  // Binance's AI is Sleepless AI. Do not use the ticker as a common identity.
  if (exchange === 'lighter' && raw === 'AI') return { base: 'LIGHTER:AI:ARTIFICIAL-INU', displayBase: raw, assetClass: 'crypto', comparable: false, contractUnit: 'Artificial Inu，与 Sleepless AI 不同标的', identitySource: 'https://app.lighter.xyz/assets/dist-BJmqjeUf.js: symbol AI, name Artificial Inu' };
  // Official listing names the token address; this is not Memeland's MEME.
  // https://x.com/Aster_DEX/status/2095786680758530107
  if (exchange === 'aster' && raw === 'MEME') return { base: 'ASTER:MEME:A-MEME-COIN', displayBase: raw, assetClass: 'crypto', comparable: false, contractUnit: 'A Meme Coin，与 Memeland MEME 不同标的', identitySource: 'Aster listing 2026-09-04: 0x385f4f8ae47651ce5f58f5265395a669f8281e18; https://x.com/Aster_DEX/status/2095786680758530107' };
  // Aster explicitly limits this AI market to the address in its 2026-08-31
  // listing; it must not inherit the Sleepless AI identity from other venues.
  if (exchange === 'aster' && raw === 'AI') return { base: 'ASTER:AI:CONTRACT', displayBase: raw, assetClass: 'crypto', comparable: false, contractUnit: 'Aster 指定地址 AI，与 Sleepless AI 分开', identitySource: 'Aster listing 2026-08-31: 0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18; https://x.com/Aster_DEX/status/2094342472990412926' };
  // The official TradFi product mirrors the underlying US share price. Only
  // these four share contracts have also been independently matched to Entropy.
  // https://www.bybit.com/en/learn/bybit-tradfi/bybit-tradfi-perpetuals
  if (exchange === 'bybit' && VERIFIED_US_SHARES.has(raw) && metadata.symbolType === 'stock' && metadata.marketRegion === 'US' && metadata.underlyingTicker === raw && !metadata.isPreListing) return { base: `EQUITY:${raw}`, displayBase: raw, assetClass: 'equity', multiplier: 1, comparable: true, contractUnit: '每股', identitySource: 'Bybit US stock perpetual share-price specification + instrument underlyingTicker; matched to Entropy share contract' };
  let classification = 'crypto', identitySource;
  if (exchange === 'bybit') {
    const type = String(metadata.symbolType || '').toLowerCase();
    if (type && !['innovation', 'crypto'].includes(type)) classification = type;
    if (metadata.isPreListing) classification = 'pre-market';
    identitySource = `symbolType=${metadata.symbolType || 'crypto'}`;
  } else if (exchange === 'okx') {
    if (metadata.ruleType === 'pre_market') classification = 'pre-market';
    else if (metadata.instCategory && !['1', '2'].includes(String(metadata.instCategory))) classification = `category-${metadata.instCategory}`;
    identitySource = `instCategory=${metadata.instCategory || 'unknown'};ruleType=${metadata.ruleType || 'normal'}`;
  } else if (exchange === 'gate') {
    if (metadata.is_pre_market) classification = 'pre-market';
    else if (metadata.contract_type && metadata.contract_type !== 'crypto') classification = metadata.contract_type;
    identitySource = `contract_type=${metadata.contract_type || 'crypto'};is_pre_market=${Boolean(metadata.is_pre_market)}`;
  } else if (exchange === 'aster' || exchange === 'binance') {
    const subtypes = (metadata.underlyingSubType || []).map(value => String(value).toLowerCase());
    if (subtypes.some(value => /pre.?launch|pre.?market|pre.?ipo/.test(value))) classification = 'pre-market';
    else if (metadata.contractType === 'TRADIFI_PERPETUAL' || subtypes.some(value => ['stock', 'etf', 'commodities', 'commodity', 'forex', 'index', 'indices', 'tradfi'].includes(value)) || (exchange === 'aster' && Number(metadata.symbolType) === 1)) classification = 'rwa';
    identitySource = `contractType=${metadata.contractType || ''};underlyingSubType=${subtypes.join(',')};symbolType=${metadata.symbolType ?? ''}`;
  } else if (exchange === 'lighter') {
    const multiplier = number(metadata.funding_premium_multiplier);
    // A missing/novel category must not default to a cross-venue crypto match.
    classification = multiplier === 100 ? 'crypto' : multiplier === 1 ? 'pre-market' : multiplier === 50 ? 'rwa' : 'unverified';
    identitySource = `funding_premium_multiplier=${metadata.funding_premium_multiplier ?? 'unknown'}`;
  }
  if (classification === 'crypto') return { assetClass: 'crypto', identitySource };
  return { base: `${exchange.toUpperCase()}:${classification.toUpperCase()}:${raw}`, displayBase: raw, multiplier: 1, assetClass: classification, comparable: false, contractUnit: '平台独立标的与合约单位；不按同名代码跨平台配对', identitySource };
}

function assertArray(value, exchange) {
  if (!Array.isArray(value)) throw new Error(`${exchange}: invalid market list`);
  return value;
}

async function request(url, { fetchImpl, signal }, body) {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetchImpl(url, { credentials: 'omit', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  const data = await response.json();
  if (data?.retCode !== undefined && data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg || data.retCode}`);
  if (data?.code !== undefined && !['0', '00000', '200'].includes(String(data.code))) throw new Error(`${new URL(url).hostname}: ${data.msg || data.message || data.code}`);
  return data;
}

/** Dynamic discovery includes active, stablecoin quoted perpetual contracts only. */
export async function discoverMarkets(exchangeId, { fetchImpl = fetch, signal } = {}) {
  const options = { fetchImpl, signal };
  if (ADDITIONAL_EXCHANGES.some(exchange => exchange.id === exchangeId)) return discoverAdditionalMarkets(exchangeId, options);
  let rows;
  if (exchangeId === 'binance' || exchangeId === 'aster') {
    const host = exchangeId === 'binance' ? 'https://fapi.binance.com' : 'https://fapi.asterdex.com';
    const [symbolsResult, fundingResult] = await Promise.allSettled([
      request(`${host}/fapi/v1/exchangeInfo`, options), request(`${host}/fapi/v1/fundingInfo`, options),
    ]);
    if (symbolsResult.status === 'rejected') throw symbolsResult.reason;
    const funding = fundingResult.status === 'fulfilled' && Array.isArray(fundingResult.value) ? fundingResult.value : null;
    const fundingBySymbol = new Map((funding || []).map(row => [row.symbol, number(row.fundingIntervalHours, true)]));
    rows = assertArray(symbolsResult.value.symbols, exchangeId)
      .filter(row => row.status === 'TRADING' && row.contractType === 'PERPETUAL' && STABLE_QUOTES.has(row.quoteAsset) && row.marginAsset === row.quoteAsset)
      .map(row => market(exchangeId, row.symbol, row.baseAsset, row.quoteAsset, {
        ...classifyMarketIdentity(exchangeId, row.baseAsset, row),
        // Binance fundingInfo lists adjusted intervals; unlisted contracts use 8h.
        // On a failed metadata read, keep the interval unknown.
        fundingIntervalHours: fundingBySymbol.get(row.symbol) ?? (exchangeId === 'binance' && funding ? 8 : null),
      }));
  } else if (exchangeId === 'bybit') {
    rows = [];
    let cursor = '';
    const seen = new Set();
    do {
      const data = await request(`https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, options);
      rows.push(...assertArray(data.result?.list, exchangeId)
        .filter(row => row.status === 'Trading' && row.contractType === 'LinearPerpetual' && !row.isPreListing && STABLE_QUOTES.has(row.quoteCoin) && row.settleCoin === row.quoteCoin)
        .map(row => market(exchangeId, row.symbol, row.baseCoin, row.quoteCoin, { ...classifyMarketIdentity(exchangeId, row.baseCoin, row), fundingIntervalHours: number(row.fundingInterval, true) === null ? null : Number(row.fundingInterval) / 60 })));
      cursor = data.result.nextPageCursor || '';
      if (cursor && seen.has(cursor)) throw new Error('Bybit: repeated pagination cursor');
      seen.add(cursor);
      if (seen.size > 30) throw new Error('Bybit: excessive market pagination');
    } while (cursor);
  } else if (exchangeId === 'okx') {
    const data = await request('https://www.okx.com/api/v5/public/instruments?instType=SWAP', options);
    rows = assertArray(data.data, exchangeId)
      .filter(row => row.state === 'live' && row.instType === 'SWAP' && row.ctType === 'linear' && STABLE_QUOTES.has(row.settleCcy) && row.instId.endsWith(`-${row.settleCcy}-SWAP`))
      .map(row => market(exchangeId, row.instId, row.ctValCcy || row.instId.split('-')[0], row.settleCcy, classifyMarketIdentity(exchangeId, row.ctValCcy || row.instId.split('-')[0], row)));
  } else if (exchangeId === 'bitget') {
    const results = await Promise.allSettled(['USDT-FUTURES', 'USDC-FUTURES'].map(async productType => {
      const data = await request(`https://api.bitget.com/api/v2/mix/market/contracts?productType=${productType}`, options);
      return assertArray(data.data, exchangeId)
        .filter(row => row.symbolStatus === 'normal' && row.symbolType === 'perpetual' && row.isRwa !== 'YES' && STABLE_QUOTES.has(row.quoteCoin))
        .map(row => market(exchangeId, row.symbol, row.baseCoin, row.quoteCoin, { productType, fundingIntervalHours: number(row.fundInterval, true) }));
    }));
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    rows = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  } else if (exchangeId === 'gate') {
    const data = await request('https://api.gateio.ws/api/v4/futures/usdt/contracts', options);
    rows = assertArray(data, exchangeId)
      .filter(row => !row.in_delisting && row.type === 'direct' && row.name?.endsWith('_USDT') && (!row.status || row.status === 'trading'))
      .map(row => market(exchangeId, row.name, row.name.slice(0, -5), 'USDT', { ...classifyMarketIdentity(exchangeId, row.name.slice(0, -5), row), fundingIntervalHours: number(row.funding_interval, true) === null ? null : Number(row.funding_interval) / 3600 }));
  } else if (exchangeId === 'hyperliquid') {
    const data = await request('https://api.hyperliquid.xyz/info', options, { type: 'meta' });
    rows = assertArray(data.universe, exchangeId)
      .filter(row => !row.isDelisted && row.name && !row.name.includes(':'))
      .map(row => market(exchangeId, row.name, row.name, ['HYPE', 'PURR'].includes(row.name) ? 'USDC' : 'USDT', { settlementCurrency: 'USDC', fundingIntervalHours: 1 }));
  } else if (exchangeId === 'lighter') {
    const data = await request('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails', options);
    rows = assertArray(data.order_book_details, exchangeId)
      .filter(row => row.status === 'active' && row.market_type === 'perp' && Number.isInteger(row.market_id))
      .map(row => market(exchangeId, row.symbol, row.symbol, 'USDC', { ...classifyMarketIdentity(exchangeId, row.symbol, row), marketId: row.market_id, fundingIntervalHours: 1 }));
  } else {
    throw new Error(`Unsupported exchange: ${exchangeId}`);
  }
  return [...new Map(rows.filter(row => row.symbol && row.base).map(row => [row.id, row])).values()].sort((a, b) => a.base.localeCompare(b.base) || a.symbol.localeCompare(b.symbol));
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function connection(url, markets, subscribe, extra = {}) {
  return { url, markets, subscribe, context: {}, sendIntervalMs: 250, ...extra };
}

/** Each spec is independent; reconnect with a fresh context. sendIntervalMs applies
 * to subscription messages. startDelayMs also staggers IP-wide subscription limits.
 * Node's native WebSocket answers protocol ping frames automatically.
 */
export function createSubscriptions(exchangeId, inputMarkets) {
  if (ADDITIONAL_EXCHANGES.some(exchange => exchange.id === exchangeId)) return createAdditionalSubscriptions(exchangeId, inputMarkets);
  const markets = inputMarkets.filter(row => row.exchange === exchangeId);
  if (!markets.length) return [];
  if (exchangeId === 'binance') {
    return [
      ...chunks(markets, 180).map((group, index) => connection('wss://fstream.binance.com/public/ws', group, [{ method: 'SUBSCRIBE', params: group.map(row => `${row.symbol.toLowerCase()}@bookTicker`), id: `bbo-${index}` }], { startDelayMs: index * 350 })),
      connection('wss://fstream.binance.com/market/ws', markets, [{ method: 'SUBSCRIBE', params: ['!markPrice@arr@1s'], id: 'funding' }]),
    ];
  }
  if (exchangeId === 'aster') {
    return chunks(markets, 90).map((group, index) => connection('wss://fstream.asterdex.com/ws', group,
      [{ method: 'SUBSCRIBE', params: group.flatMap(row => [`${row.symbol.toLowerCase()}@bookTicker`, `${row.symbol.toLowerCase()}@markPrice`]), id: index + 1 }], { startDelayMs: index * 350 }));
  }
  if (exchangeId === 'bybit') {
    return chunks(markets, 150).map((group, index) => connection('wss://stream.bybit.com/v5/public/linear', group,
      chunks(group, 30).map(batch => ({ op: 'subscribe', args: batch.flatMap(row => [`tickers.${row.symbol}`, `orderbook.1.${row.symbol}`]) })), { heartbeat: { op: 'ping' }, heartbeatMs: 20_000, startDelayMs: index * 350 }));
  }
  if (exchangeId === 'okx') {
    return chunks(markets, 60).map((group, index) => connection('wss://ws.okx.com:8443/ws/v5/public', group,
      chunks(group.flatMap(row => ['tickers', 'funding-rate', 'mark-price'].map(channel => ({ channel, instId: row.symbol, ...(channel === 'mark-price' ? { instType: 'SWAP' } : {}) }))), 60).map(args => ({ op: 'subscribe', args })),
      { heartbeat: 'ping', heartbeatMs: 20_000, startDelayMs: index * 400 }));
  }
  if (exchangeId === 'bitget') {
    return chunks(markets, 45).map((group, index) => connection('wss://ws.bitget.com/v2/ws/public', group,
      chunks(group, 20).map(batch => ({ op: 'subscribe', args: batch.map(row => ({ instType: row.productType || `${row.quoteCurrency}-FUTURES`, channel: 'ticker', instId: row.symbol })) })),
      { heartbeat: 'ping', heartbeatMs: 25_000, startDelayMs: index * 400 }));
  }
  if (exchangeId === 'gate') {
    return chunks(markets, 150).map((group, index) => connection('wss://fx-ws.gateio.ws/v4/ws/usdt', group,
      ['futures.book_ticker', 'futures.tickers'].map(channel => ({ time: Math.floor(Date.now() / 1000), channel, event: 'subscribe', payload: group.map(row => row.symbol) })),
      { heartbeat: { channel: 'futures.ping' }, heartbeatMs: 20_000, startDelayMs: index * 400 }));
  }
  if (exchangeId === 'hyperliquid') {
    // Native crypto universe only; <= 1000 combined subscriptions per IP.
    return chunks(markets, 150).map((group, index) => connection('wss://api.hyperliquid.xyz/ws', group,
      group.flatMap(row => ['bbo', 'activeAssetCtx'].map(type => ({ method: 'subscribe', subscription: { type, coin: row.symbol } }))),
      { heartbeat: { method: 'ping' }, heartbeatMs: 25_000, sendIntervalMs: 120, startDelayMs: index * 150 * 2 * 120 }));
  }
  if (exchangeId === 'lighter') {
    // 200 client messages/minute/IP; single stream for stats, paced BBO subscriptions.
    return chunks(markets, 450).map((group, index) => connection('wss://mainnet.zklighter.elliot.ai/stream', group,
      [{ type: 'subscribe', channel: 'market_stats/all' }, ...group.map(row => ({ type: 'subscribe', channel: `ticker/${row.marketId}` }))],
      { heartbeat: { type: 'ping' }, heartbeatMs: 30_000, sendIntervalMs: 400, startDelayMs: index * 451 * 400 }));
  }
  throw new Error(`Unsupported exchange: ${exchangeId}`);
}

function decode(payload) {
  if (typeof payload === 'string') { try { return JSON.parse(payload); } catch { return null; } }
  return payload && typeof payload === 'object' ? payload : null;
}

export function getControlResponse(exchangeId, payload) {
  if (payload === 'ping' && ['okx', 'bitget'].includes(exchangeId)) return 'pong';
  const data = decode(payload);
  if (ADDITIONAL_EXCHANGES.some(exchange => exchange.id === exchangeId)) return getAdditionalControlResponse(exchangeId, data);
  if (exchangeId === 'lighter' && data?.type === 'ping') return { type: 'pong' };
  return null;
}

function bestPrice(value, size) {
  return size !== undefined && number(size, true) === null ? null : value;
}

function checkProtocolError(exchangeId, message) {
  if (message.error || message.success === false || message.event === 'error' || message.type === 'error' || message.channel === 'error' || (message.code !== undefined && !['0', '00000', '200'].includes(String(message.code)))) {
    const detail = message.msg || message.ret_msg || message.retMsg || message.message || message.error?.message || message.error || message.data || message.code;
    throw new Error(`${exchangeId} WebSocket: ${String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 300)}`);
  }
}

function quote(row, receivedAt, sourceTime, fields) {
  if (!row) return null;
  const result = { id: row.id || `${row.exchange}:${row.symbol}`, exchange: row.exchange, symbol: row.symbol, base: row.base, quoteCurrency: row.quoteCurrency, multiplier: row.multiplier || 1, receivedAt, sourceTime: timestamp(sourceTime), transport: 'ws' };
  for (const key of ['displayBase', 'assetClass', 'comparable', 'contractUnit', 'identitySource']) if (row[key] !== undefined) result[key] = row[key];
  const metadataFields = Object.keys(result).length;
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (['bid', 'ask', 'mark', 'last'].includes(key)) {
      const value = number(raw, true);
      result[key] = value === null ? null : value / result.multiplier;
    } else result[key] = raw === null ? null : number(raw);
  }
  if (Object.keys(result).length === metadataFields) return null;
  return result;
}

/** Source timestamps retain exchange semantics. null means the channel does not
 * supply an exchange timestamp; receipt time must be labelled as receipt time.
 */
export function parseMessage(exchangeId, payload, markets, receivedAt = Date.now(), context = {}) {
  const decoded = decode(payload);
  if (!decoded) return [];
  checkProtocolError(exchangeId, decoded);
  if (ADDITIONAL_EXCHANGES.some(exchange => exchange.id === exchangeId)) return parseAdditionalMessage(exchangeId, decoded, markets, receivedAt, context);
  const bySymbol = context.marketIndex ||= new Map(markets.filter(row => row.exchange === exchangeId).map(row => [row.symbol, row]));
  const out = [];
  const add = (symbol, time, fields) => { const item = quote(bySymbol.get(symbol), receivedAt, time, fields); if (item) out.push(item); };
  if (exchangeId === 'binance' || exchangeId === 'aster') {
    const data = decoded.stream ? decoded.data : decoded;
    for (const row of Array.isArray(data) ? data : [data]) {
      if (!row || (row.st !== undefined && row.st !== 1)) continue;
      if (row.e === 'bookTicker') add(row.s, row.T ?? row.E, { bid: bestPrice(row.b, row.B), ask: bestPrice(row.a, row.A) });
      else if (row.e === 'markPriceUpdate') add(row.s, row.E, { mark: row.p, fundingRate: row.r, nextFundingAt: row.T, fundingIntervalHours: bySymbol.get(row.s)?.fundingIntervalHours });
      else if (row.e === '24hrTicker') add(row.s, row.E, { last: row.c });
    }
  } else if (exchangeId === 'bybit' && decoded.topic?.startsWith('orderbook.1.')) {
    const row = decoded.data;
    if (row && decoded.type === 'snapshot') {
      // Level 1 is snapshot-only; Bybit resends after 3s without book changes.
      // The message timestamp confirms the snapshot, while cts may be older.
      add(row.s || decoded.topic.slice(12), decoded.ts, { bid: bestPrice(row.b?.[0]?.[0] ?? null, row.b?.[0]?.[1]), ask: bestPrice(row.a?.[0]?.[0] ?? null, row.a?.[0]?.[1]) });
    }
  } else if (exchangeId === 'bybit' && decoded.topic?.startsWith('tickers.')) {
    const row = decoded.data;
    if (row && !Array.isArray(row)) {
      const symbol = row.symbol || decoded.topic.slice(8);
      add(symbol, decoded.ts, { bid: row.bid1Price === undefined ? undefined : bestPrice(row.bid1Price, row.bid1Size), ask: row.ask1Price === undefined ? undefined : bestPrice(row.ask1Price, row.ask1Size), mark: row.markPrice, last: row.lastPrice, fundingRate: row.fundingRate, nextFundingAt: row.nextFundingTime,
        fundingIntervalHours: row.fundingIntervalHour ?? (row.fundingRate !== undefined ? bySymbol.get(symbol)?.fundingIntervalHours : undefined) });
    }
  } else if (exchangeId === 'okx' && Array.isArray(decoded.data)) {
    for (const row of decoded.data) {
      const symbol = row.instId || decoded.arg?.instId;
      if (decoded.arg?.channel === 'tickers') add(symbol, row.ts, { bid: bestPrice(row.bidPx, row.bidSz), ask: bestPrice(row.askPx, row.askSz), last: row.last });
      else if (decoded.arg?.channel === 'mark-price') add(symbol, row.ts, { mark: row.markPx });
      else if (decoded.arg?.channel === 'funding-rate') {
        const current = timestamp(row.fundingTime), next = timestamp(row.nextFundingTime);
        const interval = current && next && next > current ? (next - current) / HOUR : null;
        add(symbol, row.ts, { fundingRate: row.fundingRate, nextFundingAt: current, fundingIntervalHours: interval });
      }
    }
  } else if (exchangeId === 'bitget' && decoded.arg?.channel === 'ticker' && Array.isArray(decoded.data)) {
    for (const row of decoded.data) {
      const symbol = row.instId || decoded.arg.instId;
      add(symbol, row.ts ?? decoded.ts, { bid: bestPrice(row.bidPr, row.bidSz), ask: bestPrice(row.askPr, row.askSz), mark: row.markPrice, last: row.lastPr, fundingRate: row.fundingRate, nextFundingAt: row.nextFundingTime, fundingIntervalHours: bySymbol.get(symbol)?.fundingIntervalHours });
    }
  } else if (exchangeId === 'gate' && decoded.event === 'update') {
    const entries = Array.isArray(decoded.result) ? decoded.result : [decoded.result];
    for (const row of entries) {
      if (!row) continue;
      if (decoded.channel === 'futures.book_ticker') add(row.s, row.t ?? decoded.time_ms, { bid: bestPrice(row.b, row.B), ask: bestPrice(row.a, row.A) });
      else if (decoded.channel === 'futures.tickers') add(row.contract, decoded.time_ms ?? timestamp(decoded.time, 's'), { mark: row.mark_price, last: row.last, fundingRate: row.funding_rate, fundingIntervalHours: bySymbol.get(row.contract)?.fundingIntervalHours,
        nextFundingAt: row.funding_next_apply === undefined ? undefined : timestamp(row.funding_next_apply, 's') });
    }
  } else if (exchangeId === 'hyperliquid') {
    const row = decoded.data;
    if (decoded.channel === 'bbo' && row && Array.isArray(row.bbo)) add(row.coin, row.time, { bid: bestPrice(row.bbo[0]?.px ?? null, row.bbo[0]?.sz), ask: bestPrice(row.bbo[1]?.px ?? null, row.bbo[1]?.sz) });
    else if (decoded.channel === 'activeAssetCtx' && row?.ctx) add(row.coin, null, { mark: row.ctx.markPx, fundingRate: row.ctx.funding, fundingIntervalHours: 1, nextFundingAt: Math.floor(receivedAt / HOUR + 1) * HOUR });
  } else if (exchangeId === 'lighter') {
    const byMarket = context.marketIdIndex ||= new Map(markets.filter(row => row.exchange === exchangeId).map(row => [String(row.marketId), row]));
    if (decoded.channel?.startsWith('ticker:') && decoded.ticker) {
      const row = decoded.ticker, m = byMarket.get(decoded.channel.split(':')[1]);
      if (m && (row.s === undefined || row.s === m.symbol)) add(m.symbol, decoded.timestamp ?? timestamp(row.last_updated_at ?? decoded.last_updated_at, 'us'), { bid: bestPrice(row.b?.price ?? null, row.b?.size), ask: bestPrice(row.a?.price ?? null, row.a?.size) });
    } else if (decoded.channel?.startsWith('market_stats:') && decoded.market_stats) {
      const stats = decoded.market_stats;
      const entries = stats.market_id !== undefined ? [stats] : Object.values(stats);
      for (const row of entries) {
        if (!row || typeof row !== 'object') continue;
        const m = byMarket.get(String(row.market_id));
        if (!m) continue;
        // Stats rates are percentage points, hourly. Last paid funding_rate is
        // intentionally not substituted for estimated current_funding_rate.
        const rate = number(row.current_funding_rate);
        add(m.symbol, decoded.timestamp, { mark: row.mark_price, last: row.last_trade_price, fundingRate: row.current_funding_rate === undefined ? undefined : rate === null ? null : rate / 100,
          fundingIntervalHours: 1, nextFundingAt: Math.floor((timestamp(decoded.timestamp) || receivedAt) / HOUR + 1) * HOUR });
      }
    }
  }
  return out;
}

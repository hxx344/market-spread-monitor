import { PerpetualWebSocket } from './perpetual-socket.mjs';
import { quoteCurrencyFx } from '../lib/perpetual-fx.ts';

// One-shot public depth inspection only: no full-market subscriptions or history.
// Official formats verified 2026-09-21:
// https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book
// https://bybit-exchange.github.io/docs/v5/market/orderbook
// https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book
// https://www.bitget.com/docs/catalog/classic-contract-market
// https://www.gate.com/docs/developers/apiv4/en/futures/
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot
// https://apidocs.lighter.xyz/docs/websocket-reference
// https://apidocs.rh.lighter.xyz/docs/websocket
// https://asterdex.github.io/aster-api-website/futures/market-data/#order-book
const IDS = new Set(['binance', 'bybit', 'okx', 'bitget', 'gate', 'hyperliquid', 'lighter', 'rh-lighter', 'aster', 'entropy']);
const MAX_BOOK_AGE = 10_000, MAX_SKEW = 5_000, LEVELS = 50;
const positive = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const validTime = (value, now) => Number.isFinite(Number(value)) && Number(value) >= 1e12 && Number(value) <= now + 5_000 ? Number(value) : null;

/** Shared bounded budget for depth, metadata and FX. Errors never grow a queue. */
export function createInspectionBudget({ clock = Date.now, spacingMs = 500, maxPerMinute = 60, concurrency = 2, maxQueue = 12 } = {}) {
  const queue = [], starts = []; let running = 0, lastStart = -Infinity, timer = null, stopped = false, blockedUntil = 0;
  function pump() {
    if (stopped || timer || running >= concurrency || !queue.length) return;
    const now = clock();
    while (starts.length && starts[0] <= now - 60_000) starts.shift();
    if (now < blockedUntil || starts.length >= maxPerMinute) {
      for (const item of queue.splice(0)) item.reject(failure('盘口查询已达限额，请稍后重试', 429));
      return;
    }
    const delay = Math.max(0, lastStart + spacingMs - now);
    if (delay) { timer = setTimeout(() => { timer = null; pump(); }, delay); return; }
    const item = queue.shift(); starts.push(now); lastStart = now; running++;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { running--; pump(); });
    pump();
  }
  return {
    run(task) {
      if (stopped) return Promise.reject(failure('盘口服务已停止', 503));
      if (queue.length >= maxQueue) return Promise.reject(failure('盘口查询繁忙，请稍后重试', 429));
      return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
    },
    backoff(ms = 30_000) { blockedUntil = Math.max(blockedUntil, clock() + Math.min(300_000, Math.max(1_000, ms))); },
    metrics: () => ({ inFlight: running, queued: queue.length, recentRequests: starts.length, blockedUntil }),
    stop() { stopped = true; clearTimeout(timer); timer = null; for (const item of queue.splice(0)) item.reject(failure('盘口服务已停止', 503)); },
  };
}

export function normalizeDepthLevels(rows, { multiplier = 1, contractSize = 1, side = 'asks', limit = LEVELS } = {}) {
  if (!Array.isArray(rows) || !positive(multiplier) || !positive(contractSize)) throw failure('盘口数量或合约单位缺失');
  const levels = new Map();
  // Guard untrusted upstream payloads and aggregate repeated order prices.
  for (const row of rows.slice(0, 250)) {
    if (!row || typeof row !== 'object') continue;
    const rawPrice = positive(Array.isArray(row) ? row[0] : row.p ?? row.px ?? row.price);
    const rawSize = positive(Array.isArray(row) ? row[1] : row.s ?? row.sz ?? row.size ?? row.remaining_base_amount);
    if (!rawPrice || !rawSize) continue;
    const price = rawPrice / multiplier, size = rawSize * contractSize * multiplier;
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    levels.set(price, (levels.get(price) ?? 0) + size);
  }
  return [...levels].sort((a, b) => side === 'asks' ? a[0] - b[0] : b[0] - a[0]).slice(0, limit);
}

/** Budget is a long-leg USDT notional; both legs hold the same underlying amount. */
export function estimateDepthPair(longBook, shortBook, notional, fx, now = Date.now()) {
  const base = { notional, notionalCurrency: 'USDT', generatedAt: now, staleAfterMs: MAX_BOOK_AGE, complete: false, estimatedSpreadPct: null, entrySlippagePct: null, quantity: null, long: null, short: null, reasons: [] };
  if (!positive(notional) || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
  for (const [name, book] of [['做多', longBook], ['做空', shortBook]]) {
    if (!book || book.reason) base.reasons.push(`${name}腿：${book?.reason || '盘口缺失'}`);
    else if (!validTime(book.sourceTime, now) || !validTime(book.receivedAt, now) || now - book.sourceTime > MAX_BOOK_AGE || now - book.receivedAt > MAX_BOOK_AGE) base.reasons.push(`${name}腿：盘口时间缺失或超过 10 秒`);
    else if (!book.asks?.length || !book.bids?.length || book.bids[0][0] > book.asks[0][0]) base.reasons.push(`${name}腿：盘口为空或买卖价格倒挂`);
  }
  if (base.reasons.length) return base;
  if (Math.abs(longBook.sourceTime - shortBook.sourceTime) > MAX_SKEW) { base.reasons.push('两腿盘口时间相差超过 5 秒，请重新校验'); return base; }
  const longFx = quoteCurrencyFx(longBook.quoteCurrency, fx, now), shortFx = quoteCurrencyFx(shortBook.quoteCurrency, fx, now);
  if (!longFx || !shortFx) { base.reasons.push('计价币兑 USDT 汇率缺失或过期，无法按统一金额校验'); return base; }
  const asks = longBook.asks.map(([price, size]) => [price * longFx.ask, size]);
  const bids = shortBook.bids.map(([price, size]) => [price * shortFx.bid, size]);
  let remaining = notional, quantity = 0, longValue = 0;
  for (const [price, size] of asks) { const used = Math.min(size, remaining / price); quantity += used; longValue += used * price; remaining = Math.max(0, remaining - used * price); if (remaining < notional * 1e-10) break; }
  const longComplete = remaining <= notional * 1e-8;
  let shortRemaining = quantity, shortValue = 0, shortQuantity = 0;
  for (const [price, size] of bids) { const used = Math.min(size, shortRemaining); shortQuantity += used; shortValue += used * price; shortRemaining = Math.max(0, shortRemaining - used); if (shortRemaining < quantity * 1e-10) break; }
  const shortComplete = shortRemaining <= quantity * 1e-8;
  const view = (book, levels, filledQuantity, filledNotional, complete) => ({ exchange: book.exchange, symbol: book.symbol, quoteCurrency: book.quoteCurrency, sourceTime: book.sourceTime, receivedAt: book.receivedAt, transport: book.transport, source: book.source, levels: levels.length, complete, filledQuantity, filledNotional, vwap: filledQuantity > 0 ? filledNotional / filledQuantity : null, capacityQuantity: levels.reduce((sum, row) => sum + row[1], 0), capacityNotional: levels.reduce((sum, row) => sum + row[0] * row[1], 0) });
  base.long = view(longBook, asks, quantity, longValue, longComplete);
  base.short = view(shortBook, bids, shortQuantity, shortValue, shortComplete);
  base.quantity = quantity;
  if (!longComplete) base.reasons.push(`做多腿公开 ${asks.length} 档盘口不足目标金额`);
  if (!shortComplete) base.reasons.push(`做空腿公开 ${bids.length} 档盘口不足以匹配做多数量`);
  base.complete = longComplete && shortComplete;
  if (base.complete) {
    base.estimatedSpreadPct = (shortValue / longValue - 1) * 100;
    base.entrySlippagePct = Math.max(0, (bids[0][0] / asks[0][0] - 1) * 100 - base.estimatedSpreadPct);
  }
  return base;
}

export function createPerpetualExecutionService({ getQuote, getMarket = () => null, fetchImpl = fetch, clock = Date.now, WebSocketImpl = PerpetualWebSocket, budget: suppliedBudget, maxMarkets = 10, cacheMs = 5_000 } = {}) {
  const budget = suppliedBudget ?? createInspectionBudget({ clock });
  const books = new Map(), metadata = new Map(), controller = new AbortController();
  let fxSnapshot = null, fxFlight = null, fxAttemptAt = -Infinity;
  async function json(url, body) {
    return budget.run(async () => {
      const response = await fetchImpl(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        if ([418, 429].includes(response.status)) budget.backoff((positive(response.headers?.get?.('retry-after')) ?? 30) * 1_000);
        throw failure(`公开接口 HTTP ${response.status}`, 502);
      }
      const data = await response.json();
      const code = data?.retCode ?? data?.code;
      if (code !== undefined && !['0', '00000', '200'].includes(String(code))) {
        if (['429', '10006', '50011', '-1003'].includes(String(code))) budget.backoff();
        throw failure(`公开接口返回错误 ${String(code).slice(0, 25)}`, 502);
      }
      return data;
    });
  }
  async function contractSize(quote) {
    if (!['gate', 'okx'].includes(quote.exchange)) return 1;
    const key = `${quote.exchange}:${quote.symbol}`, cached = metadata.get(key);
    if (cached && clock() - cached.at < 300_000) return cached.value;
    let value;
    if (quote.exchange === 'gate') {
      const row = await json(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(quote.symbol)}`);
      if (row.name !== quote.symbol || row.type !== 'direct') throw failure('Gate 合约数量单位未确认');
      value = positive(row.quanto_multiplier);
    } else {
      const data = await json(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(quote.symbol)}`);
      const row = data.data?.find(row => row.instId === quote.symbol);
      if (!row || row.ctType !== 'linear' || row.ctValCcy !== quote.symbol.split('-')[0]) throw failure('OKX 合约数量单位未确认');
      value = positive(row.ctVal); // Official linear size × ctVal, quoted in ctValCcy.
      if (row.ctMult && Number(row.ctMult) !== 1) throw failure('OKX 非标准 ctMult 暂不支持盘口金额估算');
    }
    if (!value) throw failure('合约数量乘数缺失');
    if (metadata.size >= maxMarkets && !metadata.has(key)) metadata.delete(metadata.keys().next().value);
    metadata.set(key, { value, at: clock() }); return value;
  }
  function lighterSnapshot(quote, market) {
    if (!Number.isInteger(market?.marketId)) return Promise.reject(failure('合约目录缺少 Lighter market_id'));
    const host = quote.exchange === 'lighter' ? 'mainnet.zklighter.elliot.ai' : 'api.rh.lighter.xyz';
    return budget.run(() => new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`wss://${host}/stream?readonly=true`);
      let done = false;
      const finish = (error, data) => {
        if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        socket.terminate(); if (error) reject(error); else resolve({ data, source: `https://${host}`, transport: 'ws' });
      };
      const aborted = () => finish(failure('盘口查询已取消', 503));
      const timer = setTimeout(() => finish(failure('盘口快照连接超时', 502)), 8_000);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${market.marketId}` })));
      socket.on('error', () => finish(failure('盘口快照连接失败', 502)));
      socket.on('close', () => finish(failure('盘口快照连接关闭', 502)));
      socket.on('message', raw => {
        let data; try { data = JSON.parse(String(raw)); } catch { return; }
        if (data.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        // Delta frames are never treated as a full order book.
        if (data.channel === `order_book:${market.marketId}` && data.type === 'subscribed/order_book') finish(null, data);
      });
    }));
  }
  async function loadBook(quote, market) {
    const { exchange, symbol } = quote, symbolParam = encodeURIComponent(symbol);
    let data, source, sourceTime, bids, asks, transport = 'rest';
    const unit = await contractSize(quote);
    if (['binance', 'aster'].includes(exchange)) {
      source = `https://fapi.${exchange === 'binance' ? 'binance.com' : 'asterdex.com'}/fapi/v1/depth?symbol=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = data.E;
    } else if (exchange === 'bybit') {
      source = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbolParam}&limit=${LEVELS}`;
      data = (await json(source)).result;
      if (data?.s !== symbol) throw failure('Bybit 返回合约与请求不一致');
      bids = data.b; asks = data.a; sourceTime = data.ts;
    } else if (exchange === 'okx') {
      source = `https://www.okx.com/api/v5/market/books?instId=${symbolParam}&sz=${LEVELS}`;
      data = (await json(source)).data?.[0]; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'bitget') {
      if (!['USDT', 'USDC'].includes(quote.quoteCurrency)) throw failure('Bitget 该计价币盘口暂未接入');
      source = `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbolParam}&productType=${quote.quoteCurrency}-FUTURES&limit=${LEVELS}&precision=scale0`;
      data = (await json(source)).data; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'gate') {
      source = `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = Number(data.current) * 1_000;
    } else if (['hyperliquid', 'entropy'].includes(exchange)) {
      source = 'https://api.hyperliquid.xyz/info'; data = await json(source, { type: 'l2Book', coin: symbol });
      if (data.coin !== symbol) throw failure('Hyperliquid 返回合约与请求不一致');
      [bids, asks] = data.levels ?? []; sourceTime = data.time;
    } else if (['lighter', 'rh-lighter'].includes(exchange)) {
      const result = await lighterSnapshot(quote, market); ({ data, source, transport } = result);
      bids = data.order_book?.bids; asks = data.order_book?.asks; sourceTime = data.timestamp;
    } else throw failure('该交易所的盘口暂未接入');
    const receivedAt = clock();
    return { exchange, symbol, base: quote.base, quoteCurrency: quote.quoteCurrency, source, sourceTime: validTime(sourceTime, receivedAt), receivedAt, transport,
      bids: normalizeDepthLevels(bids, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'bids' }),
      asks: normalizeDepthLevels(asks, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'asks' }) };
  }
  function book(quote) {
    const key = `${quote.exchange}:${quote.symbol}`, cached = books.get(key), now = clock();
    if (cached?.flight) return cached.flight;
    if (cached?.value && now - cached.at < (cached.value.reason ? 10_000 : cacheMs)) return Promise.resolve(cached.value);
    // Active market leases prevent many browsers cycling through the whole market.
    for (const [id, item] of books) if (!item.flight && now - item.at > 30_000) books.delete(id);
    if (!books.has(key) && books.size >= maxMarkets) return Promise.resolve({ reason: '全站最多同时校验 10 个合约，请 30 秒后重试' });
    const entry = { at: now, value: null, flight: null };
    entry.flight = loadBook(quote, getMarket(quote.exchange, quote.symbol)).catch(error => ({ reason: error.message })).then(value => { entry.value = value; entry.at = clock(); entry.flight = null; return value; });
    books.set(key, entry); return entry.flight;
  }
  async function fx() {
    if (fxFlight) return fxFlight;
    if (fxSnapshot && clock() - fxAttemptAt < 60_000) return fxSnapshot;
    fxAttemptAt = clock();
    fxFlight = (async () => {
      const rates = { USDT: { bid: 1, ask: 1, at: clock(), source: 'USDT 计价基准' } }, reasons = { USD: '未接入可信 USD / USDT 换汇盘口' };
      await Promise.all(['USDC', 'USD1', 'USDG'].map(async currency => {
        const previous = quoteCurrencyFx(currency, fxSnapshot, clock());
        if (previous) rates[currency] = previous;
        const source = `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${currency}_USDT&limit=1`;
        try {
          const data = await json(source), bid = positive(data.bids?.[0]?.[0]), ask = positive(data.asks?.[0]?.[0]);
          const at = validTime(data.current, clock());
          if (!bid || !ask || bid > ask || !at || clock() - at > 180_000 || !positive(data.bids?.[0]?.[1]) || !positive(data.asks?.[0]?.[1])) throw failure('汇率盘口缺失或过期');
          rates[currency] = { bid, ask, at, source };
        } catch (error) {
          // Retain last valid exchange timestamp across temporary errors; never
          // rejuvenate old FX with the latest batch or local receipt time.
          if (!quoteCurrencyFx(currency, { baseCurrency: 'USDT', staleAfterMs: 180_000, rates }, clock())) delete rates[currency];
          reasons[currency] = previous ? `更新失败，沿用上次有效汇率：${error.message}` : error.message;
        }
      }));
      fxSnapshot = { baseCurrency: 'USDT', generatedAt: clock(), staleAfterMs: 180_000, rates, reasons }; return fxSnapshot;
    })().finally(() => { fxFlight = null; });
    return fxFlight;
  }
  return {
    fx,
    async depth(input) {
      const legs = ['long', 'short'].map(side => {
        const leg = input?.[side];
        if (!leg || !IDS.has(leg.exchange) || typeof leg.symbol !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(leg.symbol)) throw failure('请选择有效的交易所与合约');
        const quote = getQuote?.(leg.exchange, leg.symbol);
        if (!quote || quote.comparable === false) throw failure('合约不在当前可比较目录中');
        if (quote.delistingAt && quote.delistingAt <= clock()) throw failure('该合约已到下架时间');
        return quote;
      });
      if (legs[0].base !== legs[1].base || legs[0].exchange === legs[1].exchange) throw failure('两腿需为相同标的、不同交易所');
      const notional = positive(input?.notional);
      if (!notional || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
      // Obtain FX first: depth must not age while waiting for extra FX requests.
      const rates = legs.every(leg => leg.quoteCurrency === 'USDT') ? null : await fx();
      const [longBook, shortBook] = await Promise.all(legs.map(book));
      return estimateDepthPair(longBook, shortBook, notional, rates, clock());
    },
    metrics: () => ({ ...budget.metrics(), cachedMarkets: books.size, maxMarkets, metadataMarkets: metadata.size, fxAt: fxSnapshot?.generatedAt ?? null }),
    stop() { controller.abort(); if (!suppliedBudget) budget.stop(); books.clear(); metadata.clear(); },
  };
}

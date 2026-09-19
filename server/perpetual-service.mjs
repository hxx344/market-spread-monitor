import { EXCHANGES, discoverMarkets, createSubscriptions, parseMessage, getControlResponse } from '../modules/perpetual/exchanges.mjs';
import { createGzip, constants as zlibConstants } from 'node:zlib';

export const PERPETUAL_STALE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const fields = ['bid', 'ask', 'mark', 'last', 'fundingRate', 'fundingIntervalHours', 'nextFundingAt'];
const priceFields = new Set(['bid', 'ask', 'mark', 'last']);
const streamValueFields = [...fields, 'base', 'quoteCurrency', 'multiplier', 'displayBase', 'contractUnit', 'collateralCurrency', 'comparable'];

/** Shared incremental frame, preserving actual field times while pacing unchanged price confirmations. */
export function createPerpetualDelta(snapshot, previous, freshnessMs = 5_000) {
  const updates = [], seen = new Set();
  for (const quote of snapshot.quotes) {
    const key = `${quote.exchange}:${quote.symbol}`, old = previous.get(key);
    seen.add(key);
    if (!old || streamValueFields.some(field => old[field] !== quote[field]) || Math.floor(quote.receivedAt / freshnessMs) > Math.floor(old.receivedAt / freshnessMs)) {
      updates.push(quote); previous.set(key, quote);
    }
  }
  const removed = [];
  for (const key of previous.keys()) if (!seen.has(key)) { removed.push(key); previous.delete(key); }
  const metadata = { ...snapshot }; delete metadata.quotes;
  return { ...metadata, type: 'delta', updates, removed };
}

/** Merge sparse ticker messages without letting funding updates refresh old prices. */
export function mergePerpetualQuote(previous, update, now = Date.now()) {
  if (!update || typeof update.exchange !== 'string' || typeof update.symbol !== 'string' || typeof update.base !== 'string' || !['USD', 'USDT', 'USDC', 'USD1', 'USDG'].includes(update.quoteCurrency)) return previous;
  const sourceTime = Number.isFinite(update.sourceTime) ? update.sourceTime : null;
  if (sourceTime !== null && sourceTime > now + MAX_FUTURE_MS) return previous;
  const time = sourceTime === null ? now : Math.min(now, sourceTime);
  const multiplier = Number.isFinite(update.multiplier) && update.multiplier > 0 ? update.multiplier : 1;
  const identityChanged = previous && (previous.base !== update.base || previous.quoteCurrency !== update.quoteCurrency || (previous.multiplier ?? 1) !== multiplier || (typeof update.contractUnit === 'string' && previous.contractUnit !== update.contractUnit));
  const next = previous && !identityChanged ? { ...previous } : {
    exchange: update.exchange, symbol: update.symbol, base: update.base, quoteCurrency: update.quoteCurrency,
    multiplier,
    bid: null, ask: null, mark: null, last: null, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null,
    receivedAt: now, sourceTime, transport: 'ws',
  };
  let changed = false, rateUpdated = false;
  for (const field of fields) {
    if (!Object.hasOwn(update, field)) continue;
    const value = update[field];
    if (value !== null && (!Number.isFinite(value) || (priceFields.has(field) && value <= 0) || (field === 'fundingIntervalHours' && value <= 0))) continue;
    const stamp = priceFields.has(field) ? `${field}At` : field === 'fundingRate' ? 'fundingAt' : `${field}UpdatedAt`;
    if (Number.isFinite(next[stamp]) && time < next[stamp]) continue;
    if (field === 'fundingIntervalHours' && next[field] !== null && value !== next[field] && !rateUpdated) next.fundingRate = null;
    next[field] = value; next[stamp] = time; changed = true;
    if (field === 'fundingRate') rateUpdated = true;
  }
  if (!changed) return previous;
  for (const field of ['displayBase', 'contractUnit', 'collateralCurrency']) if (typeof update[field] === 'string') next[field] = update[field];
  if (typeof update.comparable === 'boolean') next.comparable = update.comparable;
  next.bidAskAt = Number.isFinite(next.bidAt) && Number.isFinite(next.askAt) ? Math.min(next.bidAt, next.askAt) : undefined;
  next.receivedAt = now;
  next.sourceTime = sourceTime;
  return next;
}

export function createPerpetualService({ store, exchanges = EXCHANGES, discover = discoverMarkets, subscriptions = createSubscriptions, parse = parseMessage, control = getControlResponse, WebSocketImpl = globalThis.WebSocket, clock = Date.now, staleAfterMs = PERPETUAL_STALE_MS, retryMs = 5_000, discoveryIntervalMs = 30 * 60_000, saveIntervalMs = 5_000, broadcastIntervalMs = 1_000 } = {}) {
  const quotes = new Map(), dirty = new Map(), pendingPrunes = new Map(), connections = new Set(), clients = new Map(), timers = new Set(), discoveries = new Map(), publishedQuotes = new Map();
  const states = new Map(exchanges.map(exchange => [exchange.id, { ...exchange, kind: exchange.kind ?? exchange.type, marketCount: 0, lastMessageAt: null, error: null, discovering: false }]));
  let running = false, storageError = null, broadcastTimer, saveTimer, refreshTimer;
  let lastFullFrameAt = 0;
  const metrics = { lastWriteMs: 0, lastPublishMs: 0, frames: 0, fullFrames: 0, frameBytes: 0, lastFrameUpdates: 0 };
  for (const quote of store?.load() ?? []) if (states.has(quote.exchange)) quotes.set(`${quote.exchange}:${quote.symbol}`, quote);
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); if (running) fn(); }, ms);
    timer.unref?.(); timers.add(timer); return timer;
  };
  function flush() {
    if (!dirty.size && !pendingPrunes.size) return;
    const started = performance.now();
    try {
      for (const [exchange, symbols] of pendingPrunes) { store?.prune(exchange, symbols); pendingPrunes.delete(exchange); }
      if (dirty.size) { store?.save([...dirty.values()]); dirty.clear(); }
      storageError = null;
    }
    catch { storageError = '合约行情保存失败，当前仅显示内存报价。'; }
    finally { metrics.lastWriteMs = Number((performance.now() - started).toFixed(2)); }
  }
  function snapshot() {
    const now = clock();
    const values = [...quotes.values()], counts = new Map();
    for (const quote of values) {
      const own = counts.get(quote.exchange) ?? { all: 0, fresh: 0 }; own.all++;
      if ((quote.bid > 0 && quote.ask >= quote.bid && (quote.bidAskAt ?? 0) >= now - staleAfterMs) || (quote.mark > 0 && (quote.markAt ?? 0) >= now - staleAfterMs)) own.fresh++;
      counts.set(quote.exchange, own);
    }
    const connectedExchanges = new Set([...connections].filter(connection => connection.socket?.readyState === 1).map(connection => connection.exchange));
    const exchangeViews = [...states.values()].map(state => {
      const own = counts.get(state.id) ?? { all: 0, fresh: 0 };
      const status = connectedExchanges.has(state.id) && own.fresh ? 'live' : own.all ? 'stale' : state.error ? 'error' : 'connecting';
      return { id: state.id, name: state.name, kind: state.kind, status, marketCount: state.marketCount, quoteCount: own.fresh, lastMessageAt: state.lastMessageAt, error: state.error };
    });
    const live = exchangeViews.filter(exchange => exchange.status === 'live').length;
    return { schemaVersion: 1, monitorId: 'perpetual', status: live === states.size && live > 0 ? 'live' : live ? 'partial' : quotes.size ? 'snapshot' : 'connecting', generatedAt: now, staleAfterMs, exchanges: exchangeViews, quotes: values, storageError };
  }
  function send(connection, value) {
    if (connection.socket.readyState === 1) connection.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  function connect(exchange, spec, attempt = 0) {
    if (!running || (spec.generation != null && spec.generation !== states.get(exchange).generation)) return;
    const state = states.get(exchange), connection = { exchange, socket: null, timers: [], closed: false, lastMessageAt: clock() };
    const context = structuredClone(spec.context ?? {});
    const clear = () => { for (const timer of connection.timers) { clearTimeout(timer); clearInterval(timer); timers.delete(timer); } connections.delete(connection); };
    connection.dispose = () => { connection.closed = true; clear(); try { connection.socket?.close(); } catch {} };
    const fail = message => {
      if (connection.closed) return;
      state.error = message; connection.dispose();
      if (running) later(() => connect(exchange, spec, attempt + 1), Math.min(60_000, retryMs * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * retryMs / 4));
    };
    try {
      connection.socket = new WebSocketImpl(spec.url);
      connections.add(connection);
      connection.timers.push(later(() => { if (connection.socket.readyState !== 1) fail('WebSocket 连接超时，正在重连。'); }, 20_000));
      connection.socket.addEventListener('open', () => {
        if (connection.closed || !running) return connection.dispose();
        (spec.subscribe ?? []).forEach((message, index) => connection.timers.push(later(() => {
          try { send(connection, message); } catch { fail('WebSocket 订阅失败，正在重连。'); }
        }, index * (spec.sendIntervalMs ?? 100))));
        if (spec.heartbeat) {
          const heartbeat = setInterval(() => { try { send(connection, spec.heartbeat); } catch { fail('WebSocket 心跳失败，正在重连。'); } }, spec.heartbeatMs ?? 20_000);
          heartbeat.unref?.(); connection.timers.push(heartbeat);
        }
        const watchdog = setInterval(() => { if (clock() - connection.lastMessageAt > 90_000) fail('WebSocket 未收到数据，正在重连。'); }, 15_000);
        watchdog.unref?.(); connection.timers.push(watchdog);
      });
      connection.socket.addEventListener('message', event => {
        if (connection.closed || !running) return;
        const now = clock(); connection.lastMessageAt = now;
        let payload;
        try { payload = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(Buffer.from(event.data).toString()); }
        catch { payload = event.data; }
        try {
          const reply = control(exchange, payload);
          if (reply != null) send(connection, reply);
          const updates = parse(exchange, payload, spec.markets ?? [], now, context);
          for (const update of updates) {
            if (update.exchange !== exchange) continue;
            const key = `${exchange}:${update.symbol}`, previous = quotes.get(key), next = mergePerpetualQuote(previous, update, now);
            if (next && next !== previous) { quotes.set(key, next); dirty.set(key, next); state.lastMessageAt = now; state.error = null; attempt = 0; }
          }
        } catch { fail('行情消息无效，正在重新订阅。'); }
      });
      connection.socket.addEventListener('error', () => fail('WebSocket 暂不可用，正在重连。'));
      connection.socket.addEventListener('close', () => fail('WebSocket 已断开，正在重连。'));
    } catch { fail('无法建立 WebSocket，正在重试。'); }
  }
  async function refresh(exchange) {
    const state = states.get(exchange);
    if (!running || state.discovering) return;
    state.discovering = true;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const markets = await discover(exchange, { signal: controller.signal });
        if (!running) return;
        if (!markets.length) throw new Error('No active markets');
        const specs = subscriptions(exchange, markets);
        if (!specs.length) throw new Error('No subscriptions');
        state.marketCount = markets.length;
        // Funding intervals, contract multipliers and channel IDs may change while symbols stay the same.
        const signature = JSON.stringify([...markets].sort((left, right) => left.symbol.localeCompare(right.symbol)));
        if (signature === state.signature) return;
        const symbols = new Set(markets.map(market => market.symbol));
        const identities = new Map(markets.map(market => [market.symbol, market]));
        const keepStored = new Set(symbols);
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange) continue;
          const market = identities.get(quote.symbol);
          if (!market || quote.base !== market.base || quote.quoteCurrency !== market.quoteCurrency || (quote.multiplier ?? 1) !== (market.multiplier ?? 1) || (market.contractUnit && market.contractUnit !== quote.contractUnit) || (market.comparable === false && quote.comparable !== false)) {
            quotes.delete(key); dirty.delete(key); keepStored.delete(quote.symbol);
          }
        }
        pendingPrunes.set(exchange, keepStored);
        try { store?.prune(exchange, keepStored); pendingPrunes.delete(exchange); } catch { storageError = '合约行情保存失败，正在重试。'; }
        // Retire previous-generation reconnect timers as well as live connections.
        state.generation = (state.generation ?? 0) + 1;
        for (const connection of [...connections]) if (connection.exchange === exchange) connection.dispose();
        state.signature = signature;
        for (const spec of specs) {
          const current = { ...spec, generation: state.generation };
          later(() => connect(exchange, current), spec.startDelayMs ?? 0);
        }
      } catch {
        if (running) { state.error = '合约列表获取失败，正在重试。'; later(() => { void refresh(exchange); }, 30_000); }
      } finally { state.discovering = false; discoveries.delete(exchange); }
    })();
    discoveries.set(exchange, { controller, promise });
    await promise;
  }
  function closeStreams() { for (const client of clients.values()) client.output.end(); clients.clear(); publishedQuotes.clear(); }
  return {
    start() {
      if (running) return; running = true;
      for (const exchange of states.keys()) void refresh(exchange);
      refreshTimer = setInterval(() => { for (const exchange of states.keys()) void refresh(exchange); }, discoveryIntervalMs);
      saveTimer = setInterval(flush, saveIntervalMs);
      broadcastTimer = setInterval(() => {
        if (!clients.size) return;
        const started = performance.now(), current = snapshot();
        const delta = createPerpetualDelta(current, publishedQuotes);
        const full = current.generatedAt - lastFullFrameAt >= 30_000;
        if (full) { lastFullFrameAt = current.generatedAt; metrics.fullFrames++; }
        const message = `data: ${JSON.stringify(full ? current : delta)}\n\n`;
        let fullMessage = full ? message : null;
        for (const [response, client] of clients) {
          const { output } = client;
          if (response.destroyed || response.writableEnded) { clients.delete(response); continue; }
          if (response.writableLength + output.writableLength > 4_000_000) { response.destroy(); clients.delete(response); continue; }
          if (response.writableNeedDrain || output.writableNeedDrain) { client.needsSnapshot = true; continue; }
          // A slow reader cannot skip a delta and continue with a broken baseline.
          if (client.needsSnapshot) { fullMessage ??= `data: ${JSON.stringify(current)}\n\n`; output.write(fullMessage); client.needsSnapshot = false; }
          else output.write(message);
        }
        metrics.frames++; metrics.frameBytes = Buffer.byteLength(message); metrics.lastFrameUpdates = full ? current.quotes.length : delta.updates.length;
        metrics.lastPublishMs = Number((performance.now() - started).toFixed(2));
      }, broadcastIntervalMs);
      for (const timer of [refreshTimer, saveTimer, broadcastTimer]) timer.unref?.();
    },
    async stop() {
      running = false; closeStreams();
      for (const timer of [refreshTimer, saveTimer, broadcastTimer, ...timers]) clearTimeout(timer);
      timers.clear();
      const pending = [...discoveries.values()];
      for (const item of pending) item.controller.abort();
      for (const connection of [...connections]) connection.dispose();
      await Promise.allSettled(pending.map(item => item.promise));
      flush(); store?.close();
    },
    closeStreams, snapshot, healthy: () => !storageError,
    metrics: () => ({ ...metrics, quotes: quotes.size, pendingWrites: dirty.size, connections: connections.size, clients: clients.size }),
    actions: { quote: ['GET'], stream: ['GET'], diagnostics: ['GET'] },
    handle(action) { if (action === 'quote') return snapshot(); if (action === 'diagnostics') return this.metrics(); },
    stream(request, response) {
      const gzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers['accept-encoding'] ?? '');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
      // Streaming compression keeps full-market updates practical on mobile links.
      const output = gzip ? createGzip({ level: 1, flush: zlibConstants.Z_SYNC_FLUSH }) : response;
      if (gzip) { output.pipe(response); output.on('error', () => response.destroy()); }
      const initial = snapshot();
      if (!clients.size) { publishedQuotes.clear(); for (const quote of initial.quotes) publishedQuotes.set(`${quote.exchange}:${quote.symbol}`, quote); lastFullFrameAt = initial.generatedAt; }
      output.write(`retry: 5000\ndata: ${JSON.stringify(initial)}\n\n`);
      clients.set(response, { output, needsSnapshot: false });
      response.once('close', () => { clients.delete(response); if (!clients.size) publishedQuotes.clear(); if (gzip) output.destroy(); });
    },
  };
}

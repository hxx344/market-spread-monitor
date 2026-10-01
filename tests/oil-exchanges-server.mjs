// Browser-only fixture: native Windows/Linux Next server, no collectors or live exchange calls.
// Run after npm run build:linux: node tests/oil-exchanges-server.mjs
import { createServer } from 'node:http';
import next from 'next';
import { registerInitialMarket } from '../server/initial-market.mjs';
import { comparisonExchanges, exchangeDefinition } from '../lib/exchange-quotes.ts';
import oilArchive from '../public/oil/data/binance-2026.json' with { type: 'json' };
import oilCandles from '../public/oil/data/binance-15m.json' with { type: 'json' };

function exchangeQuote(exchange, id, now = Date.now()) {
  const spec = exchangeDefinition(exchange, id), at = new Date(now).toISOString();
  const leg = (symbol, price, rate) => ({ symbol, price, fundingPrice: price, fundingRate: rate, fundingIntervalHours: 1, nextFundingAt: new Date(Math.floor(now / 3_600_000 + 1) * 3_600_000).toISOString(), ...(exchange === 'lighter' ? { nextFundingEstimated: true } : {}) });
  const result = { exchange, monitorId: id, currency: spec.currency, priceBasis: spec.priceBasis, fundingPriceBasis: spec.fundingPriceBasis, fetchedAt: at, fundingFetchedAt: at, status: 'live',
    left: leg(spec.left, id === 'oil' ? 104 : 180, 0.0001), right: leg(spec.right, id === 'oil' ? 100 : 1200, 0.0002), fundingError: '' };
  if (exchange === 'variational') {
    result.timestampBasis = 'received'; result.fundingFetchedAt = null;
    for (const item of [result.left, result.right]) { item.fundingRate = null; item.fundingIntervalHours = null; item.nextFundingAt = null; }
    result.fundingError = '公开资金费口径未确认，暂不计算年化。';
  }
  return result;
}
const services = new Map(['oil', 'hynix'].map(id => [id, { handle(action) {
  const match = /^exchanges\/([^/]+)\/quote$/.exec(action);
  if (match && comparisonExchanges(id).includes(match[1])) return exchangeQuote(match[1], id);
  if (id === 'oil' && action === 'quote') return { ...oilArchive.market, status: 'snapshot' };
  if (id === 'oil' && action === 'candles/15m') return { ...oilCandles, status: 'snapshot' };
  throw Error('Fixture unavailable');
} }]));
const release = registerInitialMarket(services);
const app = next({ dev: false, hostname: '127.0.0.1', port: 3192 });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  const match = /^\/api\/monitors\/(oil|hynix)\/(exchanges\/[^/]+\/quote)$/.exec(request.url);
  if (match) {
    try { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(services.get(match[1]).handle(match[2]))); }
    catch { response.writeHead(404).end(); }
    return;
  }
  // Browser scenarios never reach real upstreams, even for unrelated panel reads.
  if (request.url.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Fixture unavailable' })); return; }
  return handler(request, response);
});
await new Promise(resolve => server.listen(3192, '127.0.0.1', resolve));
console.log('Oil exchange fixture ready at http://127.0.0.1:3192');
async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); release(); await app.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

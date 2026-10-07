// Local production-rendering fixture for gold-oil-loading.browser.mjs.
// Run after build:linux: node tests/gold-oil-loading-server.mjs
// No collectors, notifications, network data sources or persistent files.
import { createServer } from 'node:http';
import next from 'next';
import { registerInitialMarket } from '../server/initial-market.mjs';

const now = Date.now(), end = Math.floor(now / 900000) * 900000, start = end - 672 * 900000;
const common = { source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() };
const history = { ...common, interval: '15m', coverageStart: start, points: Array.from({ length: 672 }, (_, index) => {
  const cl = 80 + Math.sin(index / 20), xau = index === 660 ? null : 4000 + index / 10;
  return { time: start + index * 900000, cl, xau, ratio: xau === null ? null : xau / cl };
}) };
const quote = { ...common, cl: { symbol: 'CLUSDT', price: 80, updatedAt: common.fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: common.fetchedAt }, ratio: 50, funding: null };
const funding = { source: 'Binance', status: 'live', fetchedAt: common.fetchedAt, coverageStart: start, coverageEnd: end,
  points: Array.from({ length: 84 }, (_, index) => ({ time: start + index * 7200000, cl: 0.0001, xau: 0.0003 })) };
const bz = {
  quote: { ...quote, oilType: 'bz', cl: undefined, oil: { symbol: 'BZUSDT', price: 100, updatedAt: common.fetchedAt }, ratio: 40 },
  history: { ...history, oilType: 'bz', points: history.points.map(({ time, xau }) => ({ time, oil: 100, xau, ratio: xau === null ? null : xau / 100 })) },
  funding: { ...funding, oilType: 'bz', points: funding.points.map(({ time, xau }) => ({ time, oil: 0.0005, xau })) },
};
delete bz.quote.cl;
const snapshots = { quote, history, funding, bz };
const release = registerInitialMarket(new Map([['cl-xau', { handle(action) { return action.startsWith('bz/') ? bz[action.slice(3)] : snapshots[action]; } }]]));
const app = next({ dev: false, hostname: '127.0.0.1', port: 3190 });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  if (request.url === '/__fixture') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(snapshots)); return; }
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  return handler(request, response);
});
await new Promise(resolve => server.listen(3190, '127.0.0.1', resolve));
console.log('Seeded chart fixture ready at http://127.0.0.1:3190');
async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); release(); await app.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

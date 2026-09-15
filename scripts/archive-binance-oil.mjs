import { readFile, writeFile } from 'node:fs/promises';
import { readExchangeQuote } from '../lib/exchange-service.ts';
import { marketFromExchangeQuote, fetchDailySnapshot } from '../modules/oil/binance.mjs';
import { fetchIntradaySnapshot } from '../modules/oil/intraday.mjs';
import { fetchFundingSnapshot } from '../modules/oil/binance-funding-history.mjs';

async function previous(name) {
  try { return JSON.parse(await readFile(new URL(`../public/oil/data/${name}.json`, import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
const market = marketFromExchangeQuote(await readExchangeQuote('binance', 'oil'));
const datasets = await Promise.all([
  fetchIntradaySnapshot(await previous('binance-15m')),
  fetchFundingSnapshot(await previous('binance-funding-2026')),
  fetchDailySnapshot(market),
]);
for (const [index, name] of ['binance-15m', 'binance-funding-2026', 'binance-2026'].entries()) {
  await writeFile(new URL(`../public/oil/data/${name}.json`, import.meta.url), JSON.stringify(datasets[index]) + '\n');
  console.log(JSON.stringify({ file: name, ...datasets[index].metadata }));
}

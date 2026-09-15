import { readFile, writeFile } from 'node:fs/promises';
import { fetchIntradaySnapshot } from '../modules/oil/intraday.mjs';

const filename = new URL('../public/oil/data/hyperliquid-15m.json', import.meta.url);
let previous = null;
try { previous = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const snapshot = await fetchIntradaySnapshot(previous);
await writeFile(filename, JSON.stringify(snapshot) + '\n');
console.log(JSON.stringify(snapshot.metadata));

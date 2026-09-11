import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fetchSnapshot } from '../modules/oil/hyperliquid.mjs';

const directory = new URL('../public/oil/data/', import.meta.url);
const file = new URL('hyperliquid-2026.json', directory);
// Keep the last verified snapshot intact unless all three requests and validation succeed.
const snapshot = await fetchSnapshot();
await mkdir(directory, { recursive: true });
await writeFile(new URL('hyperliquid-2026.json.tmp', directory), JSON.stringify(snapshot, null, 2) + '\n');
await rename(new URL('hyperliquid-2026.json.tmp', directory), file);
console.log(JSON.stringify({ fetchedAt: snapshot.metadata.fetchedAt, first: snapshot.metadata.firstCommonObservation, last: snapshot.metadata.lastCommonObservation, pairedDays: snapshot.metadata.pairedObservationRows, market: snapshot.market }, null, 2));

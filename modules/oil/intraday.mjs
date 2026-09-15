import { ASSETS, API_URL, requestInfo } from './hyperliquid.mjs';

export const OIL_CANDLE_INTERVAL = '15m';
export const OIL_CANDLE_MS = 900_000;
export const OIL_CANDLE_ACTION = 'candles/15m';
export const OIL_CANDLE_REFRESH_MS = 60_000;
const price = value => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) throw Error('Invalid oil candle close');
  return Number(value);
};

/** Each spread observation pairs the two completed trade-candle closes at the same UTC start. */
export function pairIntradayCandles(brent, wti, now = Date.now()) {
  const collect = (rows, coin) => {
    if (!Array.isArray(rows)) throw Error('Invalid oil candle response');
    const result = new Map();
    for (const row of rows) {
      if (row.s !== coin || row.i !== OIL_CANDLE_INTERVAL || !Number.isSafeInteger(row.t) || row.t < 0 || row.t % OIL_CANDLE_MS || row.T !== row.t + OIL_CANDLE_MS - 1) throw Error('Unexpected oil candle');
      if (row.T >= now) continue;
      if (result.has(row.t)) throw Error('Duplicate oil candle');
      result.set(row.t, price(row.c));
    }
    return result;
  };
  const left = collect(brent, ASSETS.brent.coin), right = collect(wti, ASSETS.wti.coin);
  if (!left.size || !right.size) throw Error('No completed oil candles');
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b).map(time => ({ time, brent: left.get(time) ?? null, wti: right.get(time) ?? null }));
}

/** @param {'live' | 'snapshot'} status */
export function createIntradaySnapshot(rows, fetchedAt, status = 'live') {
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received) || !['live', 'snapshot'].includes(status) || !Array.isArray(rows) || !rows.length) throw Error('Invalid oil intraday snapshot');
  let previous = -1;
  const data = rows.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time < 0 || row.time % OIL_CANDLE_MS || row.time + OIL_CANDLE_MS > received || row.time <= previous) throw Error('Invalid oil candle timestamp');
    previous = row.time;
    const brent = row.brent === null ? null : price(row.brent), wti = row.wti === null ? null : price(row.wti);
    if (brent === null && wti === null) throw Error('Empty oil candle');
    return { time: row.time, brent, wti };
  });
  const paired = data.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length) throw Error('No paired 15-minute candles');
  const first = paired[0].time, last = paired.at(-1).time, expected = (last - first) / OIL_CANDLE_MS + 1;
  return { status, metadata: { source: 'Hyperliquid / XYZ', api: API_URL, interval: OIL_CANDLE_INTERVAL, timezone: 'UTC', priceBasis: 'Paired completed 15-minute trade candle closes', fetchedAt, firstCommonObservation: new Date(first).toISOString(), lastCommonObservation: new Date(last).toISOString(), pairedObservationRows: paired.length, expectedObservationRows: expected, missingObservationRows: expected - paired.length }, data };
}

export function validateIntradaySnapshot(input) {
  if (input?.metadata?.interval !== OIL_CANDLE_INTERVAL || input?.metadata?.timezone !== 'UTC' || !['live', 'snapshot'].includes(input?.status)) throw Error('Expected 15-minute UTC candles');
  const snapshot = createIntradaySnapshot(input.data, input.metadata.fetchedAt, input.status);
  for (const field of ['firstCommonObservation', 'lastCommonObservation', 'pairedObservationRows', 'expectedObservationRows', 'missingObservationRows']) if (snapshot.metadata[field] !== input.metadata[field]) throw Error('Oil intraday metadata mismatch');
  return snapshot;
}

/**
 * Resume from SQLite, overlap recent bars, and repair recoverable older gaps without trimming saved history.
 * @param {ReturnType<typeof createIntradaySnapshot> | null} existing
 */
export async function fetchIntradaySnapshot(existing = null, options = {}) {
  const now = options.now ?? Date.now(), previous = existing ? validateIntradaySnapshot(existing) : null;
  const earliestAvailable = Math.floor(now / OIL_CANDLE_MS) * OIL_CANDLE_MS - 5000 * OIL_CANDLE_MS;
  let missing = Infinity, expected = previous?.data[0]?.time;
  for (const row of previous?.data ?? []) {
    if (row.time > expected && row.time > earliestAvailable) missing = Math.min(missing, Math.max(expected, earliestAvailable));
    if ((row.brent === null || row.wti === null) && row.time >= earliestAvailable) missing = Math.min(missing, row.time);
    expected = row.time + OIL_CANDLE_MS;
  }
  const startTime = Math.max(0, earliestAvailable, previous ? Math.min(previous.data.at(-1).time - 96 * OIL_CANDLE_MS, missing) : earliestAvailable);
  const [brent, wti] = await Promise.all(Object.values(ASSETS).map(asset => requestInfo({ type: 'candleSnapshot', req: { coin: asset.coin, interval: OIL_CANDLE_INTERVAL, startTime, endTime: now } }, options)));
  const merged = new Map((previous?.data ?? []).map(row => [row.time, row]));
  for (const row of pairIntradayCandles(brent, wti, now)) {
    const old = merged.get(row.time);
    merged.set(row.time, { time: row.time, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null });
  }
  return createIntradaySnapshot([...merged.values()].sort((a, b) => a.time - b.time), new Date(now).toISOString());
}

export function intradayChartRows(snapshot) {
  return validateIntradaySnapshot(snapshot).data.filter(row => row.brent !== null && row.wti !== null).map(row => ({ ...row, date: new Date(row.time).toISOString(), spread: Math.round((row.brent - row.wti) * 1e6) / 1e6 }));
}

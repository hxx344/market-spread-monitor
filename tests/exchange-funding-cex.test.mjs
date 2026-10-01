import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCexFundingHistoryReader, parseCexFundingHistory } from '../lib/exchange-funding-cex.ts';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000;
const exchanges = ['binance', 'bybit', 'okx', 'bitget'];
const contract = (exchange, base = 'BZ') => exchange === 'okx' ? `${base}-USDT-SWAP` : `${base}USDT`;
function row(exchange, time = NOW - HOUR, rate = '-0.000118', base = 'BZ') {
  const symbol = contract(exchange, base);
  if (exchange === 'bybit') return { symbol, fundingRateTimestamp: String(time), fundingRate: rate };
  if (exchange === 'okx') return { instId: symbol, instType: 'SWAP', method: 'current_period', fundingTime: String(time), fundingRate: '0.9', realizedRate: rate };
  return { symbol, fundingTime: exchange === 'binance' ? time : String(time), fundingRate: rate, ...(exchange === 'binance' ? { rateType: 'Regular' } : {}) };
}
function envelope(exchange, records) {
  if (exchange === 'binance') return records;
  if (exchange === 'bybit') return { retCode: 0, result: { category: 'linear', list: records } };
  return { code: exchange === 'okx' ? '0' : '00000', data: records };
}
const parse = (exchange, records) => parseCexFundingHistory(exchange, contract(exchange), envelope(exchange, records), NOW);

for (const exchange of exchanges) {
  test(`${exchange}: preserves decimal rates and exact source milliseconds, sorts, deduplicates and removes future records`, () => {
    const early = NOW - 5 * HOUR + 137, recent = NOW - HOUR + 987;
    const records = [row(exchange, recent, '0'), row(exchange, NOW + HOUR, '0.0004'), row(exchange, early), row(exchange, recent, 0)];
    assert.deepEqual(parse(exchange, records), [{ time: early, rate: -0.000118 }, { time: recent, rate: 0 }]);
    assert.deepEqual(parse(exchange, []), []);
    assert.deepEqual(parse(exchange, [row(exchange, NOW, '0.0001')]), [{ time: NOW, rate: 0.0001 }]);
    assert.deepEqual(parseCexFundingHistory(exchange, contract(exchange, 'CL'), envelope(exchange, [row(exchange, recent, '0', 'CL')]), NOW), [{ time: recent, rate: 0 }]);
  });

  test(`${exchange}: rejects malformed rates, time units, contract identities and conflicting settlements`, () => {
    const rateField = exchange === 'okx' ? 'realizedRate' : 'fundingRate';
    const timeField = exchange === 'bybit' ? 'fundingRateTimestamp' : 'fundingTime';
    for (const value of [undefined, null, '', ' ', false, {}, [], 'NaN', NaN, Infinity, 'Infinity', '0x10', '1.01']) {
      assert.throws(() => parse(exchange, [{ ...row(exchange), [rateField]: value }]), /Invalid CEX funding/);
    }
    for (const value of [undefined, null, '', 0, NOW / 1000, NOW - 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parse(exchange, [{ ...row(exchange), [timeField]: value }]), /Invalid CEX funding/);
    }
    assert.throws(() => parse(exchange, [row(exchange), row(exchange, NOW - HOUR, '0.0002')]), /Conflicting/);
    assert.throws(() => parse(exchange, [row(exchange, NOW - HOUR, '0', 'CL')]), /mismatch/);
    assert.throws(() => parse(exchange, [null]), /Invalid/);
    assert.throws(() => parseCexFundingHistory(exchange, 'BTCUSDT', envelope(exchange, []), NOW), /Unsupported/);
    const withoutIdentity = row(exchange);
    delete withoutIdentity[exchange === 'okx' ? 'instId' : 'symbol'];
    assert.equal(parse(exchange, [withoutIdentity]).length, 1);
  });
}

test('official success envelopes are required; API error objects cannot become empty successful history', () => {
  for (const exchange of exchanges) {
    for (const input of [null, {}, { code: '0' }, { code: 'error', data: [] }, { retCode: 10001, result: { list: [] } }]) {
      assert.throws(() => parseCexFundingHistory(exchange, contract(exchange), input, NOW));
    }
  }
  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: '0', result: { list: [] } }, NOW));
  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: 0, result: { category: 'inverse', list: [] } }, NOW));
  assert.throws(() => parseCexFundingHistory('okx', 'BZ-USDT-SWAP', { code: 0, data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('bitget', 'BZUSDT', { code: '0', data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('other', 'BZUSDT', [], NOW), /Unsupported/);
});

test('OKX uses only actual realized rates, including zero and historical next_period; Binance rejects dividend entries', () => {
  assert.deepEqual(parse('okx', [{ ...row('okx'), realizedRate: '0', method: 'next_period' }]), [{ time: NOW - HOUR, rate: 0 }]);
  assert.throws(() => parse('okx', [{ ...row('okx'), realizedRate: undefined }]), /Invalid/);
  assert.throws(() => parse('okx', [{ ...row('okx'), instType: 'FUTURES' }]), /instrument/);
  assert.throws(() => parse('binance', [{ ...row('binance'), rateType: 'Special' }]), /rate type/);
});

test('reader makes one recent-history request per leg without narrowing to the first records of a startTime window', async () => {
  const requested = [];
  const expected = {
    binance: ['fapi.binance.com', '/fapi/v1/fundingRate'],
    bybit: ['api.bybit.com', '/v5/market/funding/history'],
    okx: ['www.okx.com', '/api/v5/public/funding-rate-history'],
    bitget: ['api.bitget.com', '/api/v2/mix/market/history-fund-rate'],
  };
  for (const exchange of exchanges) {
    const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
      const parsed = new URL(url); requested.push(parsed);
      const base = parsed.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol').startsWith('BZ') ? 'BZ' : 'CL';
      return envelope(exchange, Array.from({ length: 40 }, (_, index) => row(exchange, NOW - (index + 1) * HOUR, '0.0001', base)));
    } });
    for (const base of ['BZ', 'CL']) {
      const result = await reader(exchange, contract(exchange, base));
      assert.equal(result.length, 40);
      const url = requested.at(-1);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.host, expected[exchange][0]);
      assert.equal(url.pathname, expected[exchange][1]);
      assert.equal(url.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol'), contract(exchange, base));
      assert.equal(url.searchParams.get(exchange === 'bitget' ? 'pageSize' : 'limit'), '40');
      assert.equal(url.searchParams.has('startTime'), false);
      if (exchange === 'binance' || exchange === 'bybit') assert.equal(url.searchParams.get('endTime'), String(NOW));
      if (exchange === 'bybit') assert.equal(url.searchParams.get('category'), 'linear');
      if (exchange === 'bitget') {
        assert.equal(url.searchParams.get('productType'), 'USDT-FUTURES');
        assert.equal(url.searchParams.get('pageNo'), '1');
      }
    }
    await assert.rejects(reader(exchange, 'BTCUSDT'), /Unsupported/);
  }
  assert.equal(requested.length, 8);
});

test('reader propagates request and parsing failures so the caller can preserve each leg independently', async () => {
  const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
    if (new URL(url).searchParams.get('symbol') === 'CLUSDT') throw new Error('HTTP 451');
    return envelope('binance', [row('binance')]);
  } });
  assert.equal((await reader('binance', 'BZUSDT')).length, 1);
  await assert.rejects(reader('binance', 'CLUSDT'), /HTTP 451/);
  const failedApi = createCexFundingHistoryReader({ clock: () => NOW, request: async () => ({ retCode: 10006, result: { list: [] } }) });
  await assert.rejects(failedApi('bybit', 'BZUSDT'), /response failed/);
});

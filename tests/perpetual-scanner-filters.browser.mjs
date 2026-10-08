// Start the Windows-native preview at 127.0.0.1:3193, then use an isolated Playwright CLI session:
// playwright-cli -s=scanner-ranges open about:blank --headed
// playwright-cli -s=scanner-ranges run-code --filename tests/perpetual-scanner-filters.browser.mjs
// All API data is deterministic and local; external requests are blocked.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', anchor = Date.UTC(2026, 9, 8), hour = 3_600_000;
  const rangeKey = 'market-monitor:perpetual-scanner-ranges:v1';
  const preferenceKey = 'market-monitor:perpetual:v1', displayKey = 'market-monitor:perpetual-scanner:v1';
  const target = 'COIN64', bases = Array.from({ length: 65 }, (_, index) => `COIN${String(index).padStart(2, '0')}`);
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }, { id: 'kraken', name: 'Kraken' }];
  let now = anchor;
  const errors = [], external = [], scannerRequests = [], counts = new Map(), historyReads = new Map();
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const onError = error => errors.push(error.message);
  const quote = (base, exchange) => {
    const index = bases.indexOf(base), price = exchange === 'binance' ? 100 : 101 + (64 - index) * .01;
    return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
      bid: price, ask: price, mark: price, last: price, bidAskAt: now, markAt: now, sourceTime: now, receivedAt: now, transport: 'rest',
      fundingRate: base === target && exchange === 'gate' ? -.0001 : 0, fundingIntervalHours: 8, fundingAt: now, nextFundingAt: now + hour,
      comparable: true, assetClass: 'crypto', identityVerified: true, identitySource: 'official fixture directory', collateralCurrency: 'USDT' };
  };
  const snapshot = () => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
    quotes: bases.flatMap(base => ['binance', 'gate'].map(exchange => quote(base, exchange))),
    exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: venue.id === 'kraken' ? 0 : bases.length, quoteCount: venue.id === 'kraken' ? 0 : bases.length, lastMessageAt: now, error: null })) });
  const metric = (value, currency = 'USD', error = '') => ({ value, currency: value === null ? null : currency, observedAt: value === null ? null : now, source: 'official fixture metric', error });
  const metricsFor = keys => Object.fromEntries([...new Set(keys)].map(key => {
    const [exchange, symbol] = key.split(':'), base = symbol.slice(0, -4), isTarget = base === target, long = exchange === 'binance', missing = base === 'COIN63';
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: missing ? 'error' : 'ready', fetchedAt: now,
      volume24h: metric(isTarget ? long ? 4_000_000 : 1_000_000_000 : 100_000, isTarget ? long ? 'USDC' : 'USDG' : 'USD'),
      // USD/USDT=2: the target's 1M USDT open interest is exactly 500K USD.
      openInterest: metric(isTarget && long ? 1_000_000 : base === 'COIN62' ? 0 : 100_000, isTarget && long ? 'USDT' : 'USD', missing ? 'upstream failed' : ''),
      error: missing ? 'upstream failed' : '' }];
  }));
  const pairKey = pair => JSON.stringify([pair.base, ...[pair.longKey, pair.shortKey].sort()]);
  const totalFor = (pair, hours) => {
    const key = `${pairKey(pair)}:${hours}`, read = (historyReads.get(key) ?? 0) + 1;
    historyReads.set(key, read);
    const pending = pair.base === target && hours === 168 && read === 1, missing = pair.base === 'COIN63';
    const value = pair.base === target ? -0.01 * hours / 8 : 0;
    return { hours, asOf: pending ? null : now, longPercent: pending || missing ? null : 0, shortPercent: pending || missing ? null : value,
      netPercent: pending || missing ? null : value, longCount: pending ? 0 : hours / 8, shortCount: pending ? 0 : hours / 8,
      status: pending ? 'pending' : missing ? 'partial' : 'ready', reason: pending ? '历史结算采集中' : missing ? '历史不足或窗口内无结算记录' : '' };
  };
  const rawHistory = pairs => Object.fromEntries([...new Set(pairs.flatMap(pair => [pair.longKey, pair.shortKey]))].map(key => {
    const [exchange, symbol] = key.split(':'), base = symbol.slice(0, -4), missing = base === 'COIN63';
    return [key, { key, exchange, symbol, identity: `${key}:fixture`, status: 'ready', fetchedAt: now, coverage: { from: now - 768 * hour, to: now }, error: '', backfillComplete: true,
      records: missing ? [] : Array.from({ length: 97 }, (_, index) => ({ time: now - (96 - index) * 8 * hour, rate: base === target && exchange === 'gate' ? -.0001 : 0 })) }];
  }));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ localOrigin, preferenceKey, displayKey, rangeKey }) => {
    if (location.origin !== localOrigin || sessionStorage.getItem('scanner-ranges-seeded')) return;
    sessionStorage.setItem('scanner-ranges-seeded', '1');
    localStorage.setItem(preferenceKey, JSON.stringify({ version: 2, sortBy: 'gross', minSpreadPercent: 0 }));
    localStorage.removeItem(displayKey); localStorage.removeItem(rangeKey);
  }, { localOrigin: origin, preferenceKey, displayKey, rangeKey });
  page.on('pageerror', onError);
  const rows = page.locator('.perp-scanner:visible .perp-scanner-table > tbody > tr:not(.perp-detail-row)');
  const names = () => rows.locator('.perp-base-cell > div > strong').allTextContents();
  const filterPanel = page.getByRole('region', { name: '套利组合范围筛选', exact: true });
  const field = label => page.getByRole('textbox', { name: label, exact: true });
  const toggle = page.locator('#perpetual-filter-toggle');
  const tick = async ms => { now += ms; await page.clock.runFor(ms); };
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await tick(100); }
    throw Error(`${message}; visible rows: ${(await names()).join(', ')}`);
  };
  const expectRows = expected => until(async () => JSON.stringify(await names()) === JSON.stringify(expected), `Expected ${expected.join(', ')}`);
  const menu = label => page.locator('.perp-scanner:visible .scanner-menu').filter({ has: page.locator('summary').filter({ hasText: label }) });
  const openMenu = async label => { const current = menu(label); if (await current.getAttribute('open') === null) await current.locator('summary').click(); return current; };
  const clear = async () => { if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); await filterPanel.getByRole('button', { name: '全部清除', exact: true }).click(); };
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (!path.startsWith('/api/')) return route.continue();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/stream')) return route.fulfill({ status: 503, body: 'fixture polling only' });
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: { available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: false, blockedBases: [] }, error: '', spotTransferPairs: [], venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })) } });
      if (path.endsWith('/perpetual/fx')) return route.fulfill({ json: { baseCurrency: 'USDT', generatedAt: now, staleAfterMs: 180_000,
        rates: Object.fromEntries([['USD', 2], ['USDC', 1.5], ['USDG', 3]].map(([currency, mid]) => [currency, { bid: mid, ask: mid, at: now, source: 'official fixture FX' }])) } });
      if (path.endsWith('/perpetual/scanner-data')) {
        const request = route.request().postDataJSON(); scannerRequests.push(request);
        check(request.pairs.length <= 30, 'Scanner requests contain at most 30 canonical pairs');
        return route.fulfill({ json: { schemaVersion: 1, generatedAt: now,
          metrics: request.metrics ? metricsFor(request.pairs.flatMap(pair => [pair.longKey, pair.shortKey])) : {},
          history: Object.fromEntries(request.pairs.filter(() => request.historyHours.length).map(pair => [pairKey(pair), Object.fromEntries(request.historyHours.map(hours => [hours, totalFor(pair, hours)]))])) } });
      }
      if (path.endsWith('/perpetual/metrics')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: metricsFor(route.request().postDataJSON().pairs.flatMap(pair => [pair.longKey, pair.shortKey])) } });
      if (path.endsWith('/perpetual/funding-history')) return route.fulfill({ json: { schemaVersion: 1, generatedAt: now, legs: rawHistory(route.request().postDataJSON().pairs) } });
      return route.fulfill({ status: 503, json: { error: 'Unavailable fixture detail' } });
    });
    await page.goto(`${origin}/?monitor=perpetual&goldOil=cl&goldOilExchange=binance`);
    await expectRows(bases.slice(0, 30));
    check((await page.locator('.perp-pagination').innerText()).includes('/ 65'), 'Default explicit zero spread produces 65 candidates');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expectRows(bases.slice(60));
    check((await names()).includes(target), 'The only 500K matching candidate originally lives on page three');
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expectRows(bases.slice(0, 30));
    await toggle.click();
    check(await filterPanel.getByRole('textbox').count() === 20, 'Four groups contain ten minimum/maximum pairs');
    check(await field('开仓价差最小值').inputValue() === '0', 'Legacy default threshold is explicitly migrated');
    const layout = await filterPanel.locator('fieldset').evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })));
    check(layout.length === 4 && layout.every(item => Math.abs(item.y - layout[0].y) < 2) && layout.every((item, index) => !index || item.x > layout[index - 1].x), 'Desktop filter groups share one four-column row');
    check(await filterPanel.evaluate(element => getComputedStyle(element).backgroundColor) === 'rgb(36, 35, 31)', 'The expanded panel uses the scanner dark background');
    await filterPanel.screenshot({ path: 'output/playwright/perpetual-ranges-desktop.png' });

    await field('多头持仓量最小值').fill('500k');
    await expectRows([target]);
    check(new Set(scannerRequests.flatMap(request => request.pairs.map(pair => pair.base))).size === 65, 'Data discovery covers all 65 original candidates before metric filtering');
    check(scannerRequests.length >= 3 && scannerRequests.every(request => request.pairs.length <= 30), 'Full coverage uses bounded requests instead of the first page only');
    check((counts.get('/api/monitors/perpetual/fx') ?? 0) >= 1, 'An amount condition requests the USD conversion quote');
    await field('多头持仓量最大值').fill('.5M'); await expectRows([target]);
    let columns = await openMenu(/^显示列/);
    await columns.getByRole('checkbox', { name: '持仓量', exact: true }).uncheck();
    await columns.locator('summary').press('Escape');
    check(await page.locator('[data-column="openInterest"]').count() === 0, 'Open-interest display can be hidden');
    await field('多头持仓量最大值').fill('');
    await field('多头持仓量最小值').fill('501K'); await expectRows([]);
    await field('多头持仓量最小值').fill('500K'); await expectRows([target]);
    await field('多头成交额最小值').fill('2m'); await field('多头成交额最大值').fill('4M');
    await field('空头成交额最小值').fill('1B'); await field('空头成交额最大值').fill('2b'); await expectRows([target]);
    check(await field('多头成交额最小值').getAttribute('aria-invalid') === 'false', 'K/M/B are accepted regardless of case');
    await field('多头成交额最小值').fill('oops');
    check(await field('多头成交额最小值').getAttribute('aria-invalid') === 'true', 'Malformed text is marked invalid');
    check((await filterPanel.innerText()).includes('请输入非负金额'), 'Malformed amount has an explicit explanation');
    await expectRows([]);
    await field('多头成交额最小值').fill('5M');
    check((await filterPanel.innerText()).includes('最小值不能大于最大值'), 'Reversed intervals are visibly rejected');
    await field('多头成交额最小值').fill('2M'); await expectRows([target]);

    await field('开仓价差最小值').fill('');
    await field('资金费差最小值').fill('-.011'); await field('资金费差最大值').fill('-.009');
    await field('资金费年化最小值').fill('-11'); await field('资金费年化最大值').fill('-10'); await expectRows([target]);
    const historyBefore = scannerRequests.length;
    await field('7天实际资金费最小值').fill('-.211'); await field('7天实际资金费最大值').fill('-.209');
    await until(() => scannerRequests.slice(historyBefore).some(request => request.historyHours.includes(168)), 'Seven-day filter requests its own settled window');
    await expectRows([]);
    check((await page.getByRole('status', { name: '全量筛选状态' }).innerText()).includes('待采集'), 'Pending history is distinguished from a zero total');
    await tick(3100); await expectRows([target]);
    columns = await openMenu(/^显示列/);
    await columns.getByRole('checkbox', { name: '24h 成交额', exact: true }).uncheck();
    await columns.getByRole('checkbox', { name: '7天 · 实际', exact: true }).uncheck();
    await columns.locator('summary').press('Escape');
    check(await page.locator('[data-column="volume"], [data-column="history7d"]').count() === 0, 'Both amount and history columns can be hidden with conditions still enabled');
    await expectRows([target]);
    await field('7天实际资金费最大值').fill('-.22');
    check((await filterPanel.innerText()).includes('最小值不能大于最大值'), 'Signed historical ranges retain strict bound ordering');
    await field('7天实际资金费最大值').fill('-.209'); await expectRows([target]);
    await filterPanel.screenshot({ path: 'output/playwright/perpetual-ranges-filled.png' });

    await field('搜索币种').fill(target);
    const exchanges = await openMenu(/^交易所/);
    await exchanges.getByRole('checkbox', { name: /^Kraken/ }).uncheck(); await exchanges.locator('summary').press('Escape');
    await page.getByRole('checkbox', { name: 'RWA', exact: true }).uncheck();
    const preserved = await page.evaluate(({ preferenceKey, displayKey }) => ({ filters: JSON.parse(localStorage.getItem(preferenceKey)), display: JSON.parse(localStorage.getItem(displayKey)) }), { preferenceKey, displayKey });
    await clear(); await expectRows([target, target]);
    check(await filterPanel.getByRole('textbox').evaluateAll(inputs => inputs.every(input => input.value === '')), 'All twenty range inputs are emptied');
    const retained = await page.evaluate(({ preferenceKey, displayKey }) => ({ filters: JSON.parse(localStorage.getItem(preferenceKey)), display: JSON.parse(localStorage.getItem(displayKey)) }), { preferenceKey, displayKey });
    check(JSON.stringify(retained.filters) === JSON.stringify(preserved.filters) && JSON.stringify(retained.display) === JSON.stringify(preserved.display), 'Clear-all retains search, exchange, category and display preferences');
    check(await field('搜索币种').inputValue() === target, 'Clear-all preserves the current search');
    await field('多头成交额最小值').fill('0'); await expectRows([target, target]);
    const cachedReads = scannerRequests.length;
    await page.getByRole('button', { name: '资金费套利', exact: true }).click();
    await until(async () => (await rows.first().locator('.perp-long > strong').innerText()).startsWith('Gate'), 'Funding sort exposes the opposite direction');
    await tick(1500);
    await page.getByRole('button', { name: '价格套利', exact: true }).click();
    await until(async () => (await rows.first().locator('.perp-long > strong').innerText()).startsWith('Binance'), 'Price sort returns the original direction');
    check(scannerRequests.length === cachedReads, 'Cached direction and sort changes do not add scanner HTTP requests');
    await clear();
    await field('开仓价差最小值').fill('-2'); await field('开仓价差最大值').fill('-.5'); await expectRows([target]);
    check((await rows.first().locator('.perp-long > strong').innerText()).startsWith('Gate'), 'A negative spread interval includes the reverse price direction');

    await clear(); await field('搜索币种').fill('COIN62');
    await field('24小时实际资金费最小值').fill('0'); await field('24小时实际资金费最大值').fill('0'); await expectRows(['COIN62', 'COIN62']);
    check(await rows.first().locator('[data-column="history24h"] strong').innerText() === '0.0000%', 'A complete actual zero displays as zero and satisfies closed zero bounds');
    await field('搜索币种').fill('COIN63'); await expectRows([]);
    await until(async () => (await page.getByRole('status', { name: '全量筛选状态' }).innerText()).includes('缺失或过期'), 'Incomplete settled history remains missing rather than matching zero');

    await clear(); await field('搜索币种').fill(target);
    await field('多头持仓量最小值').fill('500k'); await field('资金费差最小值').fill('-.02'); await field('7天实际资金费最大值').fill('0'); await expectRows([target]);
    await page.reload(); await expectRows([target]); await toggle.click();
    check(await field('多头持仓量最小值').inputValue() === '500k' && await field('资金费差最小值').inputValue() === '-.02' && await field('7天实际资金费最大值').inputValue() === '0', 'Reload restores exact amount and signed range text');
    check(await page.locator('[data-column="openInterest"], [data-column="volume"], [data-column="history7d"]').count() === 0, 'Hidden columns remain hidden while restored conditions still filter');
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), rangeKey);
    check(saved.longOpenInterest.min === '500k' && saved.spread.min === '', 'Storage is the complete raw input object without a hidden numeric threshold');

    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The 390px page does not overflow horizontally');
    check(await filterPanel.evaluate(element => element.scrollHeight > element.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)), 'The mobile panel scrolls within its own bounded height');
    const bounds = await filterPanel.boundingBox();
    check(Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390), 'Mobile filters remain inside the viewport');
    await field('30天实际资金费最大值').fill('1');
    await field('30天实际资金费最大值').press('Escape');
    check(await toggle.getAttribute('aria-expanded') === 'false', 'Escape collapses the filter panel');
    check(await toggle.evaluate(element => element === document.activeElement), 'Escape returns focus to the filter toggle');
    await toggle.click();
    await filterPanel.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await filterPanel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/perpetual-ranges-mobile.png', fullPage: false });
    await filterPanel.getByRole('button', { name: '收起', exact: true }).click();
    check(await toggle.getAttribute('aria-expanded') === 'false', 'Mobile has an explicit collapse action');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Collapsed mobile filters preserve page width');
    check(errors.length === 0, `Unexpected browser errors: ${errors.join('; ')}`);
    check(external.length === 0, `Unexpected external requests: ${external.join(', ')}`);
    return { passed: true, checks: ['four dark desktop groups and 20 accessible inputs', '65 candidates beyond page one and bounded batch coverage', 'true USD with K/M/B', 'signed percent ranges', 'hidden columns retain conditions', 'invalid and reversed bounds', 'all-clear preserves independent preferences', 'cached direction reversal without HTTP', 'history pending to ready, missing and true zero', 'reload persistence', '390px bounded scrolling, Escape and collapse'], scannerRequests: scannerRequests.length, apiRequests: Object.fromEntries(counts), screenshots: ['output/playwright/perpetual-ranges-desktop.png', 'output/playwright/perpetual-ranges-filled.png', 'output/playwright/perpetual-ranges-mobile.png'] };
  } finally { page.off('pageerror', onError); await page.clock.resume(); }
}

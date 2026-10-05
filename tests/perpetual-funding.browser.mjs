// Start the portable dev or built server on 127.0.0.1:3193, then use an isolated Playwright CLI session:
// playwright-cli -s=monitor-funding run-code --filename tests/perpetual-funding.browser.mjs
// Every API response is a local fixture; external requests are blocked. Screenshots stay untracked.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const origin = 'http://127.0.0.1:3193', hour = 3_600_000, anchor = Date.UTC(2026, 9, 6);
  let now = anchor;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], externalRequests = [], counts = new Map();
  const onPageError = error => errors.push(error.message);
  page.on('pageerror', onPageError);
  const bases = ['BTC', 'ETH', 'SOL', 'ADA'];
  const venues = [{ id: 'binance', name: 'Binance' }, { id: 'gate', name: 'Gate' }];
  const quote = (base, exchange) => {
    const binance = exchange === 'binance', initial = base === 'BTC' ? 99 : 199;
    return {
      exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1,
      bid: initial + (binance ? 0 : 3), ask: initial + (binance ? 1 : 4),
      mark: initial + (binance ? 0.5 : 3.5), last: initial + 1,
      bidAskAt: now, markAt: now, sourceTime: now, receivedAt: now, transport: 'rest',
      // BTC: Binance +0.04% / 4h, Gate +0.02% / 8h. Receiving Binance requires the negative-spread direction.
      fundingRate: base === 'ADA' && binance ? null : binance ? base === 'BTC' ? 0.0004 : base === 'SOL' ? 0.008 : 0.0002 : 0.0002,
      fundingIntervalHours: binance ? 4 : 8,
      fundingAt: base === 'SOL' && binance ? now - 300_001 : now,
      nextFundingAt: anchor + (binance ? hour : 2 * hour),
      comparable: true, assetClass: 'crypto', identityVerified: true,
      delisting: false, delistingAt: null, collateralCurrency: 'USDT',
    };
  };
  const snapshot = () => ({
    schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
    quotes: bases.flatMap(base => venues.map(venue => quote(base, venue.id))),
    exchanges: venues.map(venue => ({ ...venue, kind: 'cex', status: 'live', marketCount: bases.length, quoteCount: bases.length, lastMessageAt: now, error: null })),
  });
  await page.goto('about:blank');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(anchor - 1000) });
  await page.clock.pauseAt(new Date(anchor));
  await page.addInitScript(({ localOrigin }) => {
    if (location.origin !== localOrigin) return;
    localStorage.setItem('market-monitor:perpetual:v1', JSON.stringify({ version: 2, sortBy: 'gross' }));
    localStorage.setItem('market-monitor:perpetual-quality-budget:v1', JSON.stringify({ version: 2, takerOverrides: { binance: 0.05, gate: 0.05 }, slippagePercent: 0.10 }));
  }, { localOrigin: origin });
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) {
        externalRequests.push(url.origin);
        return route.abort('blockedbyclient');
      }
      if (!path.startsWith('/api/')) return route.continue();
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path.endsWith('/perpetual/crossex-settings')) return route.fulfill({ json: {
        available: true, generatedAt: now, revision: 0, metadataRevision: 1,
        config: { requireSpotTransfer: true, blockedBases: [] }, error: '',
        spotTransferPairs: bases.map(base => ({ base, exchanges: ['binance', 'gate'], networks: ['TEST'], checkedAt: now, expiresAt: now + 180_000 })),
        venues: venues.map(venue => ({ exchange: venue.id, state: 'live', checkedAt: now, error: '' })),
      } });
      if (path.endsWith('/perpetual/quote')) return route.fulfill({ json: snapshot() });
      if (path.endsWith('/perpetual/stream')) return route.fulfill({ status: 503, body: 'fixture polling only' });
      return route.fulfill({ status: 503, json: { error: 'Unavailable fixture detail' } });
    });
    const rankingRows = page.locator('.perp-table > tbody > tr:not(.perp-detail-row)');
    const baseNames = () => rankingRows.locator('.perp-base-cell > div > strong').allTextContents();
    const rowFor = base => rankingRows.filter({ has: page.getByText(base, { exact: true }) });
    const tick = async ms => { now += ms; await page.clock.runFor(ms); };
    const waitBases = async expected => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const actual = await baseNames();
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        await tick(100);
      }
      throw new Error(`Expected ranking ${expected.join(', ')}; actual ${(await baseNames()).join(', ')}`);
    };
    const checkDirection = async (base, long, short) => {
      const row = rowFor(base);
      check((await row.locator('.perp-long > strong').innerText()).startsWith(long), `${base} long leg is ${long}`);
      check((await row.locator('.perp-short > strong').innerText()).startsWith(short), `${base} short leg is ${short}`);
    };
    const sort = page.getByRole('combobox', { name: '价差排序', exact: true });
    const filters = page.getByRole('button', { name: /^筛选/ });
    const fundingView = page.getByRole('button', { name: /^资金费机会/ });
    const grossView = page.getByRole('button', { name: /^价差排名/ });
    await page.goto(`${origin}/?monitor=perpetual`);
    await waitBases(['BTC', 'ADA', 'ETH', 'SOL']);
    check(await sort.inputValue() === 'gross', 'Initial ranking is gross spread');
    await checkDirection('BTC', 'Binance', 'Gate');
    check((await rowFor('BTC').innerText()).includes('+2.000%'), 'Default BTC direction has a positive gross spread');

    await filters.click();
    await page.getByLabel('最低毛价差 / %', { exact: true }).fill('1.5');
    await waitBases(['BTC']);
    await fundingView.click();
    await waitBases(['BTC', 'ETH']);
    check(await sort.inputValue() === 'funding', 'Funding entry selects funding sort');
    check(await fundingView.getAttribute('aria-pressed') === 'true', 'Funding view is visibly selected');
    await checkDirection('BTC', 'Gate', 'Binance');
    const fundingText = await rowFor('BTC').innerText();
    check(fundingText.includes('−3.883%'), 'A negative gross spread remains eligible in the receiving-funding direction');
    check(fundingText.includes('+0.0600%'), 'Eight-hour funding spread uses each leg\'s actual period');
    check(fundingText.includes('24h 资金费 +0.1800%') && fundingText.includes('24h 扣费后 −0.1200%'), '24h funding and cost-adjusted estimates assume unchanged spread');
    const longSchedule = await rowFor('BTC').locator('.perp-long .perp-funding-schedule').innerText();
    const shortSchedule = await rowFor('BTC').locator('.perp-short .perp-funding-schedule').innerText();
    check(longSchedule.includes('+0.0200% / 8h') && longSchedule.includes('2026-10-06 10:00'), 'Funding row shows the long leg period and future settlement');
    check(shortSchedule.includes('+0.0400% / 4h') && shortSchedule.includes('2026-10-06 09:00'), 'Funding row shows the short leg period and future settlement');
    check((await rowFor('ETH').innerText()).includes('+0.0200%'), 'Funding rows are descending independently of the gross threshold');
    check(await rowFor('SOL').count() === 0 && await rowFor('ADA').count() === 0, 'Stale and missing funding are excluded despite fresh positive-spread quotes');

    const fundingMinimum = page.getByLabel('最低资金费差 / % / 8h', { exact: true });
    await fundingMinimum.fill('0.03'); await waitBases(['BTC']);
    await fundingMinimum.fill('0.07'); await waitBases([]);
    check((await page.locator('.perp-empty').innerText()).includes('当前筛选下没有正资金费差机会'), 'A funding threshold miss is not mislabeled as missing transfer qualification');
    await fundingMinimum.fill('0'); await waitBases(['BTC', 'ETH']);
    await page.getByRole('button', { name: '完成', exact: true }).click();

    await rowFor('BTC').getByRole('button', { name: /^收藏组合：BTC，/ }).click();
    const favorites = page.getByRole('button', { name: /^自选/ });
    await favorites.click(); await waitBases(['BTC']);
    await checkDirection('BTC', 'Gate', 'Binance');
    await rowFor('BTC').getByRole('button', { name: /^移除组合：BTC，/ }).click();
    await waitBases([]);
    await favorites.click(); await waitBases(['BTC', 'ETH']);

    await rowFor('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByText('行情已暂停', { exact: true }).waitFor();
    const holdingHours = page.getByLabel(/^预计持有 \/ 小时/);
    // Allow React's lazy/Suspense commit before freezing the evidence clock again.
    await page.clock.resume();
    await holdingHours.waitFor();
    now = await page.evaluate(() => Date.now()) + 100;
    await page.clock.pauseAt(new Date(now));
    check(await holdingHours.inputValue() === '24', 'Funding details default to a 24-hour holding period');
    check(Math.abs(Number(await page.getByRole('spinbutton', { name: '退出残余价差', exact: true }).inputValue()) - (99 / 103 - 1) * 100) < 1e-10, 'Funding details preserve the entry spread rather than assume convergence');
    await page.getByRole('tab', { name: '各平台报价', exact: true }).click();
    const details = page.locator('.perp-detail-row');
    const binance = details.locator('.perp-detail-scroll tbody tr').filter({ has: page.getByText('Binance', { exact: true }) });
    const gate = details.locator('.perp-detail-scroll tbody tr').filter({ has: page.getByText('Gate', { exact: true }) });
    check((await binance.locator('[data-label="资金费 / 原周期"]').innerText()).includes('每 4h'), 'Binance original settlement period is visible');
    check((await gate.locator('[data-label="资金费 / 原周期"]').innerText()).includes('每 8h'), 'Gate original settlement period is visible');
    check((await binance.locator('[data-label="下次结算"]').innerText()).includes('09:00:00'), 'Binance future settlement is shown in Beijing time');
    check((await gate.locator('[data-label="下次结算"]').innerText()).includes('10:00:00'), 'Gate future settlement is shown in Beijing time');
    await page.screenshot({ path: '.sites-runtime/perpetual-funding-details-desktop.png', fullPage: true });
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await waitBases(['BTC', 'ETH']);
    await page.screenshot({ path: '.sites-runtime/perpetual-funding-desktop.png', fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Funding ranking has no whole-page overflow at 390px');
    await checkDirection('BTC', 'Gate', 'Binance');
    await rowFor('BTC').getByRole('button', { name: /^展开 BTC，/ }).click();
    await page.getByRole('tab', { name: '各平台报价', exact: true }).click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Expanded funding details have no whole-page overflow at 390px');
    await page.screenshot({ path: '.sites-runtime/perpetual-funding-details-mobile.png', fullPage: true });
    await page.locator('.perp-inspection-bar').getByRole('button', { name: '收起并恢复', exact: true }).click();
    await page.screenshot({ path: '.sites-runtime/perpetual-funding-mobile.png', fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await grossView.click(); await waitBases(['BTC']);
    check(await sort.inputValue() === 'gross', 'Returning to spread ranking restores gross sort');
    await checkDirection('BTC', 'Binance', 'Gate');
    await filters.click();
    check(await page.getByLabel('最低毛价差 / %', { exact: true }).inputValue() === '1.5', 'Funding threshold changes preserve the independent gross threshold');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await sort.selectOption('funding'); await waitBases(['BTC', 'ETH']);
    check(await fundingView.getAttribute('aria-pressed') === 'true', 'Sort select and funding tab stay synchronized');
    check(errors.length === 0, `Unexpected page errors: ${errors.join('; ')}`);
    check(externalRequests.length === 0, `Unexpected external requests were blocked: ${externalRequests.join(', ')}`);
    return { passed: true, checks: ['opposite funding direction', '8h normalization and order', '24h cost estimate', 'independent threshold', 'missing and stale funding excluded', 'directional favorites', 'future settlements and periods', 'gross restoration', '1280px desktop and 390px mobile'], requests: Object.fromEntries(counts) };
  } finally {
    page.off('pageerror', onPageError);
    await page.clock.resume();
  }
}

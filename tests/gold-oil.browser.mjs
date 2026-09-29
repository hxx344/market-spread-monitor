// Production Next server: localhost:3189. Run with Playwright CLI run-code --filename.
// Deterministic public-market fixtures; never sends notifications or real trades.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  let now = Date.UTC(2026, 8, 30, 12), fail = false, quoteReads = 0, historyReads = 0;
  const runtime = Object.fromEntries(['oil', 'cl-xau', 'hynix', 'perpetual'].map(id => [id, { available: true, monitorId: id, enabled: true, running: true, revision: 0, error: '' }]));
  const common = () => ({ source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() });
  await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  await page.clock.install({ time: new Date(now - 1000) }); await page.clock.pauseAt(new Date(now));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/monitors') return route.fulfill({ json: { schemaVersion: 1, monitors: Object.entries(runtime).map(([id, value]) => ({ id, runtime: value })) } });
    if (path === '/api/monitors/cl-xau/runtime') {
      const input = route.request().postDataJSON(); runtime['cl-xau'] = { ...runtime['cl-xau'], enabled: input.enabled, running: input.enabled, revision: input.revision + 1 };
      return route.fulfill({ json: runtime['cl-xau'] });
    }
    if (path === '/api/monitors/cl-xau/quote') {
      quoteReads++;
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture outage' } });
      return route.fulfill({ json: { ...common(), cl: { symbol: 'CLUSDT', price: 80, updatedAt: common().fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: common().fetchedAt }, ratio: 50 } });
    }
    if (path === '/api/monitors/cl-xau/history') {
      historyReads++;
      return route.fulfill({ json: { ...common(), interval: '15m', points: Array.from({ length: 672 }, (_, index) => ({ time: Math.floor(now / 900_000) * 900_000 - (672 - index) * 900_000, cl: 80, xau: index === 660 ? null : 3900 + index / 5, ratio: index === 660 ? null : (3900 + index / 5) / 80 })) } });
    }
    return route.fulfill({ status: 503, json: { error: 'unrelated module unavailable' } });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto('http://127.0.0.1:3189/?monitor=cl-xau');
    const panel = page.getByRole('tabpanel', { name: '金油比', exact: true });
    const metric = panel.getByRole('region', { name: '金油比报价' });
    await metric.getByText('50.000', { exact: true }).waitFor();
    await page.clock.runFor(1000);
    await panel.locator('.recharts-line-curve').waitFor();
    check(await panel.getByRole('button', { name: '7 天', exact: true }).getAttribute('aria-pressed') === 'true', 'Default seven-day range');
    check((await panel.innerText()).includes('671 / 672'), 'Missing leg is counted honestly');
    await panel.getByRole('button', { name: '1 天', exact: true }).click();
    check((await panel.innerText()).includes('95 / 96'), 'One-day range uses completed periods');
    await page.screenshot({ path: 'output/playwright/gold-oil-desktop.png', fullPage: true });
    const oldReads = quoteReads, oldHistory = historyReads;
    await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
    now += 30_000; await page.clock.runFor(30_000);
    check(quoteReads === oldReads + 1 && historyReads === oldHistory, 'Visible overview keeps one quote poller while hidden chart pauses');
    await page.getByRole('tab', { name: '金油比', exact: true }).click();
    check(page.url().includes('monitor=cl-xau'), 'URL selects module');
    check(await panel.getByRole('button', { name: '1 天', exact: true }).getAttribute('aria-pressed') === 'true', 'Tab switch preserves selected range');
    fail = true; await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByText('更新中断 · 保留数据', { exact: true }).waitFor();
    check(await metric.getByText('50.000', { exact: true }).count() === 1, 'Failed refresh retains price');
    fail = false; await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await panel.getByText('实时 · 每 30 秒更新', { exact: true }).waitFor();
    const toggle = page.getByRole('switch', { name: '金油比监控开关' });
    await toggle.click(); await panel.getByText(/金油比监控已关闭/).waitFor();
    const paused = quoteReads; now += 60_000; await page.clock.runFor(60_000);
    check(quoteReads === paused, 'Disabled module stops quote reads');
    await toggle.click(); await metric.getByText('50.000', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(1000);
    await panel.locator('.recharts-line-curve').waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile fits viewport');
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'output/playwright/gold-oil-mobile.png', fullPage: true });
    return { passed: true, quoteReads, historyReads };
  } finally { await page.clock.resume(); }
}

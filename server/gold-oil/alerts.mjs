import { GOLD_OIL_STALE_MS, validateGoldOilQuote } from '../../lib/gold-oil.ts';
import { validateConfig, evaluateRule } from '../oil/config.mjs';

export const goldOilAlertDefaults = () => ({ enabled: false, rules: [] });
export const validateGoldOilAlerts = input => validateConfig(input, {
  metrics: { ratio: '金油比 XAU / CL' }, positiveMetrics: ['ratio'],
  thresholdError: '金油比阈值必须大于 0 且不超过 100 万（桶/盎司）',
});

export function goldOilAlertValues(input, now = Date.now()) {
  // Funding availability is independent of the mark-price ratio.
  const quote = validateGoldOilQuote({ ...input, funding: null });
  const at = Date.parse(quote.fetchedAt);
  if (quote.status !== 'live' || input.collection?.stale || input.collection?.error || now - at > GOLD_OIL_STALE_MS || at > now + 1000) throw Error('金油比行情已过期或不可用，暂停阈值判断');
  return { ratio: quote.ratio, xau: quote.xau.price, cl: quote.cl.price };
}

/** Called inside the common notification queue immediately before delivery. */
export function confirmGoldOilTriggers(quote, due, now = Date.now()) {
  const values = goldOilAlertValues(quote, now);
  if (due.some(({ rule }) => !evaluateRule(rule, undefined, values[rule.metric], now).shouldSend)) throw Error('金油比已离开触发阈值，取消本次告警');
}

export const goldOilAlertDefinition = {
  service: 'gold-oil-ratio-monitor', maxAgeMs: GOLD_OIL_STALE_MS, testTitle: '金油比阈值告警',
  validateConfig: validateGoldOilAlerts, marketValues: goldOilAlertValues,
  message: (market, values, due) => ['金油比阈值告警 · CL-XAU',
    `采集时间：${market.fetchedAt}（UTC）`,
    '价格口径：Binance XAUUSDT / CLUSDT 永续标记价；金油比＝XAU ÷ CL，单位桶/盎司',
    ...due.map(({ rule, value, id }) => `【${rule.label}】金油比 ${value.toFixed(4)} ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.threshold} 桶/盎司\n事件 ${id}`),
    `黄金 ${values.xau.toFixed(4)} USDT/盎司 · 原油 ${values.cl.toFixed(4)} USDT/桶`,
  ].join('\n'),
};

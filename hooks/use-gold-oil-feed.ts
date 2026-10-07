"use client";

import { useEffect, useRef, useState } from 'react';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, goldOilAction, validateGoldOilQuote, validateGoldOilHistory, type GoldOilType, type GoldOilQuote, type GoldOilHistory } from '../lib/gold-oil';
import { validateGoldOilFunding, type GoldOilFundingHistory } from '../lib/gold-oil-funding';
import type { InitialMarketData } from '../lib/initial-market';
import { startActivityPolling } from '../lib/polling';

async function request(action: string, oilType: GoldOilType, signal: AbortSignal) {
  const response = await fetch(`/api/monitors/cl-xau/${goldOilAction(action, oilType)}`, { cache: 'no-store', signal });
  if (!response.ok) throw Error('金油比行情更新失败');
  return response.json() as Promise<unknown>;
}
type MarketCache = {
  quote: GoldOilQuote | null; history: GoldOilHistory | null; funding: GoldOilFundingHistory | null;
  quoteError: boolean; historyError: boolean; fundingError: boolean;
  quoteReadAt: number; historyReadAt: number; fundingReadAt: number;
};
function initialCache(initial: InitialMarketData | null | undefined, oilType: GoldOilType): MarketCache {
  const seed = oilType === 'bz' ? initial?.['cl-xau']?.bz : initial?.['cl-xau'];
  const normalize = <T,>(value: unknown, validate: (value: unknown, oilType: GoldOilType) => T): T | null => {
    if (!value) return null;
    try { return validate(value, oilType); } catch { return null; }
  };
  const quote = normalize(seed?.quote, validateGoldOilQuote), history = normalize(seed?.history, validateGoldOilHistory), funding = normalize(seed?.funding, validateGoldOilFunding);
  const readAt = initial?.renderedAt ?? 0;
  return { quote, history, funding, quoteError: false, historyError: false, fundingError: false,
    quoteReadAt: quote ? readAt : 0, historyReadAt: history ? readAt : 0, fundingReadAt: funding ? readAt : 0 };
}
export function useGoldOilFeed(initial: InitialMarketData | null | undefined, active: boolean, summaryActive: boolean, oilType: GoldOilType = 'cl') {
  const [markets, setMarkets] = useState<Record<GoldOilType, MarketCache>>(() => ({ cl: initialCache(initial, 'cl'), bz: initialCache(initial, 'bz') }));
  const cache = useRef(markets);
  const polls = useRef<Record<string, ReturnType<typeof startActivityPolling>>>({});
  useEffect(() => {
    if (!summaryActive) return;
    const controls = polls.current, current = cache.current[oilType];
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_QUOTE_MS,
      immediate: !current.quote || current.quoteError || Date.now() - current.quoteReadAt >= GOLD_OIL_QUOTE_MS,
      load: async signal => validateGoldOilQuote(await request('quote', oilType, signal), oilType),
      onData: value => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], quote: value, quoteError: false, quoteReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], quoteError: true } }; setMarkets(cache.current); } });
    controls.quote = poll;
    return () => { delete controls.quote; poll.stop(); };
  }, [summaryActive, oilType]);
  useEffect(() => {
    if (!active) return;
    const controls = polls.current, current = cache.current[oilType];
    const history = startActivityPolling({ intervalMs: GOLD_OIL_HISTORY_MS, timeoutMs: 60_000,
      immediate: !current.history || current.historyError || Date.now() - current.historyReadAt >= GOLD_OIL_HISTORY_MS,
      load: async signal => validateGoldOilHistory(await request('history', oilType, signal), oilType),
      onData: value => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], history: value, historyError: false, historyReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], historyError: true } }; setMarkets(cache.current); } });
    const funding = startActivityPolling({ intervalMs: GOLD_OIL_FUNDING_MS, timeoutMs: 60_000,
      immediate: !current.funding || current.fundingError || Date.now() - current.fundingReadAt >= GOLD_OIL_FUNDING_MS,
      load: async signal => validateGoldOilFunding(await request('funding', oilType, signal), oilType),
      onData: value => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], funding: value, fundingError: false, fundingReadAt: Date.now() } }; setMarkets(cache.current); },
      onError: () => { cache.current = { ...cache.current, [oilType]: { ...cache.current[oilType], fundingError: true } }; setMarkets(cache.current); } });
    controls.history = history; controls.funding = funding;
    return () => { delete controls.history; delete controls.funding; history.stop(); funding.stop(); };
  }, [active, oilType]);
  // Select during render; an effect-driven reset can briefly expose the other oil's data.
  return { ...markets[oilType], refresh: () => { for (const poll of Object.values(polls.current)) void poll.refresh(); } };
}

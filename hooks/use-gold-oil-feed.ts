"use client";

import { useEffect, useRef, useState } from 'react';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, validateGoldOilQuote, validateGoldOilHistory, type GoldOilQuote, type GoldOilHistory } from '../lib/gold-oil';
import { validateGoldOilFunding, type GoldOilFundingHistory } from '../lib/gold-oil-funding';
import type { InitialMarketData } from '../lib/initial-market';
import { startActivityPolling } from '../lib/polling';

async function request(action: string, signal: AbortSignal) {
  const response = await fetch(`/api/monitors/cl-xau/${action}`, { cache: 'no-store', signal });
  if (!response.ok) throw Error('金油比行情更新失败');
  return response.json() as Promise<unknown>;
}
export function useGoldOilFeed(initial: InitialMarketData | null | undefined, active: boolean, summaryActive: boolean) {
  const [quote, setQuote] = useState<GoldOilQuote | null>(initial?.['cl-xau']?.quote ?? null);
  const [history, setHistory] = useState<GoldOilHistory | null>(initial?.['cl-xau']?.history ?? null);
  const [funding, setFunding] = useState<GoldOilFundingHistory | null>(initial?.['cl-xau']?.funding ?? null);
  const [quoteError, setQuoteError] = useState(false), [historyError, setHistoryError] = useState(false), [fundingError, setFundingError] = useState(false);
  const polls = useRef<Record<string, ReturnType<typeof startActivityPolling>>>({});
  const hydrated = useRef({ history: Boolean(initial?.['cl-xau']?.history), funding: Boolean(initial?.['cl-xau']?.funding), readAt: initial?.renderedAt ?? 0 });
  const activated = useRef(false);
  useEffect(() => {
    if (!summaryActive) return;
    const controls = polls.current;
    const poll = startActivityPolling({ intervalMs: GOLD_OIL_QUOTE_MS,
      load: async signal => validateGoldOilQuote(await request('quote', signal)),
      onData: value => { setQuote(value); setQuoteError(false); }, onError: () => setQuoteError(true) });
    controls.quote = poll;
    return () => { delete controls.quote; poll.stop(); };
  }, [summaryActive]);
  useEffect(() => {
    if (!active) return;
    const controls = polls.current;
    const history = startActivityPolling({ intervalMs: GOLD_OIL_HISTORY_MS, timeoutMs: 60_000,
      immediate: activated.current || !hydrated.current.history || Date.now() - hydrated.current.readAt >= GOLD_OIL_HISTORY_MS,
      load: async signal => validateGoldOilHistory(await request('history', signal)),
      onData: value => { setHistory(value); setHistoryError(false); }, onError: () => setHistoryError(true) });
    const funding = startActivityPolling({ intervalMs: GOLD_OIL_FUNDING_MS, timeoutMs: 60_000,
      immediate: activated.current || !hydrated.current.funding || Date.now() - hydrated.current.readAt >= GOLD_OIL_FUNDING_MS,
      load: async signal => validateGoldOilFunding(await request('funding', signal)),
      onData: value => { setFunding(value); setFundingError(false); }, onError: () => setFundingError(true) });
    controls.history = history; controls.funding = funding;
    activated.current = true;
    return () => { delete controls.history; delete controls.funding; history.stop(); funding.stop(); };
  }, [active]);
  return { quote, history, funding, quoteError, historyError, fundingError, refresh: () => { for (const poll of Object.values(polls.current)) void poll.refresh(); } };
}

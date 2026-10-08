"use client";

import { useEffect, useRef, useState } from 'react';
import { startPerpetualScannerDataFeed } from '../lib/perpetual-scanner-data-feed';
import { scannerDataRequirementsKey, scannerDataSelectionKey, type PerpetualScannerDataReport, type ScannerDataPair, type ScannerDataRequirements } from '../lib/perpetual-scanner-data';

export function usePerpetualScannerData(pairs: ScannerDataPair[], requirements: ScannerDataRequirements, active: boolean) {
  const [report, setReport] = useState<PerpetualScannerDataReport | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualScannerDataFeed> | null>(null);
  const selectionKey = scannerDataSelectionKey(pairs), requirementsKey = scannerDataRequirementsKey(requirements);
  useEffect(() => {
    const feed = startPerpetualScannerDataFeed({
      load: async (request, signal) => {
        const response = await fetch('/api/monitors/perpetual/scanner-data', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
        if (!response.ok) throw Error('筛选数据读取失败');
        return await response.json() as PerpetualScannerDataReport;
      },
      onData: setReport, onLoading: setLoading, onError: setError,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => { controls.current?.setSelection(JSON.parse(selectionKey) as ScannerDataPair[], JSON.parse(requirementsKey) as ScannerDataRequirements); }, [selectionKey, requirementsKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(active && !document.hidden && navigator.onLine);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) { controls.current?.setActive(false); synchronize(); } };
    synchronize();
    document.addEventListener('visibilitychange', synchronize); window.addEventListener('online', synchronize); window.addEventListener('offline', synchronize); window.addEventListener('pageshow', restore);
    return () => {
      controls.current?.setActive(false);
      document.removeEventListener('visibilitychange', synchronize); window.removeEventListener('online', synchronize); window.removeEventListener('offline', synchronize); window.removeEventListener('pageshow', restore);
    };
  }, [active]);
  return { report, loading, error: [error, report?.storageError].filter(Boolean).join(' ') };
}

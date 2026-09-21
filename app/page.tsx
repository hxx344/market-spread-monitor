import MonitorHub from "./monitor-hub";
import { readInitialMarket } from "../lib/server-initial-market";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [initial, query] = await Promise.all([readInitialMarket(), searchParams]);
  const initialMonitor = query.monitor === "perpetual" || query.monitor === "hynix" ? query.monitor : "oil";
  return <>{initialMonitor === "oil" ? <><link rel="preload" href="/oil/panel.html" as="fetch" crossOrigin="anonymous"/><link rel="preload" href="/oil/styles.css" as="fetch" crossOrigin="anonymous"/></> : null}<MonitorHub initial={initial} initialMonitor={initialMonitor}/></>;
}

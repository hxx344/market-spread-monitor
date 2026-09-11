import MonitorHub from "./monitor-hub";
import { readInitialMarket } from "../lib/server-initial-market";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initial = await readInitialMarket();
  return <><link rel="preload" href="/oil/panel.html" as="fetch" crossOrigin="anonymous"/><link rel="preload" href="/oil/styles.css" as="fetch" crossOrigin="anonymous"/><MonitorHub initial={initial}/></>;
}

/** Public, versioned descriptors. Credentials and backend instances never belong here. */
export interface MonitorDefinition {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  accent: string;
  quoteIntervalMs: number;
  capabilities: readonly string[];
}

export const monitors: readonly MonitorDefinition[] = [
  { id: "oil", title: "原油价差", subtitle: "BRENT / WTI", category: "能源", accent: "#12836b", quoteIntervalMs: 60_000, capabilities: ["quote", "history", "candles/15m", "funding", "alerts"] },
  { id: "hynix", title: "海力士 ADR", subtitle: "SKHY / SKHX", category: "半导体", accent: "#316bdd", quoteIntervalMs: 10_000, capabilities: ["quote", "history", "funding", "indicators", "alerts"] },
  { id: "perpetual", title: "合约价差", subtitle: "CEX / DEX", category: "永续合约", accent: "#8dbbff", quoteIntervalMs: 1_000, capabilities: ["quote"] },
];

export function getMonitor(id: string) { return monitors.find(monitor => monitor.id === id); }

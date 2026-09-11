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
  { id: "oil", title: "原油价差", subtitle: "BRENT / WTI", category: "能源", accent: "#12836b", quoteIntervalMs: 60_000, capabilities: ["quote", "history", "funding", "alerts"] },
  { id: "hynix", title: "海力士 ADR", subtitle: "SKHY / SKHX", category: "半导体", accent: "#316bdd", quoteIntervalMs: 10_000, capabilities: ["quote", "history", "indicators", "alerts"] },
];

export function getMonitor(id: string) { return monitors.find(monitor => monitor.id === id); }

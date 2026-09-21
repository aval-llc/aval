/** Capability and ingestion state for the existing Operations dashboard. */
export type DataState = "preview" | "syncing" | "empty" | "live";
export type DashboardCapability = "property.read" | "unit.read" | "lease.read" | "lead.read" | "work.read" | "ledger.read" | "accounting.read" | "message.read";
export type DashboardDomain = "property" | "occupancy" | "leasing" | "maintenance" | "rent" | "collections" | "accounting" | "communications";
export interface DashboardConnection { provider: string; status: string; lastSyncAt: Date | string | null }

export const DASHBOARD_DOMAINS: Record<DashboardDomain, { required: readonly DashboardCapability[]; cta: "property" | "leasing" | "inbox" | "accounting" }> = {
  property: { required: ["property.read"], cta: "property" },
  occupancy: { required: ["unit.read", "lease.read"], cta: "property" },
  leasing: { required: ["lead.read", "lease.read"], cta: "leasing" },
  maintenance: { required: ["work.read"], cta: "property" },
  rent: { required: ["unit.read", "lease.read"], cta: "leasing" },
  collections: { required: ["ledger.read"], cta: "accounting" },
  accounting: { required: ["accounting.read"], cta: "accounting" },
  communications: { required: ["message.read"], cta: "inbox" },
};

// Only implemented ingestion paths grant reporting capabilities. A verified
// connection to an unimplemented importer must not make empty data look real.
export const PROVIDER_DASHBOARD_CAPABILITIES: Readonly<Record<string, readonly DashboardCapability[]>> = {
  buildium: ["property.read", "unit.read", "lease.read", "work.read"],
  quickbooks: ["accounting.read"],
  gmail: ["message.read"],
  outlook: ["message.read"],
  whatsapp: ["message.read"],
  telegram: ["message.read"],
  twilio: ["message.read"],
  slack: ["message.read"],
};
const IMPORT_PROVIDERS = new Set(["buildium", "quickbooks"]);

export function resolveDashboardState(
  domain: DashboardDomain,
  connections: readonly DashboardConnection[],
  nativeCapabilities: readonly DashboardCapability[],
  hasResult: boolean,
): DataState {
  const required = DASHBOARD_DOMAINS[domain].required;
  const native = new Set(nativeCapabilities);
  const connected = connections.filter((row) => row.status === "connected");
  const providersFor = (capability: DashboardCapability) => connected.filter((row) => PROVIDER_DASHBOARD_CAPABILITIES[row.provider]?.includes(capability));
  if (required.some((capability) => !native.has(capability) && !providersFor(capability).length)) return "preview";
  if (required.some((capability) => !native.has(capability) && providersFor(capability).every((row) => IMPORT_PROVIDERS.has(row.provider) && !row.lastSyncAt))) return "syncing";
  return hasResult ? "live" : "empty";
}

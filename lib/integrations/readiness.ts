import { getProvider, MODEL_PROVIDER_IDS } from "./catalog";
import { adapterBlocker } from "@/lib/pms/derive.ts";

export function connectionBlocker(provider: string): string | null {
  return getProvider(provider)?.setupBlocker ?? adapterBlocker(provider);
}
// QuickBooks imports have a durable worker; other providers verify access only.
export function integrationReadiness(provider: string) {
  const configured = getProvider(provider);
  const blocker = connectionBlocker(provider);
  return { status: !configured || blocker ? "unavailable" : "credentials_required", blocker, verification: Boolean(configured && !blocker), sync: provider === "quickbooks" || provider === "buildium", model: Boolean(configured && MODEL_PROVIDER_IDS.has(configured.id)), liveValidated: false };
}

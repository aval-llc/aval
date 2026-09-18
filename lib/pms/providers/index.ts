/**
 * The authoritative provider registry.
 *
 * `lib/integrations/catalog.ts` remains the *connection* catalog — auth modes,
 * credential fields, categories, the things the connect UI needs. What a
 * provider can and may do now lives here and only here, and the catalog derives
 * from it (see `lib/pms/derive.ts`). Before this file there were four places
 * that answered "can this provider be written to": `readOnly`, `setupBlocker`,
 * `EXISTING_BLOCKERS` in readiness.ts, and the absence of an adapter. None of
 * them were enforced.
 */

import type { PmsAction, ProviderDescriptor } from "../types.ts";
import { appfolio } from "./appfolio.ts";
import { buildium } from "./buildium.ts";
import { doorloop } from "./doorloop.ts";
import { entrata } from "./entrata.ts";
import { genericEmail } from "./generic-email.ts";
import { realpage } from "./realpage.ts";
import { rentmanager } from "./rentmanager.ts";
import { rentvine } from "./rentvine.ts";
import { yardi } from "./yardi.ts";
import { integrationCatalog } from "../../integrations/catalog.ts";
import { derivedPmsDescriptors } from "./unassessed.ts";

/**
 * Researched descriptors — someone read these providers' terms.
 */
const HAND_WRITTEN: readonly ProviderDescriptor[] = [
  appfolio,
  buildium,
  doorloop,
  entrata,
  realpage,
  rentmanager,
  rentvine,
  yardi,
  genericEmail,
];

/**
 * Every PMS in the catalog, described. The derived entries claim only what is
 * true of any mail-capable system (see ./unassessed.ts) — they never assert a
 * permission nobody verified.
 */
export const PMS_PROVIDERS: readonly ProviderDescriptor[] = [
  ...HAND_WRITTEN,
  ...derivedPmsDescriptors(integrationCatalog),
];

const BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
  PMS_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Unknown providers return undefined and every caller treats that as
 * `unavailable`. A PMS we have not described is not a PMS we may write to.
 */
export function pmsProvider(id: string): ProviderDescriptor | undefined {
  return BY_ID.get(id);
}

export function isPmsProvider(id: string): boolean {
  return BY_ID.has(id);
}

/** True when this provider has no surface for the action at all. */
export function actionUnsupported(descriptor: ProviderDescriptor, action: PmsAction): boolean {
  return descriptor.unsupportedActions?.includes(action) ?? false;
}

export { appfolio, buildium, doorloop, entrata, genericEmail, realpage, rentmanager, rentvine, yardi };

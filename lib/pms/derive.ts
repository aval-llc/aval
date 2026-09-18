/**
 * The catalog's derived view of the descriptors.
 *
 * Before this file, four places answered "can this provider be written to":
 * `IntegrationProvider.readOnly`, `IntegrationProvider.setupBlocker`,
 * `EXISTING_BLOCKERS` in readiness.ts, and the absence of an adapter. None of
 * them were enforced, and all seven PMS providers carried `readOnly: true` that
 * nothing read. The brief's instruction was to make the descriptors
 * authoritative and derive or delete the rest; this is the derivation.
 *
 * `readOnly` is now absent from PMS catalog entries, so TypeScript forces every
 * caller through `providerIsReadOnly`, which consults the descriptor.
 */

import { pmsProvider } from "./providers/index.ts";

/**
 * Adapter-level blockers: whether Aval can establish this provider's
 * *credentialed* connection at all.
 *
 * Deliberately distinct from write capability. AppFolio's write is blocked by
 * its terms (the descriptor says so); its Stack API connection is blocked by a
 * partnership Aval does not hold. Those are different sentences and a customer
 * can be affected by one and not the other — notification capture through the
 * seat needs neither.
 *
 * Folded in from `lib/integrations/readiness.ts`, which is now a thin caller.
 */
const ADAPTER_BLOCKERS: Readonly<Record<string, string>> = {
  reapit:
    "Reapit customer installation and approved app permissions are required. Account verification and the data adapter still need sandbox validation.",
  arthur: "Arthur entity selection and its account-specific read contract still need implementation and sandbox validation.",
  appfolio:
    "AppFolio Stack product approval and the contracted API specification are required to implement and certify this adapter. Notification capture through the Aval seat does not depend on this.",
  yardi:
    "Obtain the approved Voyager interface specification, licensing and sandbox. The adapter still needs implementation against that contract.",
  realpage: "RealPage Exchange partner access, endpoint documentation and a sandbox are required to finish the adapter.",
  entrata: "Obtain the Entrata API agreement, tenant endpoint and IP allowlisting. This adapter is not implemented yet.",
  rentmanager: "Rent Manager partner API documentation and a sandbox are required to finish the adapter.",
  rentvine: "Rentvine's public API adapter still needs implementation and sandbox validation.",
  contpaqi: "Choose the CONTPAQi API product and obtain its authentication contract. This adapter is not implemented yet.",
  alegra:
    "The existing single-key setup is insufficient for Alegra authentication. This adapter still needs the account email/token flow and mapping.",
  doorloop: "DoorLoop credential storage exists, but its data adapter still needs implementation and sandbox validation.",
  whatsapp_personal:
    "A personal WhatsApp linked-device runtime is not implemented. Use WhatsApp Business for the official supported API connection.",
  apple_messages:
    "Apple Messages for Business requires an approved MSP and its specific send/webhook contract. The MSP adapter is not implemented yet.",
};

export function adapterBlocker(providerId: string): string | null {
  return ADAPTER_BLOCKERS[providerId] ?? null;
}

/**
 * Whether this provider is read-only *as a matter of capability and terms*.
 *
 * For a described PMS this is computed, never stored: a provider is read-only
 * exactly when no write mechanism exists or its terms forbid using one. That is
 * the fact `readOnly: true` was asserting by hand, on seven providers, wrongly
 * in at least two cases.
 *
 * Non-PMS providers keep their catalog value; those are accounting, messaging
 * and model connections whose write posture this layer does not describe.
 */
export function providerIsReadOnly(providerId: string, catalogValue?: boolean): boolean {
  const descriptor = pmsProvider(providerId);
  if (descriptor) return !descriptor.write.supported || !descriptor.write.permitted;
  // Unknown or undescribed defaults to read-only. Unknown defaults to no.
  return catalogValue ?? true;
}

/**
 * Operator-facing reason writes are unavailable, or null when they are not
 * blocked by capability or terms. Never explains an *enablement* gap — that is
 * per-org and comes from `resolveCapability`.
 */
export function providerWriteBlocker(providerId: string): string | null {
  const descriptor = pmsProvider(providerId);
  if (!descriptor) return null;
  if (!descriptor.write.supported) {
    return descriptor.write.reason ?? `${descriptor.displayName} has no write surface.`;
  }
  if (!descriptor.write.permitted) {
    return descriptor.write.reason ?? `${descriptor.displayName}'s terms do not permit automated writes.`;
  }
  return null;
}

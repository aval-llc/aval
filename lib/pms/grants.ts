/**
 * Grant discovery (docs/PMS_INTEGRATION.md, P0.2).
 *
 * A provider descriptor is static: it says what AppFolio is. A *grant* is not —
 * it is what this particular customer's PMS role or API key actually hands us,
 * and two AppFolio customers on the same plan can differ.
 *
 * The rule this file exists to enforce: **discovery reports facts and never
 * enables anything.** Finding that a seat can create work orders yields
 * `available: true, enabled: false` and a settings line reading "writes are
 * technically available here — enabling requires authorization". A config
 * inference must never be the thing that puts a customer in breach of their own
 * PMS contract.
 *
 * Grants live in `integration_connections.metadataJson` rather than a new table
 * because they are already keyed exactly right: that table has a unique index on
 * (organizationId, provider), which is the grain of a grant.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationConnections } from "@/db/schema";
import { type GrantSet, type PmsAction } from "./types.ts";
import { pmsProvider } from "./providers/index.ts";

const EMPTY: GrantSet = { available: [], probedAt: null, probed: false };

/** Grants older than this are re-probed. A PMS role can be narrowed at any time. */
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

function parseMetadata(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function grantsFromMetadata(json: string): GrantSet {
  const stored = parseMetadata(json).pmsGrants;
  if (!stored || typeof stored !== "object") return EMPTY;
  const record = stored as Record<string, unknown>;
  const available = Array.isArray(record.available)
    ? record.available.filter((value): value is PmsAction => typeof value === "string")
    : [];
  return {
    available,
    probedAt: typeof record.probedAt === "string" ? record.probedAt : null,
    probed: record.probed === true,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

export function grantsAreStale(grants: GrantSet, now = Date.now()): boolean {
  if (!grants.probed || !grants.probedAt) return true;
  const at = Date.parse(grants.probedAt);
  return Number.isNaN(at) || now - at > GRANT_TTL_MS;
}

export type { GrantSet };

export async function readGrants(organizationId: string, providerId: string): Promise<GrantSet> {
  const db = getDb();
  const [connection] = await db
    .select({ metadataJson: integrationConnections.metadataJson })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, providerId)))
    .limit(1);
  return connection ? grantsFromMetadata(connection.metadataJson) : EMPTY;
}

/**
 * The probe itself.
 *
 * Two hard constraints, both from the brief:
 *
 *  1. **Probe with the least destructive operation available.** Never probe by
 *     attempting a real write. For an API provider that means reading the
 *     credential's own scope or permission endpoint; for a `ui` provider it
 *     means observing which navigation targets the seat's session can reach,
 *     not submitting a form to see whether it succeeds.
 *  2. **Never enable.** This returns a GrantSet and writes it to metadata. It
 *     touches no authorization row and no settings row, and there is no code
 *     path from here to one.
 *
 * Adapters are registered per provider as they are implemented. An unregistered
 * provider yields an un-probed GrantSet, which resolves to `blocked` with a
 * remediation naming what is needed — not to `allow`, and not to a silent pass.
 */
export type GrantProbe = (organizationId: string, providerId: string) => Promise<Omit<GrantSet, "probedAt" | "probed">>;

const PROBES = new Map<string, GrantProbe>();

export function registerGrantProbe(providerId: string, probe: GrantProbe): void {
  PROBES.set(providerId, probe);
}

export function hasGrantProbe(providerId: string): boolean {
  return PROBES.has(providerId);
}

export async function discoverGrants(organizationId: string, providerId: string): Promise<GrantSet> {
  const descriptor = pmsProvider(providerId);
  if (!descriptor) return { ...EMPTY, error: `No provider descriptor for "${providerId}".` };

  const probe = PROBES.get(providerId);
  if (!probe) {
    return { ...EMPTY, error: `Grant discovery for ${descriptor.displayName} is not implemented yet.` };
  }

  let result: Omit<GrantSet, "probedAt" | "probed">;
  try {
    result = await probe(organizationId, providerId);
  } catch (error) {
    // A failed probe must not look like a probe that found nothing permitted:
    // `probed: false` keeps the resolver in "unknown" rather than "denied", so
    // a transient outage does not silently read as a narrowed PMS role.
    return { ...EMPTY, error: error instanceof Error ? error.message : "Grant discovery failed." };
  }

  const grants: GrantSet = { ...result, probedAt: new Date().toISOString(), probed: true };
  await persistGrants(organizationId, providerId, grants);
  return grants;
}

async function persistGrants(organizationId: string, providerId: string, grants: GrantSet): Promise<void> {
  const db = getDb();
  const [connection] = await db
    .select({ metadataJson: integrationConnections.metadataJson })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, providerId)))
    .limit(1);
  if (!connection) return;

  const metadata = parseMetadata(connection.metadataJson);
  metadata.pmsGrants = grants;
  await db
    .update(integrationConnections)
    .set({ metadataJson: JSON.stringify(metadata), updatedAt: new Date() })
    .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, providerId)));
}

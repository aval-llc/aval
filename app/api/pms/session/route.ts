/**
 * GET/POST /api/pms/session — connecting a PMS by signing into it yourself.
 *
 * Every other connection in Aval is made by handing over a secret: an API key,
 * an OAuth grant, a bot token. This one is made by the customer signing into
 * their own PMS, on their own computer, and Aval operating inside the session
 * they established. There is nothing to collect, which is why this route exists
 * separately from `/api/integrations/connect` rather than as a branch inside
 * it — that path is built around credentials and refuses a connection without
 * them, and bending it would have put a password field on a screen that must
 * never have one.
 *
 * Three things this route will not do, each deliberate:
 *
 *   - **It does not take credentials.** Not optionally, not for "convenience".
 *     No field, no ciphertext column written, nothing to leak.
 *   - **It does not grant anything.** Capabilities reported by the device are
 *     recorded as *discovered*, which is a fact about what that login can
 *     reach. Authorizing any of them is a separate, signed act in the
 *     capability matrix. A customer clicking "connect" must never thereby be
 *     in breach of their own PMS contract.
 *   - **It does not believe the device about what a provider supports.** The
 *     reported list is intersected with the provider descriptor, so a
 *     compromised or simply out-of-date runner cannot widen the envelope by
 *     claiming a capability the provider has no path for.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { roleFor } from "@/lib/organizations/membership";
import { canManagePolicy } from "@/lib/organizations/roles";
import { withApiSession } from "@/lib/api/with-session";
import { pmsProvider } from "@/lib/pms/providers/index.ts";
import { PMS_ACTIONS, type PmsAction } from "@/lib/pms/types.ts";
import { readGrants } from "@/lib/pms/grants.ts";
import { readAllEnablements } from "@/lib/pms/enablement.ts";
import { CERTIFICATIONS, listWorkflows } from "@/lib/pms/flows.ts";
import {
  readConnectionHealth,
  recordConnectionHealth,
  stateForSession,
  type ConnectionState,
} from "@/lib/pms/browser/health.ts";
import type { ProviderSessionState } from "@/lib/pms/browser/adapter.ts";

const ALL_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat();

const SESSION_STATES: readonly ProviderSessionState[] = [
  "NEW", "AUTHENTICATING", "ACTIVE", "EXPIRED", "MFA_REQUIRED",
  "PERMISSION_DENIED", "PROVIDER_CHANGED", "BLOCKED",
];

/** Only a provider whose writes run on the customer's own machine. */
function desktopProvider(providerId: unknown) {
  if (typeof providerId !== "string") return null;
  const descriptor = pmsProvider(providerId);
  if (!descriptor) return null;
  return descriptor.write.runner === "desktop" ? descriptor : null;
}

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const providerId = new URL(request.url).searchParams.get("provider") ?? "";
  const descriptor = desktopProvider(providerId);
  if (!descriptor) return Response.json({ error: "Not a customer-authorized provider" }, { status: 404 });

  await ensureOrganization(dbSession, identity);
  const [connection] = await dbSession.db
    .select({ status: integrationConnections.status, authMode: integrationConnections.authMode })
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.organizationId, identity.organizationId),
      eq(integrationConnections.provider, providerId),
    ))
    .limit(1);

  const [health, grants, enablements, workflows] = await Promise.all([
    readConnectionHealth(dbSession, identity.organizationId, providerId),
    readGrants(dbSession, identity.organizationId, providerId),
    readAllEnablements(dbSession, identity.organizationId),
    listWorkflows(dbSession, identity.organizationId, providerId),
  ]);
  const role = await roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null);
  const active = workflows.filter((flow) => flow.status === "active");

  return Response.json({
    provider: providerId,
    displayName: descriptor.displayName,
    connected: Boolean(connection),
    accessMode: connection?.authMode ?? "customer_desktop_session",
    session: health,
    // Named `discovered` rather than `granted` on the wire too, because the
    // difference is the whole point and a field called `capabilities` invites
    // a reader to treat it as permission.
    discovered: grants.available,
    discoveredAt: grants.probedAt,
    /**
     * Four separate numbers, because "Connected" on its own is misleading.
     *
     * A session can be perfectly healthy while nothing can execute: the login
     * reaches six things, the workspace authorized three, and Aval has a
     * working workflow for two of them. The smallest of those is what the
     * employee can actually do, and collapsing them into one green word is how
     * a customer comes to believe Aval is doing something it cannot.
     */
    support: {
      discovered: grants.available.length,
      granted: grants.available.filter((action) =>
        enablements.get(`${providerId}:${action}`)?.enabled === true).length,
      workflows: active.length,
      // The *lowest* certification among the workflows that can actually run.
      // A connection is only as proven as its weakest live path, and showing
      // the highest would let one well-tested workflow vouch for the rest.
      certification: active.length === 0
        ? "unimplemented"
        : active.map((flow) => flow.certification)
          .sort((a, b) => CERTIFICATIONS.indexOf(a) - CERTIFICATIONS.indexOf(b))[0],
      /** Actions the workspace authorized that no active workflow can perform. */
      unsupported: grants.available.filter((action) =>
        enablements.get(`${providerId}:${action}`)?.enabled === true
        && !active.some((flow) => flow.action === action)),
    },
    canEdit: Boolean(role && canManagePolicy(role)) && !isGuestIdentity(identity),
  });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) {
    return Response.json({ error: "A guest session cannot connect a provider" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const descriptor = desktopProvider(body.provider);
  if (!descriptor) return Response.json({ error: "Not a customer-authorized provider" }, { status: 404 });
  const providerId = String(body.provider);

  await ensureOrganization(dbSession, identity);
  const role = await roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null);
  if (!role || !canManagePolicy(role)) {
    return Response.json({ error: "Only the workspace owner can connect a provider" }, { status: 403 });
  }

  const session = SESSION_STATES.includes(body.session as ProviderSessionState)
    ? (body.session as ProviderSessionState)
    : null;
  if (!session) return Response.json({ error: "A known provider session state is required" }, { status: 422 });
  const state: ConnectionState = stateForSession(session);

  // What the device says it can reach, bounded by what the provider actually
  // has a path for. Discovery is a fact, and a fact about a capability the
  // provider does not offer is not one.
  const reported = Array.isArray(body.discovered) ? body.discovered : [];
  const discovered = ALL_ACTIONS.filter((action) =>
    reported.includes(action) && (descriptor.write.supported || action.endsWith(".read")));

  const now = new Date();
  const [existing] = await dbSession.db
    .select({ id: integrationConnections.id, metadataJson: integrationConnections.metadataJson })
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.organizationId, identity.organizationId),
      eq(integrationConnections.provider, providerId),
    ))
    .limit(1);

  let metadata: Record<string, unknown> = {};
  if (existing) {
    try {
      const held = JSON.parse(existing.metadataJson);
      if (held && typeof held === "object") metadata = held as Record<string, unknown>;
    } catch { /* A metadata blob that will not parse is replaced, not merged. */ }
  }
  metadata.pmsGrants = {
    available: discovered,
    probed: state === "CONNECTED",
    probedAt: state === "CONNECTED" ? now.toISOString() : null,
  };

  const values = {
    // `connected` describes the connection, not the session. A laptop that is
    // closed has not disconnected the PMS, and the session state is where the
    // difference is recorded.
    status: "connected" as const,
    authMode: "customer_desktop_session",
    scopesJson: JSON.stringify(descriptor.read.mechanisms),
    metadataJson: JSON.stringify(metadata),
    updatedAt: now,
  };

  if (existing) {
    await dbSession.db.update(integrationConnections).set(values)
      .where(eq(integrationConnections.id, existing.id));
  } else {
    await dbSession.db.insert(integrationConnections).values({
      id: crypto.randomUUID(),
      organizationId: identity.organizationId,
      provider: providerId,
      category: "property",
      createdBy: identity.userId,
      createdAt: now,
      ...values,
    });
  }

  await recordConnectionHealth(dbSession, identity.organizationId, providerId, {
    state,
    runnerId: typeof body.runner === "string" ? body.runner.slice(0, 64) : undefined,
    verified: state === "CONNECTED",
  });

  return Response.json({
    provider: providerId,
    session: await readConnectionHealth(dbSession, identity.organizationId, providerId),
    discovered,
    // Said plainly on the wire so a client cannot render this as "enabled".
    note: "Discovered capabilities are not permissions. Enable each action you want Aval to use.",
  });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

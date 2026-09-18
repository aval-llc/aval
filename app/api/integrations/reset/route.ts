import { withApiSession } from "@/lib/api/with-session";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections, integrationSyncState, organizations } from "@/db/postgres/schema";
import { getProvider } from "@/lib/integrations/catalog";
import { getApiIdentity } from "@/lib/integrations/session";

/**
 * POST /api/integrations/reset
 * Disconnects a provider: clears its stored credentials and, if it was the
 * org's active model provider, pauses model-backed features. Mirrors
 * mentari2.0's per-provider "Reset" action.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can disconnect providers" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  const provider = getProvider(body && typeof body === "object" && "provider" in body && typeof body.provider === "string" ? body.provider : "");
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const db = dbSession.db;
  const now = new Date();
  const [connection] = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, provider.id))).limit(1);
  if (connection) {
    // Retain the connection ID and source account for imported ledger provenance.
    // Clearing credentials also invalidates any import or validation in flight.
    await db.update(integrationConnections).set({ status: "disconnected", accessTokenCiphertext: null, refreshTokenCiphertext: null, expiresAt: null, metadataJson: "{}", updatedAt: now }).where(eq(integrationConnections.id, connection.id));
    await db.update(integrationSyncState).set({ enabled: false, updatedAt: now }).where(eq(integrationSyncState.connectionId, connection.id));
  }

  const [org] = await db.select({ activeModelProvider: organizations.activeModelProvider }).from(organizations).where(eq(organizations.id, identity.organizationId)).limit(1);
  if (org?.activeModelProvider === provider.id) {
    await db.update(organizations).set({ activeModelProvider: null, updatedAt: now }).where(eq(organizations.id, identity.organizationId));
  }

  return Response.json({ provider: provider.id, status: "disconnected" });
}

export const POST = withApiSession(POSTWithSession);

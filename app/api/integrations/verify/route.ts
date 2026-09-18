import { withApiSession } from "@/lib/api/with-session";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { verifyCredentials } from "@/lib/integrations/credential-verification";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { decryptSecret } from "@/lib/integrations/crypto";
import { getApiIdentity } from "@/lib/integrations/session";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can manage connections" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { connectionId?: string };
  if (!body || typeof body.connectionId !== "string" || !body.connectionId) return Response.json({ error: "Connection ID is required" }, { status: 400 });
  const db = dbSession.db;
  const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, body.connectionId), eq(integrationConnections.organizationId, identity.organizationId))).limit(1);
  if (!connection?.accessTokenCiphertext) return Response.json({ error: "Encrypted credentials were not found" }, { status: 404 });
  const blocker = connectionBlocker(connection.provider);
  if (blocker) return Response.json({ error: blocker, code: "adapter_unavailable" }, { status: 409 });
  if (connection.authMode === "oauth2" || connection.authMode === "oauth_subscription_paste") return Response.json({ error: "Reconnect this account through its authorization flow" }, { status: 409 });
  const encryptionKey = (env as unknown as Record<string, string | undefined>).INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 500 });
  try {
    const credentials = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, encryptionKey)) as Record<string, string>;
    const verified = await dbSession.outsideTransaction(() => verifyCredentials(connection.provider, credentials, request, connection.id));
    const now = new Date();
    const saved = await db.update(integrationConnections).set({ status: "connected", externalAccountId: verified.accountId, externalAccountName: verified.accountName, metadataJson: JSON.stringify({ ...JSON.parse(connection.metadataJson), ...verified.metadata, verifiedAt: now.toISOString() }), updatedAt: now }).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.accessTokenCiphertext, connection.accessTokenCiphertext))).returning({ id: integrationConnections.id });
    if (!saved.length) return Response.json({ error: "Connection changed during verification. Retry with the current credentials." }, { status: 409 });
    return Response.json({ connection: { id: connection.id, provider: connection.provider, status: "connected", externalAccountName: verified.accountName } });
  } catch (error) {
    await db.update(integrationConnections).set({ status: "verification_failed", updatedAt: new Date() }).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.accessTokenCiphertext, connection.accessTokenCiphertext)));
    return Response.json({ error: error instanceof Error ? error.message : "Provider verification failed" }, { status: 422 });
  }
}

export const POST = withApiSession(POSTWithSession);

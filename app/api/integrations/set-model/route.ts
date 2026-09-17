import { withApiSession } from "@/lib/api/with-session";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { REASONING_EFFORT_LEVELS, isModelProviderId } from "@/lib/integrations/model-providers";
import { isSubscriptionProviderId } from "@/lib/integrations/subscription-oauth";
import { getApiIdentity } from "@/lib/integrations/session";
import { PILOT_POLICY, subscriptionDisabledResponse } from "@/lib/pilot-policy";

const bindings = () => env as unknown as Record<string, string | undefined>;

/**
 * POST /api/integrations/set-model { provider, model }
 * Updates only the model override on an already-connected provider —
 * separate from /connect because the API-key connect flow re-encrypts a
 * whole fresh credentials blob, and the caller doesn't (and shouldn't)
 * hold the plaintext key/token again just to change which model it calls.
 * Subscription providers (Claude/ChatGPT) store a bare access-token
 * string, not a JSON blob, so their override is tracked in `metadataJson`
 * instead of being spliced into the ciphertext.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the owner can configure model connections" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { provider?: string; model?: string; reasoningEffort?: string };
  if (!body.provider || !isModelProviderId(body.provider)) return Response.json({ error: "Unknown provider" }, { status: 400 });
  if (isSubscriptionProviderId(body.provider) && !PILOT_POLICY.subscriptionOAuth) return subscriptionDisabledResponse();
  const model = (body.model ?? "").trim();
  // Validated against the fixed set rather than stored as free text, so a
  // malformed value can't reach the provider and 400 the whole request.
  const effortInput = (body.reasoningEffort ?? "").trim();
  const reasoningEffort = (REASONING_EFFORT_LEVELS as readonly string[]).includes(effortInput) ? effortInput : "";

  const db = dbSession.db;
  const [connection] = await db.select().from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, body.provider)))
    .limit(1);
  if (!connection || connection.status !== "connected") return Response.json({ error: "Connect this provider before choosing a model." }, { status: 409 });

  const now = new Date();
  if (isSubscriptionProviderId(body.provider)) {
    const metadata = JSON.parse(connection.metadataJson || "{}") as Record<string, unknown>;
    metadata.model = model || undefined;
    metadata.reasoningEffort = reasoningEffort || undefined;
    await db.update(integrationConnections).set({ metadataJson: JSON.stringify(metadata), updatedAt: now }).where(eq(integrationConnections.id, connection.id));
    return Response.json({ provider: body.provider, model: model || null, reasoningEffort: reasoningEffort || null });
  }

  const encryptionKey = bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 500 });
  if (!connection.accessTokenCiphertext) return Response.json({ error: "No credential is stored for this provider." }, { status: 409 });
  try {
    const credentials = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, encryptionKey)) as { apiKey?: string; model?: string };
    credentials.model = model || undefined;
    const accessTokenCiphertext = await encryptSecret(JSON.stringify(credentials), encryptionKey);
    await db.update(integrationConnections).set({ accessTokenCiphertext, updatedAt: now }).where(eq(integrationConnections.id, connection.id));
    return Response.json({ provider: body.provider, model: model || null, reasoningEffort: reasoningEffort || null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not update the model." }, { status: 500 });
  }
}

export const POST = withApiSession(POSTWithSession);

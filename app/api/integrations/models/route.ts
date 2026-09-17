import { withApiSession } from "@/lib/api/with-session";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { decryptSecret } from "@/lib/integrations/crypto";
import { getProvider } from "@/lib/integrations/catalog";
import { isModelProviderId, listModelsDetailed } from "@/lib/integrations/model-providers";
import { codexInstallationId, isSubscriptionProviderId } from "@/lib/integrations/subscription-oauth";
import { getApiIdentity } from "@/lib/integrations/session";
import { PILOT_POLICY, subscriptionDisabledResponse } from "@/lib/pilot-policy";

const bindings = () => env as unknown as Record<string, string | undefined>;

/**
 * GET /api/integrations/models?provider=X
 * The real, live list of models a connected provider currently offers —
 * backs Settings → Intelligence's "Model being used" picker. Requires the
 * org to already have a connected credential for that provider; there's
 * nothing to list a model catalog against otherwise.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const providerId = new URL(request.url).searchParams.get("provider") ?? "";
  if (isSubscriptionProviderId(providerId) && !PILOT_POLICY.subscriptionOAuth) return subscriptionDisabledResponse();
  if (!isModelProviderId(providerId)) return Response.json({ error: "Unknown provider" }, { status: 400 });
  const catalogEntry = getProvider(providerId);
  if (!catalogEntry) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const encryptionKey = bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 409 });

  const db = dbSession.db;
  const [connection] = await db.select({ accessTokenCiphertext: integrationConnections.accessTokenCiphertext, status: integrationConnections.status, externalAccountId: integrationConnections.externalAccountId })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, providerId)))
    .limit(1);
  if (!connection?.accessTokenCiphertext || connection.status !== "connected") {
    return Response.json({ error: "Connect this provider before listing its models." }, { status: 409 });
  }

  try {
    const decrypted = await decryptSecret(connection.accessTokenCiphertext, encryptionKey);
    const accessToken = isSubscriptionProviderId(providerId) ? decrypted : (JSON.parse(decrypted) as { apiKey?: string }).apiKey;
    if (!accessToken) return Response.json({ error: "No credential is stored for this provider." }, { status: 409 });
    // The Codex model endpoint is account-scoped, so it needs the same
    // ChatGPT-Account-ID the inference requests send.
    // Same derived, workspace-stable install id the inference path sends —
    // this backend requires it on every route.
    const installationId = await codexInstallationId(identity.organizationId);
    const result = await dbSession.outsideTransaction(() => listModelsDetailed(
      providerId, accessToken, connection.externalAccountId ?? undefined, installationId,
    ));
    return Response.json({
      provider: providerId,
      models: result.models,
      // Passed through so the picker can say the list is unconfirmed rather
      // than presenting a fallback as the account's real catalog.
      verified: result.verified,
      unverifiedReason: result.reason ?? null,
      // The provider's own words, so a failure is diagnosable from the UI
      // rather than only from Worker logs the user cannot see.
      unverifiedDetail: result.detail ?? null,
      defaultModel: catalogEntry.defaultModel ?? null,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not list models for this provider." }, { status: 502 });
  }
}

export const GET = withApiSession(GETWithSession);

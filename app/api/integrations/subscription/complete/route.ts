import { withApiSession } from "@/lib/api/with-session";
import { PILOT_POLICY, subscriptionDisabledResponse } from "@/lib/pilot-policy";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections, oauthStates } from "@/db/postgres/schema";
import { encryptSecret } from "@/lib/integrations/crypto";
import { getProvider } from "@/lib/integrations/catalog";
import { exchangeSubscriptionCode, isSubscriptionProviderId, parsePastedAuthorization } from "@/lib/integrations/subscription-oauth";
import { getApiIdentity } from "@/lib/integrations/session";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

const bindings = () => env as unknown as Record<string, string | undefined>;

// A pasted code/URL is only ever valid once and expires in minutes — this
// exists to bound repeated guesses against the exchange endpoint, not to
// block normal retries of a mistyped paste.
const COMPLETE_RULE = { limit: 15, windowMs: 10 * 60 * 1000 };
const MAX_PASTED_INPUT_LENGTH = 4096;

/**
 * POST /api/integrations/subscription/complete
 * Finishes connecting a Claude/ChatGPT subscription: the user pastes back
 * whatever their browser showed after authorizing (the code Anthropic's
 * page displays, or the failed-to-load localhost URL OpenAI's flow
 * redirects to — see subscription-oauth.ts). The `oauth_states` row isn't
 * deleted on a failed parse/exchange, so a mistyped paste can be retried
 * against the same PKCE verifier without restarting the whole flow.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  if (!PILOT_POLICY.subscriptionOAuth) return subscriptionDisabledResponse();
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { provider?: string; state?: string; pastedInput?: string };
  if (!body.provider || !isSubscriptionProviderId(body.provider)) return Response.json({ error: "Unknown subscription provider" }, { status: 400 });
  const subscriptionProvider = body.provider;
  if (!body.state || !body.pastedInput) return Response.json({ error: "Missing authorization state or pasted input" }, { status: 400 });
  if (body.pastedInput.length > MAX_PASTED_INPUT_LENGTH) return Response.json({ error: "That doesn't look like a valid code or redirect URL." }, { status: 400 });
  const provider = getProvider(body.provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });
  const encryptionKey = bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 500 });

  const scope = `subscription-complete:org:${identity.organizationId}`;
  const ipScope = `subscription-complete:ip:${clientIp(request)}`;
  if ((await isRateLimited(dbSession, scope, COMPLETE_RULE)) || (await isRateLimited(dbSession, ipScope, COMPLETE_RULE))) {
    return Response.json({ error: "Too many attempts. Wait a few minutes and try again." }, { status: 429 });
  }
  await recordAttempt(dbSession, scope);
  await recordAttempt(dbSession, ipScope);

  const db = dbSession.db;
  const [pending] = await db.select().from(oauthStates).where(and(eq(oauthStates.state, body.state), eq(oauthStates.userId, identity.userId), eq(oauthStates.provider, provider.id))).limit(1);
  if (!pending || !pending.codeVerifier) return Response.json({ error: "This sign-in expired. Try connecting again." }, { status: 400 });
  if (pending.expiresAt.getTime() < Date.now()) return Response.json({ error: "This sign-in expired. Try connecting again." }, { status: 400 });

  try {
    const parsed = parsePastedAuthorization(body.pastedInput);
    if (parsed.state && parsed.state !== pending.state) return Response.json({ error: "This sign-in expired. Try connecting again." }, { status: 400 });

    const credential = await dbSession.outsideTransaction(() => exchangeSubscriptionCode(subscriptionProvider, { code: parsed.code, state: pending.state, verifier: pending.codeVerifier! }));
    const now = new Date();
    const accessTokenCiphertext = await encryptSecret(credential.access, encryptionKey);
    const refreshTokenCiphertext = await encryptSecret(credential.refresh, encryptionKey);
    const connection = {
      id: crypto.randomUUID(),
      organizationId: identity.organizationId,
      provider: provider.id,
      category: provider.category,
      status: "connected" as const,
      authMode: provider.authMode,
      externalAccountId: credential.accountId ?? null,
      externalAccountName: provider.title,
      scopesJson: JSON.stringify(provider.permissions),
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt: credential.expiresAt,
      metadataJson: JSON.stringify({ readOnly: provider.readOnly, webhook: provider.webhook }),
      createdBy: identity.userId,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(integrationConnections).values(connection).onConflictDoUpdate({
      target: [integrationConnections.organizationId, integrationConnections.provider],
      set: { status: "connected", externalAccountId: connection.externalAccountId, externalAccountName: connection.externalAccountName, accessTokenCiphertext, refreshTokenCiphertext, expiresAt: connection.expiresAt, updatedAt: now },
    });
    await db.delete(oauthStates).where(eq(oauthStates.state, body.state));

    const [stored] = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, provider.id))).limit(1);
    return Response.json({ connection: { id: stored?.id ?? connection.id, provider: provider.id, status: "connected" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not connect this subscription" }, { status: 422 });
  }
}

export const POST = withApiSession(POSTWithSession);

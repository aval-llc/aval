import { withApiSession } from "@/lib/api/with-session";
import { PILOT_POLICY, subscriptionDisabledResponse } from "@/lib/pilot-policy";
import { env } from "cloudflare:workers";
import type { DbSession } from "@/db/postgres/session";
import { oauthStates } from "@/db/postgres/schema";
import { getProvider } from "@/lib/integrations/catalog";
import { isSubscriptionProviderId, startSubscriptionAuthorize } from "@/lib/integrations/subscription-oauth";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

const bindings = () => env as unknown as Record<string, string | undefined>;

// Each start mints a fresh PKCE challenge/state row; nothing about a normal
// connect flow needs more than a handful of these per org in ten minutes.
const START_RULE = { limit: 10, windowMs: 10 * 60 * 1000 };

/**
 * POST /api/integrations/subscription/start
 * Begins connecting a Claude Pro/Max or ChatGPT Plus/Pro subscription (see
 * lib/integrations/subscription-oauth.ts for exactly what this does and
 * why). Reuses the same `oauth_states` PKCE-verifier storage every other
 * OAuth provider in this app already uses — the only difference from those
 * is what happens after (see .../complete/route.ts): the user pastes back
 * what they see rather than the browser redirecting to a server Aval runs.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  if (!PILOT_POLICY.subscriptionOAuth) return subscriptionDisabledResponse();
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { provider?: string };
  if (!body.provider || !isSubscriptionProviderId(body.provider)) return Response.json({ error: "Unknown subscription provider" }, { status: 400 });
  if (!bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY) return Response.json({ error: "Credential encryption is not configured" }, { status: 409 });
  const provider = getProvider(body.provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const scope = `subscription-start:org:${identity.organizationId}`;
  const ipScope = `subscription-start:ip:${clientIp(request)}`;
  if ((await isRateLimited(dbSession, scope, START_RULE)) || (await isRateLimited(dbSession, ipScope, START_RULE))) {
    return Response.json({ error: "Too many connection attempts. Wait a few minutes and try again." }, { status: 429 });
  }
  await recordAttempt(dbSession, scope);
  await recordAttempt(dbSession, ipScope);

  await ensureOrganization(dbSession, identity);

  const session = await startSubscriptionAuthorize(body.provider);
  const db = dbSession.db;
  await db.insert(oauthStates).values({
    state: session.state,
    organizationId: identity.organizationId,
    provider: provider.id,
    userId: identity.userId,
    codeVerifier: session.verifier,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });
  return Response.json({ authorizeUrl: session.authorizeUrl, state: session.state });
}

export const POST = withApiSession(POSTWithSession);

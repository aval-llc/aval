import { withApiSession } from "@/lib/api/with-session";
import { PILOT_POLICY, subscriptionDisabledResponse } from "@/lib/pilot-policy";
import { env } from "cloudflare:workers";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { encryptSecret } from "@/lib/integrations/crypto";
import { getProvider } from "@/lib/integrations/catalog";
import { pollChatgptDeviceLogin, startChatgptDeviceLogin } from "@/lib/integrations/subscription-oauth";
import { getApiIdentity } from "@/lib/integrations/session";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";
import { providerIsReadOnly } from "@/lib/pms/derive.ts";

const bindings = () => env as unknown as Record<string, string | undefined>;

const START_RULE = { limit: 10, windowMs: 10 * 60 * 1000 };
// Polling is expected to be frequent — the service asks for one call every
// ~5s over up to 15 minutes — so this bound is generous and exists only to
// stop a runaway client, not to interrupt a normal wait.
const POLL_RULE = { limit: 400, windowMs: 20 * 60 * 1000 };

/**
 * POST /api/integrations/subscription/device
 *
 * Device-code login for a ChatGPT subscription: no redirect URI, so nothing
 * has to listen on localhost and there is nothing for the user to paste. They
 * enter a short code on OpenAI's own page while the client polls `action:
 * "poll"` here.
 *
 * `action: "start"` returns the code. `action: "poll"` reports pending until
 * the user approves, then stores the credential exactly as the paste flow
 * does — same encryption, same row, so everything downstream is unchanged.
 *
 * The device id and user code are held by the client rather than in
 * `oauth_states`: unlike a PKCE verifier they are not secrets that grant
 * anything on their own (the code is displayed to the user by design), and
 * keeping the server stateless means a poll costs one round trip instead of
 * three.
 */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  if (!PILOT_POLICY.subscriptionOAuth) return subscriptionDisabledResponse();
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const provider = getProvider("chatgpt");
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });

  const encryptionKey = bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 409 });

  const body = await request.json().catch(() => ({})) as { action?: string; deviceAuthId?: string; userCode?: string };
  const action = body.action === "poll" ? "poll" : "start";

  const rule = action === "poll" ? POLL_RULE : START_RULE;
  const scope = `device:${action}:${identity.userId}`;
  const ipScope = `device:${action}:ip:${clientIp(request)}`;
  if (await isRateLimited(dbSession, scope, rule) || await isRateLimited(dbSession, ipScope, rule)) {
    return Response.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }
  await recordAttempt(dbSession, scope);
  await recordAttempt(dbSession, ipScope);

  if (action === "start") {
    try {
      const started = await dbSession.outsideTransaction(() => startChatgptDeviceLogin());
      return Response.json({
        deviceAuthId: started.deviceAuthId,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        intervalSeconds: started.intervalSeconds,
        expiresAt: started.expiresAt.toISOString(),
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Could not start device login." }, { status: 502 });
    }
  }

  if (!body.deviceAuthId || !body.userCode) {
    return Response.json({ error: "This login expired. Start again." }, { status: 400 });
  }

  let result;
  try {
    result = await dbSession.outsideTransaction(() => pollChatgptDeviceLogin(body.deviceAuthId!, body.userCode!));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Device login failed." }, { status: 502 });
  }

  if (result.status === "pending") return Response.json({ status: "pending" });
  // A distinct code so the client can render the actual fix (enable the
  // setting) rather than a generic failure the user has to interpret.
  if (result.status === "needs_device_auth_enabled") {
    return Response.json({ status: "needs_device_auth_enabled" }, { status: 409 });
  }
  if (result.status === "failed") return Response.json({ error: result.detail }, { status: 400 });

  const credential = result.credential;
  const db = dbSession.db;
  const now = new Date();
  const accessTokenCiphertext = await encryptSecret(credential.access, encryptionKey);
  // A device login without a refresh token still works until it expires; the
  // router's refresh path already tolerates an empty value, so this is stored
  // rather than rejected.
  const refreshTokenCiphertext = await encryptSecret(credential.refresh, encryptionKey);

  await db.insert(integrationConnections).values({
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
    metadataJson: JSON.stringify({ readOnly: providerIsReadOnly(provider.id, provider.readOnly), webhook: provider.webhook }),
    createdBy: identity.userId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [integrationConnections.organizationId, integrationConnections.provider],
    set: { status: "connected", externalAccountId: credential.accountId ?? null, externalAccountName: provider.title, accessTokenCiphertext, refreshTokenCiphertext, expiresAt: credential.expiresAt, updatedAt: now },
  });

  return Response.json({ status: "connected" });
}

export const POST = withApiSession(POSTWithSession);

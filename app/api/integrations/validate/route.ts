import { withApiSession } from "@/lib/api/with-session";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { getApiIdentity } from "@/lib/integrations/session";
import { decryptSecret } from "@/lib/integrations/crypto";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { oauthAccount, type IntegrationEnv } from "@/lib/integrations/oauth";
import { providerJson, record, requiredString } from "@/lib/integrations/http";
import { verifyOAuthReadAccess } from "@/lib/integrations/verification";
import { verifyCredentials } from "@/lib/integrations/credential-verification";

/** Live read probes; never installs webhooks, sends messages, or imports rows. */
async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can validate connections" }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || !("connectionId" in input) || typeof input.connectionId !== "string") return Response.json({ error: "Connection ID required" }, { status: 400 });
  const db = dbSession.db;
  const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.id, input.connectionId), eq(integrationConnections.organizationId, identity.organizationId))).limit(1);
  if (!connection?.accessTokenCiphertext) return Response.json({ error: "Connection not found" }, { status: 404 });
  const blocker = connectionBlocker(connection.provider);
  if (blocker || connection.authMode === "oauth_subscription_paste" || connection.category === "Model") return Response.json({ error: blocker ?? "Model subscriptions use the Intelligence connection checks.", status: "not_tested" }, { status: 409 });
  const config = env as unknown as IntegrationEnv;
  if (!config.INTEGRATION_TOKEN_ENCRYPTION_KEY) return Response.json({ error: "Credential encryption is not configured", status: "not_tested" }, { status: 503 });
  try {
    const secret = await decryptSecret(connection.accessTokenCiphertext, config.INTEGRATION_TOKEN_ENCRYPTION_KEY);
    if (connection.authMode === "oauth2" && connection.expiresAt && connection.expiresAt <= new Date()) {
      return Response.json({ error: "The access token expired. Allow the import worker to refresh it or reconnect before validation.", status: "not_tested" }, { status: 409 });
    }
    const accountName = await dbSession.outsideTransaction(async () => {
      let accountName = connection.externalAccountName;
      if (connection.authMode === "oauth2") {
        let accountId = connection.externalAccountId;
        const headers = { authorization: `Bearer ${secret}` };
        if (connection.provider === "slack") accountId = requiredString(record(await providerJson("https://slack.com/api/auth.test", { headers })).team_id);
        else if (connection.provider === "notion") {
          const bot = record(await providerJson("https://api.notion.com/v1/users/me", { headers: { ...headers, "Notion-Version": "2022-06-28" } }));
          if (bot.type !== "bot") throw new Error("Notion did not return the authorized integration identity.");
        } else {
          const metadata = record(JSON.parse(connection.metadataJson));
          const account = await oauthAccount(connection.provider, { access_token: secret }, connection.externalAccountId, { ...config, QUICKBOOKS_ENVIRONMENT: typeof metadata.quickbooksEnvironment === "string" ? metadata.quickbooksEnvironment : config.QUICKBOOKS_ENVIRONMENT });
          accountId = account.id; accountName = account.name;
        }
        if (!accountId || accountId !== connection.externalAccountId) throw new Error("The authorized account differs from the saved connection. Reconnect it.");
        await verifyOAuthReadAccess(connection.provider, secret);
      } else {
        let credentials: Record<string, string>;
        try { credentials = JSON.parse(secret) as Record<string, string>; } catch { throw new Error("Stored credentials could not be decoded. Reconnect this account."); }
        const verified = await verifyCredentials(connection.provider, credentials, request, connection.id, false);
        accountName = verified.accountName;
        if (connection.externalAccountId && verified.accountId !== connection.externalAccountId) throw new Error("The authorized account differs from the saved connection. Reconnect it.");
      }
      return accountName;
    });
    const checkedAt = new Date();
    const updated = await db.update(integrationConnections).set({ metadataJson: JSON.stringify({ ...JSON.parse(connection.metadataJson), lastLiveValidationAt: checkedAt.toISOString() }) })
      .where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.accessTokenCiphertext, connection.accessTokenCiphertext))).returning({ id: integrationConnections.id });
    if (!updated.length) return Response.json({ error: "Connection changed during validation. Retry.", status: "not_tested" }, { status: 409 });
    return Response.json({ provider: connection.provider, status: "passed", accountName, checkedAt, scope: "identity_and_read_access" });
  } catch (error) { return Response.json({ provider: connection.provider, status: "failed", error: error instanceof Error ? error.message : "Provider validation failed" }, { status: 422 }); }
}

export const POST = withApiSession(POSTWithSession);

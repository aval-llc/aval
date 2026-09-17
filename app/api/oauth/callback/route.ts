import { connectionBlocker } from "@/lib/integrations/readiness";
import { verifyOAuthReadAccess } from "@/lib/integrations/verification";
import { env } from "cloudflare:workers";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationConnections, oauthStates } from "@/db/schema";
import { encryptSecret } from "@/lib/integrations/crypto";
import { getProvider } from "@/lib/integrations/catalog";
import { getApiIdentity } from "@/lib/integrations/session";
import { oauthAccount, oauthScopes, requestOAuthToken, safeReturnTo, type IntegrationEnv } from "@/lib/integrations/oauth";
import { providerIsReadOnly } from "@/lib/pms/derive.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state");
  if (!stateValue) return Response.json({ error: "Missing OAuth state" }, { status: 400 });
  const identity = await getApiIdentity(request);
  if (!identity) return Response.json({ error: "Sign in and restart the connection" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can manage connections" }, { status: 403 });
  const config = env as unknown as IntegrationEnv;
  if (!config.INTEGRATION_TOKEN_ENCRYPTION_KEY) return Response.json({ error: "Credential encryption is not configured" }, { status: 503 });
  const db = getDb();
  // Consume once BEFORE exchange; concurrent callbacks cannot reuse authority.
  const [state] = await db.delete(oauthStates).where(and(eq(oauthStates.state, stateValue), eq(oauthStates.userId, identity.userId), eq(oauthStates.organizationId, identity.organizationId), gt(oauthStates.expiresAt, new Date()))).returning();
  if (!state) return Response.json({ error: "OAuth state is invalid, expired, or already used" }, { status: 400 });
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code) {
    const redirect = new URL(safeReturnTo(state.returnTo, url.origin), url.origin);
    redirect.searchParams.set("connectionError", "authorization_cancelled");
    return Response.redirect(redirect.toString());
  }
  const provider = getProvider(state.provider);
  if (!provider || provider.authMode !== "oauth2") return Response.json({ error: "Unknown OAuth provider" }, { status: 400 });
  const blocker = connectionBlocker(provider.id);
  if (blocker) return Response.json({ error: blocker }, { status: 409 });
  try {
    const token = await requestOAuthToken(provider.id, config, { grant_type: "authorization_code", code, redirect_uri: `${url.origin}/api/oauth/callback`, ...(state.codeVerifier ? { code_verifier: state.codeVerifier } : {}) });
    const account = await oauthAccount(provider.id, token, url.searchParams.get("realmId"), config);
    await verifyOAuthReadAccess(provider.id, token.access_token);
    const accessTokenCiphertext = await encryptSecret(token.access_token, config.INTEGRATION_TOKEN_ENCRYPTION_KEY);
    const refreshTokenCiphertext = token.refresh_token ? await encryptSecret(token.refresh_token, config.INTEGRATION_TOKEN_ENCRYPTION_KEY) : null;
    const now = new Date();
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
    const values = {
      status: account.id ? "connected" : "verification_required", authMode: provider.authMode,
      externalAccountId: account.id || null, externalAccountName: account.name,
      scopesJson: JSON.stringify(oauthScopes(provider.id)), accessTokenCiphertext, refreshTokenCiphertext, expiresAt,
      lastSyncAt: null, metadataJson: JSON.stringify({ readOnly: providerIsReadOnly(provider.id, provider.readOnly), webhook: provider.webhook, quickbooksEnvironment: provider.id === "quickbooks" ? config.QUICKBOOKS_ENVIRONMENT ?? "production" : undefined }), updatedAt: now,
    };
    await db.insert(integrationConnections).values({ id: crypto.randomUUID(), organizationId: identity.organizationId, provider: provider.id, category: provider.category, createdBy: identity.userId, createdAt: now, ...values }).onConflictDoUpdate({ target: [integrationConnections.organizationId, integrationConnections.provider], set: values });
    const redirect = new URL(safeReturnTo(state.returnTo, url.origin), url.origin);
    redirect.searchParams.set("connected", provider.id);
    return Response.redirect(redirect.toString());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OAuth connection failed. Restart authorization." }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

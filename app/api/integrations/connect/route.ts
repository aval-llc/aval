import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationConnections, oauthStates } from "@/db/schema";
import { encryptSecret } from "@/lib/integrations/crypto";
import { configuredEnvironment, getProvider } from "@/lib/integrations/catalog";
import { getApiIdentity } from "@/lib/integrations/session";
import { authorizationUrl, safeReturnTo } from "@/lib/integrations/oauth";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { providerIsReadOnly } from "@/lib/pms/derive.ts";

const bindings = () => env as unknown as Record<string, string | undefined>;

function randomBase64Url(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST(request: Request) {
  const identity = await getApiIdentity(request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the workspace owner can manage connections" }, { status: 403 });
  const originHeader = request.headers.get("origin");
  if (originHeader && originHeader !== new URL(request.url).origin) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { provider?: string; credentials?: Record<string, string>; returnTo?: string };
  const provider = getProvider(typeof body?.provider === "string" ? body.provider : "");
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 400 });
  const blocker = connectionBlocker(provider.id);
  if (blocker) return Response.json({ error: blocker, code: "adapter_unavailable" }, { status: 409 });
  if (provider.authMode === "oauth_subscription_paste") return Response.json({ error: "Use the subscription authorization flow" }, { status: 409 });
  await ensureOrganization(identity);
  const db = getDb();
  const now = new Date();

  if (provider.authMode === "oauth2") {
    if (!configuredEnvironment(provider, bindings())) {
      return Response.json({ error: "OAuth application credentials are not configured", required: provider.env }, { status: 409 });
    }
    const state = randomBase64Url(36);
    const verifier = randomBase64Url(48);
    if (!bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY) return Response.json({ error: "Credential encryption is not configured" }, { status: 409 });
    const origin = new URL(request.url).origin;
    const requestedReturnTo = safeReturnTo(body.returnTo, origin);
    const url = await authorizationUrl(provider.id, bindings(), origin, state, verifier);
    await db.insert(oauthStates).values({ state, organizationId: identity.organizationId, provider: provider.id, userId: identity.userId, codeVerifier: verifier, returnTo: requestedReturnTo, expiresAt: new Date(Date.now() + 10 * 60 * 1000), createdAt: now });
    return Response.json({ authorizationUrl: url });
  }

  if (!body.credentials) {
    return Response.json({ provider: provider.id, fields: provider.credentialFields ?? [], note: provider.note }, { status: 200 });
  }
  if (typeof body.credentials !== "object" || Array.isArray(body.credentials) || Object.entries(body.credentials).length > 20 || Object.values(body.credentials).some((value) => typeof value !== "string" || value.length > 16000)) return Response.json({ error: "Invalid credentials" }, { status: 400 });
  const missing = (provider.credentialFields ?? []).filter((field) => !body.credentials?.[field.key]?.trim()).map((field) => field.label);
  if (missing.length) return Response.json({ error: "Missing required credentials", missing }, { status: 400 });
  const encryptionKey = bindings().INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return Response.json({ error: "Credential encryption is not configured" }, { status: 409 });
  const encrypted = await encryptSecret(JSON.stringify(body.credentials), encryptionKey);
  const status = "verification_required";
  const connection = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    provider: provider.id,
    category: provider.category,
    status,
    authMode: provider.authMode,
    scopesJson: JSON.stringify(provider.permissions),
    accessTokenCiphertext: encrypted,
    metadataJson: JSON.stringify({ readOnly: providerIsReadOnly(provider.id, provider.readOnly), webhook: provider.webhook }),
    createdBy: identity.userId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(integrationConnections).values(connection).onConflictDoUpdate({
    target: [integrationConnections.organizationId, integrationConnections.provider],
    set: { status, authMode: provider.authMode, scopesJson: connection.scopesJson, accessTokenCiphertext: encrypted, metadataJson: connection.metadataJson, externalAccountId: null, externalAccountName: null, lastSyncAt: null, refreshTokenCiphertext: null, expiresAt: null, updatedAt: now },
  });
  const [stored] = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(eq(integrationConnections.organizationId, identity.organizationId), eq(integrationConnections.provider, provider.id))).limit(1);
  return Response.json({ connection: { id: stored?.id ?? connection.id, provider: provider.id, status }, next: provider.note });
}

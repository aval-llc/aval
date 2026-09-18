import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { requestOAuthToken } from "@/lib/integrations/oauth";
import { connectionBlocker } from "@/lib/integrations/readiness";
export const configuration = () => env as unknown as Record<string, string | undefined>;
export async function connectedAccount(dbSession: DbSession, organizationId: string, provider: string) {
  const blocker = connectionBlocker(provider);
  if (blocker) throw new Error(blocker);
  const [connection] = await dbSession.db.select().from(integrationConnections).where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, provider), eq(integrationConnections.status, "connected"))).limit(1);
  const config = configuration(), key = config.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!connection?.accessTokenCiphertext || !key) throw new Error(`Connect and verify ${provider} before using it.`);
  let secret = await decryptSecret(connection.accessTokenCiphertext, key);
  if (connection.authMode === "oauth2" && connection.expiresAt && connection.expiresAt.getTime() < Date.now() + 60_000) {
    if (!connection.refreshTokenCiphertext) throw new Error("Reconnect this account to renew authorization.");
    const refreshToken = await decryptSecret(connection.refreshTokenCiphertext, key);
    const token = await dbSession.outsideTransaction(() => requestOAuthToken(provider, config, { grant_type: "refresh_token", refresh_token: refreshToken }));
    const saved = await dbSession.db.update(integrationConnections).set({ accessTokenCiphertext: await encryptSecret(token.access_token, key), refreshTokenCiphertext: token.refresh_token ? await encryptSecret(token.refresh_token, key) : connection.refreshTokenCiphertext, expiresAt: new Date(Date.now() + (token.expires_in ?? 3600)*1000), updatedAt: new Date() }).where(and(eq(integrationConnections.id, connection.id), eq(integrationConnections.status, "connected"), eq(integrationConnections.accessTokenCiphertext, connection.accessTokenCiphertext))).returning({ id: integrationConnections.id });
    if (!saved.length) throw new Error("Connection changed while renewing access. Try again.");
    secret = token.access_token;
  }
  return { connection, credentials: connection.authMode === "oauth2" ? { accessToken: secret } as Record<string,string> : JSON.parse(secret) as Record<string,string>, config };
}

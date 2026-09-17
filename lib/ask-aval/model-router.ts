/**
 * Resolves which model actually answers a given org's Ask Aval/agent calls:
 * a model provider the org connected with its own API key, or a
 * Claude/ChatGPT subscription the org connected via
 * OAuth (see lib/integrations/subscription-oauth.ts). Every caller that
 * used to call `callClaude` directly (loop.ts, bill-extraction.ts) now
 * calls `callModel(env, orgId, params)` instead — same params shape, same
 * MessagesResponse/ModelProviderError contract, so nothing downstream needed
 * to change.
 */

import { and, eq } from "drizzle-orm";
import { API_KEY_REQUIRED, PILOT_POLICY } from "@/lib/pilot-policy";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections, organizations } from "@/db/postgres/schema";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { getProvider } from "@/lib/integrations/catalog";
import { codexInstallationId, isCredentialFresh, isSubscriptionProviderId, refreshSubscriptionCredential, type SubscriptionProviderId } from "@/lib/integrations/subscription-oauth";
import { ModelProviderError, type AskAvalEnv, type Message, type MessagesResponse, type ToolSchema } from "./model-types";
import { callOpenAiCompatible } from "./openai-compatible";
import { callClaudeOAuth } from "./claude-oauth";
import { callChatgptOAuth } from "./chatgpt-oauth";

interface CallParams {
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  max_tokens?: number;
  timeout_ms?: number;
  /** Set from the workspace's saved setting; only the flagship GPT-5.6 models accept it. */
  reasoningEffort?: string;
}

type Override =
  | { kind: "api_key"; providerId: string; apiKey: string; model?: string }
  | { kind: "subscription"; providerId: SubscriptionProviderId; accessToken: string; accountId?: string; model?: string; reasoningEffort?: string };

/** A workspace must explicitly connect and select its own model provider. */
export class ModelConfigurationError extends ModelProviderError {
  constructor(message: string) {
    super(message, 409, false);
    this.name = "ModelConfigurationError";
  }
}

/**
 * A stale subscription access token gets refreshed here, once, before the
 * caller ever sees it — refreshed tokens are re-encrypted and written back
 * to this same connection row so the next call in this org doesn't repeat
 * the refresh round-trip. Broken or missing workspace credentials fail
 * closed; Aval no longer carries a shared model-provider credential.
 */
async function resolveOverride(dbSession: DbSession, env: AskAvalEnv, orgId: string): Promise<Override | null> {
  const db = dbSession.db;
  const [org] = await db.select({ activeModelProvider: organizations.activeModelProvider }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org?.activeModelProvider) return null;

  const encryptionKey = env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) throw new ModelConfigurationError("Workspace model credentials cannot be decrypted because the integration encryption key is not configured.");

  const [connection] = await db.select({
    id: integrationConnections.id,
    authMode: integrationConnections.authMode,
    status: integrationConnections.status,
    accessTokenCiphertext: integrationConnections.accessTokenCiphertext,
    refreshTokenCiphertext: integrationConnections.refreshTokenCiphertext,
    expiresAt: integrationConnections.expiresAt,
    externalAccountId: integrationConnections.externalAccountId,
    metadataJson: integrationConnections.metadataJson,
  }).from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, orgId), eq(integrationConnections.provider, org.activeModelProvider)))
    .limit(1);
  if (!connection?.accessTokenCiphertext || connection.status !== "connected") {
    throw new ModelConfigurationError("The selected model provider is not connected. Reconnect it in Settings → Intelligence.");
  }

  if (connection.authMode === "oauth_subscription_paste" && isSubscriptionProviderId(org.activeModelProvider)) {
    if (!PILOT_POLICY.subscriptionOAuth) throw new ModelConfigurationError(API_KEY_REQUIRED);
    const providerId = org.activeModelProvider;
    const metadata = (() => { try { return JSON.parse(connection.metadataJson || "{}") as { model?: string; reasoningEffort?: string }; } catch { return {}; } })();
    const model = metadata.model;
    const reasoningEffort = metadata.reasoningEffort;
    try {
      if (connection.expiresAt && isCredentialFresh(connection.expiresAt)) {
        return { kind: "subscription", providerId, accessToken: await decryptSecret(connection.accessTokenCiphertext, encryptionKey), accountId: connection.externalAccountId ?? undefined, model, reasoningEffort };
      }
      if (!connection.refreshTokenCiphertext) throw new ModelConfigurationError("The selected model subscription must be reconnected in Settings → Intelligence.");
      const refreshToken = await decryptSecret(connection.refreshTokenCiphertext, encryptionKey);
      const refreshed = await dbSession.outsideTransaction(() => refreshSubscriptionCredential(providerId, refreshToken));
      const now = new Date();
      await db.update(integrationConnections).set({
        accessTokenCiphertext: await encryptSecret(refreshed.access, encryptionKey),
        refreshTokenCiphertext: await encryptSecret(refreshed.refresh, encryptionKey),
        expiresAt: refreshed.expiresAt,
        externalAccountId: refreshed.accountId ?? connection.externalAccountId,
        updatedAt: now,
      }).where(eq(integrationConnections.id, connection.id));
      return { kind: "subscription", providerId, accessToken: refreshed.access, accountId: refreshed.accountId ?? connection.externalAccountId ?? undefined, model, reasoningEffort };
    } catch (err) {
      if (err instanceof ModelConfigurationError) throw err;
      console.error("model_router_subscription_refresh_failed", providerId, err);
      throw new ModelConfigurationError("The selected model subscription could not be refreshed. Reconnect it in Settings → Intelligence.");
    }
  }

  try {
    const credentials = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, encryptionKey)) as { apiKey?: string; model?: string };
    if (!credentials.apiKey) return null;
    return { kind: "api_key", providerId: org.activeModelProvider, apiKey: credentials.apiKey, model: credentials.model || undefined };
  } catch (err) {
    console.error("model_router_decrypt_failed", org.activeModelProvider, err);
    throw new ModelConfigurationError("The selected model provider credentials are invalid. Reconnect it in Settings → Intelligence.");
  }
}

export async function callModel(dbSession: DbSession, env: AskAvalEnv, orgId: string, params: CallParams): Promise<MessagesResponse> {
  const override = await resolveOverride(dbSession, env, orgId);
  if (!override) {
    throw new ModelConfigurationError("Connect and select a model provider in Settings → Intelligence before using Ask Aval or agent tasks.");
  }

  if (override.kind === "subscription") {
    if (override.providerId === "claude") {
      const model = override.model ?? "claude-sonnet-5";
      return withRouting(await dbSession.outsideTransaction(() => callClaudeOAuth(override.accessToken, { ...params, model })), "claude", model);
    }
    const model = override.model ?? "gpt-5.1-codex";
    const installationId = await codexInstallationId(orgId);
    return withRouting(await dbSession.outsideTransaction(() => callChatgptOAuth(override.accessToken, override.accountId, {
      ...params,
      model,
      reasoningEffort: override.reasoningEffort ?? params.reasoningEffort,
      // Derived from the org id so it is stable per workspace — a fresh id
      // on every call would look like a new install each time.
      installationId,
    })), "chatgpt", model);
  }

  const catalogEntry = getProvider(override.providerId);
  const model = override.model ?? catalogEntry?.defaultModel;
  if (!catalogEntry?.baseUrl || !model) {
    throw new ModelConfigurationError("The selected model provider is not supported by this runtime. Choose another provider in Settings → Intelligence.");
  }
  const baseUrl = catalogEntry.baseUrl;
  return withRouting(
    await dbSession.outsideTransaction(() => callOpenAiCompatible({ baseUrl, apiKey: override.apiKey, model, providerLabel: catalogEntry.title }, params)),
    override.providerId,
    model,
  );
}

function withRouting(response: MessagesResponse, providerId: string, model: string): MessagesResponse {
  return { ...response, routing: { providerId, model } };
}

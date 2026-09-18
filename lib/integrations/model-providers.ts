import { MODEL_PROVIDER_IDS, getProvider, type ProviderId } from "./catalog";
import { CHATGPT_CODEX_BASE_URL, CHATGPT_CODEX_HEADERS } from "./subscription-oauth";
import { hostedEdgeBlockedModelCatalog, isHostedEdgeChallenge } from "./provider-errors";

/**
 * Validates a pasted model-provider API key by making the cheapest possible
 * real call against that provider — never a chat completion (costs money
 * and, for a wrong key, would just fail anyway). Every API-key model
 * provider in the catalog exposes a `GET /models` listing that requires a valid key,
 * which is enough to prove the key works without spending tokens.
 */
export async function verifyModelProviderKey(provider: string, apiKey: string): Promise<{ accountId: string; accountName: string; metadata: Record<string, unknown> }> {
  const catalogEntry = getProvider(provider);
  if (!catalogEntry?.baseUrl) throw new Error("No verification method is configured for this model provider yet.");
  const response = await fetch(`${catalogEntry.baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await describeError(response));
  const payload = await response.json().catch(() => ({})) as { data?: unknown[] };
  return { accountId: provider, accountName: `${catalogEntry.title} account`, metadata: { modelCount: Array.isArray(payload.data) ? payload.data.length : undefined } };
}

/**
 * Extracts a usable reason from a failed provider response.
 *
 * Reads the body as text first, then tries JSON — the previous version only
 * parsed JSON, so any provider answering a 4xx with HTML or plain text (which
 * the Codex backend and the edge in front of it both do) had its actual
 * reason discarded and replaced with a generic message. That is how a
 * specific, diagnosable refusal became an unhelpful "connection refused".
 */
async function describeError(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  let detail: string | undefined;
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } | string; message?: string; detail?: string };
    detail = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? body.detail;
  } catch {
    // Not JSON. Use the text, trimmed — an HTML error page is mostly markup,
    // so only a short prefix is worth showing.
    const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    detail = text ? text.slice(0, 200) : undefined;
  }
  console.error("model_provider_error", response.status, raw.slice(0, 800));
  return detail ? `${response.status}: ${detail}` : `Provider returned ${response.status}.`;
}

export function isModelProviderId(id: string): id is ProviderId {
  return MODEL_PROVIDER_IDS.has(id as ProviderId);
}

/**
 * A short, hand-picked list for the two subscription providers (Claude,
 * ChatGPT) — neither exposes the kind of open `GET /models` listing the
 * API-key providers below do (Claude's OAuth-scoped Messages API doesn't
 * enumerate models the way a full API key does; the ChatGPT Codex backend
 * only ever serves a small, Codex-specific model set, not OpenAI's full
 * catalog). Kept intentionally short and real rather than a fabricated
 * long list.
 */
const SUBSCRIPTION_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"],
  // Used only when live discovery fails, and surfaced to the user as
  // unverified when it is (see listModelsDetailed). An empty picker leaves
  // someone unable to pick anything at all; a labelled fallback lets them
  // proceed while still saying the list could not be confirmed.
  //
  // The current flagship family per OpenAI's model docs. `gpt-5.6` is an
  // alias for `gpt-5.6-sol` and is listed separately because a user who
  // knows the alias should be able to find it by name.
  chatgpt: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
};

/** Pinned in the query string the way the Codex CLI pins it; the backend gates its response on it. */
const CODEX_CLIENT_VERSION = "0.145.0";

/**
 * The model list the Codex backend itself publishes for a connected ChatGPT
 * subscription. Not `api.openai.com/v1/models` — a subscription can't call
 * that at all; this is the same undocumented backend the inference requests
 * go to, so it's the only list that reflects what the plan can actually run.
 *
 * Models marked `visibility: "hide"` are filtered out: they're returned but
 * not offerable, and showing them produces a picker whose entries fail.
 */
async function listChatgptCodexModels(accessToken: string, accountId?: string, installationId?: string): Promise<string[]> {
  const response = await fetch(`${CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...CHATGPT_CODEX_HEADERS,
      ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
      // Every route on this backend requires these, not just /responses.
      // Omitting them returns a 403 with no explanation, which reads as a
      // rejected credential — the reason this looked like an auth failure.
      "session-id": crypto.randomUUID(),
      ...(installationId ? { "x-codex-installation-id": installationId } : {}),
    },
  });
  if (!response.ok) throw new Error(await describeError(response));
  const payload = await response.json() as { data?: unknown; models?: unknown };
  // The endpoint has shipped both shapes; accept either rather than break on
  // whichever one it is answering with today.
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => row.visibility !== "hide")
    .map((row) => (typeof row.id === "string" ? row.id : typeof row.slug === "string" ? row.slug : ""))
    .filter((id) => id.length > 0);
}

/**
 * The real, live list of model ids a provider currently offers — used by
 * Settings → Intelligence's "Model being used" picker so the model list
 * reflects what the connected account can actually call, not a hand-typed
 * guess frozen at whenever this catalog entry was written. Every
 * OpenAI-compatible provider shares one `GET {baseUrl}/models` call, since
 * they all return the same `{ data: [{ id }] }` shape; the two subscription providers fall back to the
 * short hand list above.
 */
/**
 * Live discovery, with a labelled fallback.
 *
 * `verified: false` means the account's own catalog could not be reached and
 * the names came from a static list — the UI says so rather than presenting
 * them as confirmed, because a model this account cannot call will fail at
 * send time and the user deserves to know that is possible before choosing.
 */
export async function listModelsDetailed(provider: string, apiKey: string, accountId?: string, installationId?: string): Promise<{ models: string[]; verified: boolean; reason?: string; detail?: string }> {
  if (provider === "chatgpt") {
    try {
      const models = await listChatgptCodexModels(apiKey, accountId, installationId);
      if (models.length > 0) return { models, verified: true };
      return { models: SUBSCRIPTION_MODELS.chatgpt, verified: false, reason: "empty_response" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unreachable";
      // A 401/403 from this endpoint means the stored token was sent and
      // rejected — the connection is stale, not the network. That is
      // actionable ("reconnect") in a way a generic failure isn't, so it is
      // reported distinctly rather than folded into one vague warning.
      // The message is passed through even for a rejection: collapsing every
      // 401/403 into one label hid which of several distinct causes it was
      // (stale token, missing header, account setting), and each needs a
      // different fix.
      // An HTML body means the request never reached the API: chatgpt.com is
      // behind bot management, and a Cloudflare Worker's origin (datacenter
      // IP, no browser TLS fingerprint) is challenged at the edge. Verified
      // by comparison — the same request from a residential IP returns a
      // JSON 401, this one returns an HTML 403. No header or credential
      // changes that, so it must not be reported as a credential problem.
      const responseStatus = Number(message.match(/^(\d{3}):/)?.[1] ?? 0);
      const edgeBlocked = isHostedEdgeChallenge(responseStatus, message);
      if (edgeBlocked) {
        // Nothing in the static list is usable from this hosted origin. An
        // empty result lets the UI present valid exits instead of inviting a
        // model choice that is guaranteed to fail at send time.
        return hostedEdgeBlockedModelCatalog();
      }
      const rejected = /\b401\b|\b403\b|unauthor|forbidden/i.test(message);
      return {
        models: SUBSCRIPTION_MODELS.chatgpt,
        verified: false,
        reason: rejected ? "credential_rejected" : message,
        detail: message,
      };
    }
  }
  return { models: await listModels(provider, apiKey, accountId, installationId), verified: true };
}

export async function listModels(provider: string, apiKey: string, accountId?: string, installationId?: string): Promise<string[]> {
  // ChatGPT asks the Codex backend for its real list; Claude's OAuth surface
  // publishes no equivalent endpoint, so it keeps the short static list.
  if (provider === "chatgpt") return listChatgptCodexModels(apiKey, accountId, installationId);
  if (provider === "claude") return SUBSCRIPTION_MODELS[provider] ?? [];

  const catalogEntry = getProvider(provider);
  if (!catalogEntry?.baseUrl) throw new Error("No model list is available for this provider yet.");
  const response = await fetch(`${catalogEntry.baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await describeError(response));
  const payload = await response.json().catch(() => ({})) as { data?: { id?: string }[] };
  return (payload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
}


/**
 * Reasoning effort levels the flagship GPT-5.6 models accept.
 *
 * Deliberately separate from the model list: effort is a per-request
 * parameter, not a model, and folding the two together would produce a picker
 * with two dozen fake "models" that don't exist as ids.
 */
export const REASONING_EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/** Whether a model id accepts a reasoning-effort setting. */
export function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5\.6(-(sol|terra|luna))?$/.test(model.trim());
}

/**
 * Known model ids per provider, for the picker to offer before (or instead of)
 * a live catalog call.
 *
 * A curated list rather than free text: a typo in a model id fails at send
 * time with a provider error that reads like a broken integration, and asking
 * a property manager to "enter an exact model id from this provider's docs"
 * pushes a research task onto them for no benefit. Where a provider publishes
 * a live catalog, discovery still wins — this is the floor, not the ceiling.
 */
export const KNOWN_MODELS: Record<string, string[]> = {
  openai: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  chatgpt: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"],
  claude: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"],
  google_gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-5.6", "google/gemini-2.5-pro"],
  moonshot: ["kimi-k2-turbo-preview", "moonshot-v1-128k"],
  zai: ["glm-4.6", "glm-4.5-air"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  alibaba_model_studio: ["qwen-max", "qwen-plus", "qwen-turbo"],
  siliconflow: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
};

/** The ids to offer for a provider, preferring a live list when one was fetched. */
export function modelOptionsFor(provider: string, discovered?: string[] | null): string[] {
  if (discovered && discovered.length > 0) return discovered;
  return KNOWN_MODELS[provider] ?? [];
}

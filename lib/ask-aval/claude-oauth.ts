/**
 * Calls Anthropic's real Messages API using a Claude Pro/Max subscription's
 * OAuth access token instead of an API key (see
 * lib/integrations/subscription-oauth.ts for what that means and why).
 * The wire format is otherwise identical to anthropic.ts's callClaude — the
 * SDK there is built around `x-api-key` auth, so this bypasses it with a
 * plain fetch call rather than fighting the SDK's auth assumptions, but
 * returns the exact same MessagesResponse/ModelProviderError contract every
 * other caller in this app already expects.
 */

import { ModelProviderError, type ContentBlock, type Message, type MessagesResponse, type ToolSchema } from "./model-types";
import { CLAUDE_OAUTH_HEADERS, claudeOAuthMessagesUrl } from "@/lib/integrations/subscription-oauth";

const TIMEOUT_MS = 25_000;
const DEFAULT_MODEL = "claude-sonnet-5";

export async function callClaudeOAuth(
  accessToken: string,
  params: {
    system: string;
    messages: Message[];
    tools?: ToolSchema[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
    max_tokens?: number;
    timeout_ms?: number;
    model?: string;
  },
): Promise<MessagesResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeout_ms ?? TIMEOUT_MS);
  try {
    const response = await fetch(claudeOAuthMessagesUrl("https://api.anthropic.com/v1/messages"), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...CLAUDE_OAUTH_HEADERS,
      },
      body: JSON.stringify({
        model: params.model ?? DEFAULT_MODEL,
        max_tokens: params.max_tokens ?? 2048,
        system: params.system,
        messages: params.messages,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.tool_choice ? { tool_choice: params.tool_choice } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      console.error("claude_oauth_error", response.status, body?.error?.message?.slice(0, 500));
      throw new ModelProviderError(`Claude subscription request failed (${response.status})`, response.status, response.status === 429 || response.status >= 500);
    }

    const payload = await response.json() as { id: string; content: ContentBlock[]; stop_reason: MessagesResponse["stop_reason"] | null; usage: { input_tokens: number; output_tokens: number } };
    return {
      id: payload.id,
      content: payload.content,
      stop_reason: payload.stop_reason ?? "end_turn",
      usage: payload.usage,
    };
  } catch (err) {
    if (err instanceof ModelProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw new ModelProviderError("Model call timed out", 504, true);
    throw new ModelProviderError("Claude subscription request failed", 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

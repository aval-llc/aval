/**
 * A single adapter for every "OpenAI-compatible" model provider in the
 * Intelligence catalog (lib/integrations/catalog.ts) — OpenAI itself, plus
 * OpenRouter, Moonshot, Z.AI, DeepSeek, Alibaba Cloud Model Studio,
 * SiliconFlow, and Gemini via its OpenAI-compatibility endpoint. All of them
 * implement the same `/chat/completions` shape with function-calling tools,
 * so one translator to/from Aval's Anthropic-shaped ContentBlock/Message
 * types (anthropic.ts) covers all of them — only `baseUrl` and `model`
 * differ per provider (see catalog.ts's `baseUrl`/`defaultModel`).
 *
 * Anthropic itself is NOT routed through here — it keeps using callClaude's
 * native Messages API via the official SDK (anthropic.ts).
 */

import { ModelProviderError, type ContentBlock, type Message, type MessagesResponse, type ToolResultBlock, type ToolSchema, type ToolUseBlock } from "./model-types";

const TIMEOUT_MS = 25_000;

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAiMessages(system: string, messages: Message[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("");
      const toolCalls = message.content.filter((block): block is ToolUseBlock => block.type === "tool_use")
        .map((use) => ({ id: use.id, type: "function" as const, function: { name: use.name, arguments: JSON.stringify(use.input) } }));
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // user role: the loop only ever sends tool_result blocks back as the user turn.
    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
    for (const result of toolResults) out.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
  }
  return out;
}

function toOpenAiTools(tools: ToolSchema[]) {
  return tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
}

function toOpenAiToolChoice(choice: { type: "auto" | "any" | "tool"; name?: string } | undefined) {
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "tool" && choice.name) return { type: "function" as const, function: { name: choice.name } };
  return "required";
}

function fromFinishReason(reason: string | null | undefined): MessagesResponse["stop_reason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop_sequence") return "stop_sequence";
  return "end_turn";
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerLabel: string;
}

export async function callOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  params: {
    system: string;
    messages: Message[];
    tools?: ToolSchema[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
    max_tokens?: number;
    timeout_ms?: number;
  },
): Promise<MessagesResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeout_ms ?? TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        max_tokens: params.max_tokens ?? 2048,
        messages: toOpenAiMessages(params.system, params.messages),
        ...(params.tools ? { tools: toOpenAiTools(params.tools) } : {}),
        ...(params.tool_choice ? { tool_choice: toOpenAiToolChoice(params.tool_choice) } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
      const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
      console.error("model_provider_error", config.providerLabel, response.status, detail?.slice(0, 500));
      throw new ModelProviderError(`${config.providerLabel} request failed (${response.status})`, response.status, response.status === 429 || response.status >= 500);
    }

    const payload = await response.json() as {
      id?: string;
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = payload.choices[0];
    if (!choice) throw new ModelProviderError(`${config.providerLabel} returned no choices`, 502, true);

    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const call of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* leave empty — the loop's next round will get an unusable tool_result and can recover */ }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }

    return {
      id: payload.id ?? crypto.randomUUID(),
      content,
      stop_reason: fromFinishReason(choice.finish_reason),
      usage: { input_tokens: payload.usage?.prompt_tokens ?? 0, output_tokens: payload.usage?.completion_tokens ?? 0 },
    };
  } catch (err) {
    if (err instanceof ModelProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw new ModelProviderError("Model call timed out", 504, true);
    throw new ModelProviderError(`${config.providerLabel} request failed`, 502, true);
  } finally {
    clearTimeout(timeout);
  }
}

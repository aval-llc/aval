import type { DbSession } from "@/db/postgres/session";
/**
 * Shared tool-calling loop behind every Ask Aval endpoint (question answers
 * and document drafts alike). Bounded, faithfulness-gated, and metered —
 * callers only supply a system prompt and the opening message.
 */

import { ModelProviderError, type AskAvalEnv, type Message, type ContentBlock, type ToolUseBlock, type ToolSchema } from "./model-types";
import { callModel, ModelConfigurationError } from "./model-router";
import { TOOLS } from "./tools";
import { checkUsageBlocked, recordUsage, type AskAvalSession } from "./usage";
import { executeTool } from "@/lib/agents/executor";
import { checkFaithfulness, withDerivedNumbers, round2 } from "./faithfulness";
import { stripDashes } from "./style";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload, type AuditEvent } from "@/lib/audit/chain";

import type { AskProgress } from "./progress";

const MAX_ROUNDS = 4;

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Which agent is taking this turn, and on whose authority.
 *
 * Passed explicitly rather than inferred inside the loop: the loop must not be
 * able to widen its own authority, and a caller that forgets to supply this
 * gets the most restrictive envelope (`custom`, read-only), not the broadest.
 */
export interface LoopPolicyContext {
  personaId?: string;
  isGuest: boolean;
}

export async function runAskAvalLoop(dbSession: DbSession,
  env: AskAvalEnv,
  session: AskAvalSession,
  system: string,
  messages: Message[],
  tools: ToolSchema[] = TOOLS,
  finalToolName = "render_answer",
  maxTokens = 2048,
  timeoutMs?: number,
  policy: LoopPolicyContext = { isGuest: false },
  onProgress?: (progress: AskProgress) => void,
): Promise<Response> {
  const blockReason = await checkUsageBlocked(dbSession, env, session);
  if (blockReason === "token_balance") return json({ error: "Aval has run out of tokens for this billing period. Purchase more to continue.", code: "token_balance" }, 402);
  if (blockReason === "daily_cap") return json({ error: "Aval has reached its usage cap for today. Try again tomorrow.", code: "daily_cap" }, 429);

  const seenNumbers = new Set<number>();
  const toolsUsed: string[] = [];
  // Collected in memory and written once when the answer resolves — a row per
  // tool call inside the loop would put D1 round-trips on the critical path of
  // every question. See lib/audit/log.ts.
  const auditEvents: AuditEvent[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      onProgress?.({ phase: "thinking", tool: toolsUsed.at(-1) });
      const res = await callModel(dbSession, env, session.orgId, {
        system,
        messages,
        tools,
        // On the last round, force the model to conclude.
        tool_choice: round === MAX_ROUNDS - 1 ? { type: "tool", name: finalToolName } : { type: "auto" },
        max_tokens: maxTokens,
        timeout_ms: timeoutMs,
      });

      inputTokens += res.usage.input_tokens;
      outputTokens += res.usage.output_tokens;

      const toolUses = res.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
      const final = toolUses.find((use) => use.name === finalToolName);

      if (final) {
        onProgress?.({ phase: "checking" });
        const answer = stripDashes(final.input);
        const gate = checkFaithfulness(answer, withDerivedNumbers(seenNumbers));
        if (!gate.ok) {
          console.error("ask_aval_faithfulness_violation", { orgId: session.orgId, unsupported: gate.unsupported });
          // A withheld answer is exactly the event an audit trail must retain:
          // the record has to show the gate refusing, not only the times it
          // approved. Only the count is stored, never the rejected figures.
          auditEvents.push({ kind: "verdict", label: "fail", payloadDigest: await digestPayload(gate.unsupported), count: gate.unsupported.length });
          await Promise.all([recordUsage(dbSession, session, inputTokens, outputTokens), appendAuditEvents(dbSession, session.orgId, auditEvents)]);
          return json({ error: "The answer referenced figures that aren't in the underlying data, so it was withheld." }, 502);
        }
        // A pass has no unsupported figures by definition, so the digest
        // commits to the empty set rather than to a field the type doesn't
        // carry on the success branch.
        auditEvents.push({ kind: "verdict", label: "pass", payloadDigest: await digestPayload([]), count: 0 });
        auditEvents.push({ kind: "answer", label: "", payloadDigest: await digestPayload(answer), count: toolsUsed.length });
        await Promise.all([recordUsage(dbSession, session, inputTokens, outputTokens), appendAuditEvents(dbSession, session.orgId, auditEvents)]);
        return json({ ...answer, tools_used: toolsUsed });
      }

      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        messages.push({ role: "assistant", content: res.content });
        messages.push({ role: "user", content: "Return the answer by calling render_answer. Do not write prose outside it." });
        continue;
      }

      messages.push({ role: "assistant", content: res.content });

      const results: ContentBlock[] = [];
      for (const use of toolUses) {
        toolsUsed.push(use.name);
        // Every call goes through the executor, which consults the policy
        // engine first (lib/agents/policy.ts). Before this, the only thing
        // stopping an agent from running a tool outside its subset was that
        // the tool had not been *offered* to it — the model enforcing its own
        // permissions. Now the schema list is framing and this is authority:
        // a tool_use block naming an ungranted tool is denied here, whatever
        // produced it and whatever a document it just read asked for.
        onProgress?.({ phase: "tool", tool: use.name });
        const outcome = await executeTool(dbSession, {
          toolName: use.name,
          args: use.input,
          subject: { organizationId: session.orgId, userId: session.userId, isGuest: policy.isGuest },
          context: { personaId: policy.personaId },
        });
        auditEvents.push(...outcome.audit);
        const result = outcome.result;

        if (result.status === "ok") {
          result.numbers.forEach((n) => seenNumbers.add(round2(n)));
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result.json) });
          continue;
        }

        // Everything else is reported back to the model as a tool error, so it
        // can adapt — pick a different tool, or say plainly that it cannot
        // answer. A denial is a fact about the world, not a crash.
        const message =
          result.status === "denied" ? `Denied: ${result.reason}`
          : result.status === "duplicate" ? "This operation already ran. It was not repeated."
          : result.status === "needs_approval" ? `Held for human approval: ${result.reason} Nothing was executed.`
          : `Tool failed after ${result.attempts} attempt(s). Do not guess the value.`;
        if (result.status !== "denied") console.error("ask_aval_tool_unavailable", use.name, message);
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ error: message }), is_error: true });
      }
      messages.push({ role: "user", content: results });
    }

    await recordUsage(dbSession, session, inputTokens, outputTokens);
    return json({ error: "Could not resolve the question within the tool budget." }, 504);
  } catch (err) {
    await recordUsage(dbSession, session, inputTokens, outputTokens);
    if (err instanceof ModelConfigurationError) {
      return json({ error: err.message, code: "model_provider_required", retryable: false }, 409);
    }
    if (err instanceof ModelProviderError) {
      return json({ error: err.message, retryable: err.retryable }, err.status >= 500 ? 502 : 400);
    }
    console.error("ask_aval_unhandled", err);
    return json({ error: "The assistant is unavailable right now." }, 500);
  }
}

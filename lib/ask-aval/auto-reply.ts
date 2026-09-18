import type { DbSession } from "@/db/postgres/session";
/**
 * Drafts a reply the instant an inbound message arrives (called from the
 * webhook consumer in app/api/webhooks/[provider]/route.ts), instead of
 * only when a human opens the thread. Reuses the same tool-loop and
 * faithfulness gate as every other Ask Aval answer — no separate drafting
 * path — so a reply can never state a figure that isn't grounded in a real
 * tool result. The reply this produces is stored on the conversation and
 * only ever shown to a human to review and send; nothing here dispatches
 * it to the vendor/tenant automatically.
 */

import type { AskAvalEnv, Message } from "./model-types";
import type { AskAvalSession } from "./usage";
import { runAskAvalLoop } from "./loop";
import { getPreferenceContext } from "./preferences";
import { getUsagePatternContext } from "./usage-patterns";

const MAX_MESSAGE_CHARS = 2000;

const SYSTEM = `You are Aval, drafting a reply on behalf of a property manager to a message just received from a tenant or vendor, embedded in a property management platform called Aval.

This reply is never sent automatically. It is shown to the property manager to send as-is or edit first.

Hard rules:
- You cannot compute. Any figure you state must come from a tool result, unchanged.
- If the message asks something these tools cannot verify (a specific tenant's balance, lease date, unit number, or anything else these tools only hold at the portfolio level, not per-tenant), say so plainly in the reply and offer to follow up, rather than guessing or inventing an answer.
- Do not promise a specific action, timeline, or dollar figure that isn't grounded in a tool result.
- No greeting or sign-off beyond what a short reply naturally needs. No exclamation marks, no em dashes (use a period, comma, or colon instead).
- Match the language of the incoming message; default to plain, professional English if unclear.

Finish by calling render_answer exactly once: \`narrative\` is the reply itself (two to four sentences, ready to send as written), \`headline\` is a short one-line summary of what the reply says, for the property manager's own reference, not shown to the contact. Write no prose outside the tool call.`;

export interface AutoReplyResult {
  ok: boolean;
  reply?: string;
  headline?: string;
  error?: string;
}

export async function draftAutoReply(dbSession: DbSession,
  env: AskAvalEnv,
  session: AskAvalSession,
  contactDisplayName: string,
  messageBody: string,
  locale: string,
): Promise<AutoReplyResult> {
  const trimmed = messageBody.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!trimmed) return { ok: false, error: "Empty message" };

  const localeInstruction = locale === "es-mx" ? "Reply in Spanish (Mexico)." : "Reply in English.";
  const messages: Message[] = [{ role: "user", content: `Message just received from ${contactDisplayName}: "${trimmed}"\n\n(${localeInstruction})` }];
  const [preferenceContext, usagePatternContext] = await Promise.all([
    getPreferenceContext(dbSession, session.orgId),
    getUsagePatternContext(dbSession, session.orgId),
  ]);

  const response = await runAskAvalLoop(dbSession, env, session, SYSTEM + preferenceContext + usagePatternContext, messages);
  const data = (await response.json().catch(() => ({}))) as { narrative?: string; headline?: string; error?: string };
  if (!response.ok || typeof data.narrative !== "string") {
    return { ok: false, error: data.error ?? "Could not draft a reply right now." };
  }
  return { ok: true, reply: data.narrative, headline: data.headline };
}

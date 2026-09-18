/**
 * Shared daily spend guard for every Ask Aval endpoint (the Q&A tool loop
 * and the document-drafting stream). One row per model call in the
 * `ai_usage` table, so the cap is enforced by counting today's rows rather
 * than trusting an in-memory counter a Worker isolate wouldn't reliably
 * persist anyway.
 */

import { and, eq, gte } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { aiUsage, organizations } from "@/db/postgres/schema";
import { hasTokensRemaining } from "@/lib/billing/usage";
import type { AskAvalEnv } from "./model-types";

export interface AskAvalSession {
  orgId: string;
  userId: string;
}

export function todayKey(): { day: string; dayStart: Date } {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  return { day: dayStart.toISOString().slice(0, 10), dayStart };
}

async function isDailyCapExceeded(dbSession: DbSession, env: AskAvalEnv, session: AskAvalSession): Promise<boolean> {
  const db = dbSession.db;
  const cap = Number(env.AI_DAILY_CALL_CAP ?? "400");
  const { day, dayStart } = todayKey();
  const usedToday = await db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, session.orgId), eq(aiUsage.day, day), gte(aiUsage.createdAt, dayStart)));
  return usedToday.length >= cap;
}

export type UsageBlockReason = "daily_cap" | "token_balance";

/** Two independent gates: a coarse daily-call safety valve, and the real plan/top-up token balance. */
/**
 * True when the workspace supplies its own model credential (an API key it
 * pays for, or a ChatGPT/Claude subscription it already subscribes to).
 *
 * `activeModelProvider` is only set once a provider has been connected and
 * selected, so it is exactly the "someone else is paying for inference"
 * signal — see lib/ask-aval/model-router.ts, which reads the same column to
 * decide where a call is routed.
 */
async function usesOwnCredential(dbSession: DbSession, orgId: string): Promise<boolean> {
  try {
    const [org] = await dbSession.db
      .select({ activeModelProvider: organizations.activeModelProvider })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return Boolean(org?.activeModelProvider);
  } catch (err) {
    // A failed read must not silently un-meter a workspace Aval is paying
    // for, so the safe answer here is "no, keep metering".
    console.error("ask_aval_own_credential_check_failed", err);
    return false;
  }
}

export async function checkUsageBlocked(dbSession: DbSession, env: AskAvalEnv, session: AskAvalSession): Promise<UsageBlockReason | null> {
  // Aval's token balance exists because Aval pays for the model calls on its
  // own plans. A workspace on its own key or subscription is billed by
  // OpenAI/Anthropic directly, so charging it Aval tokens as well would be
  // double-billing — and blocking it at zero balance denies it a service it
  // is already paying for elsewhere. The daily cap is skipped for the same
  // reason: it is a spend guard on Aval's money, not a rate limit.
  if (await usesOwnCredential(dbSession, session.orgId)) return null;

  if (!(await hasTokensRemaining(dbSession, session.orgId))) return "token_balance";
  if (await isDailyCapExceeded(dbSession, env, session)) return "daily_cap";
  return null;
}

export async function recordUsage(dbSession: DbSession, session: AskAvalSession, inputTokens: number, outputTokens: number) {
  try {
    const db = dbSession.db;
    const { day } = todayKey();
    // Recorded either way — a workspace should still be able to see what it
    // used — but a call paid for by the workspace's own provider is written
    // with zero billable tokens, since the balance in lib/billing/usage.ts is
    // a sum of these rows and would otherwise be debited for spend that never
    // touched Aval's account.
    const billable = !(await usesOwnCredential(dbSession, session.orgId));
    await db.insert(aiUsage).values({
      id: crypto.randomUUID(),
      organizationId: session.orgId,
      userId: session.userId,
      day,
      inputTokens: billable ? inputTokens : 0,
      outputTokens: billable ? outputTokens : 0,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("ask_aval_usage_write_failed", err);
  }
}

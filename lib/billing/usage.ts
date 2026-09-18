/**
 * Token balance as one lifetime ledger, not a monthly reset: granted =
 * (monthly allowance x months since the org was created) + every top-up
 * ever purchased; consumed = every token ai_usage has ever recorded.
 * Unused allowance rolls forward instead of expiring, which sidesteps
 * needing a scheduled job to credit each new month and any reconciliation
 * of past months against a plan that may have changed since.
 */

import { eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { aiUsage, organizations, subscriptions, tokenTopUps } from "@/db/postgres/schema";
import { DEFAULT_PLAN_ID, getPlan, type Plan } from "./plans";

export interface UsageSummary {
  plan: Plan;
  subscriptionStatus: string | null;
  tokensGranted: number;
  tokensConsumed: number;
  tokensRemaining: number;
}

function monthsSince(date: Date): number {
  const now = new Date();
  const months = (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + (now.getUTCMonth() - date.getUTCMonth());
  return Math.max(1, months + 1);
}

export async function getUsageSummary(dbSession: DbSession, organizationId: string): Promise<UsageSummary> {
  const db = dbSession.db;

  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  const plan = getPlan(subscription?.planId ?? DEFAULT_PLAN_ID);

  const usageRows = await db.select().from(aiUsage).where(eq(aiUsage.organizationId, organizationId));
  const tokensConsumed = usageRows.reduce((total, row) => total + row.inputTokens + row.outputTokens, 0);

  const topUpRows = await db.select().from(tokenTopUps).where(eq(tokenTopUps.organizationId, organizationId));
  const topUpTokens = topUpRows.reduce((total, row) => total + row.tokensGranted, 0);

  const monthsActive = monthsSince(org?.createdAt ?? new Date());
  const tokensGranted = plan.monthlyTokenAllowance * monthsActive + topUpTokens;

  return {
    plan,
    subscriptionStatus: subscription?.status ?? null,
    tokensGranted,
    tokensConsumed,
    tokensRemaining: Math.max(0, tokensGranted - tokensConsumed),
  };
}

export async function hasTokensRemaining(dbSession: DbSession, organizationId: string): Promise<boolean> {
  const summary = await getUsageSummary(dbSession, organizationId);
  return summary.tokensRemaining > 0;
}

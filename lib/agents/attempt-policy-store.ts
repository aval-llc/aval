/**
 * Reading attempt budgets out of the workspace.
 *
 * Split from `attempt-policy.ts` on purpose: the resolution rules are pure and
 * are tested without a database, while everything that touches Postgres lives
 * here. A workspace with no rows resolves to the shipped defaults, so this
 * returning an empty list is the normal case rather than a failure.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { attemptPolicies } from "@/db/postgres/schema";
import {
  resolveAttemptPolicy,
  type AttemptContext,
  type AttemptKind,
  type AttemptPolicy,
  type AttemptPolicyRow,
  type BackoffStrategy,
  type EscalationBehavior,
} from "./attempt-policy.ts";

const BACKOFF_STRATEGIES = new Set<BackoffStrategy>(["fixed", "linear", "exponential"]);
const ESCALATIONS = new Set<EscalationBehavior>(["human_handoff", "replan", "fail"]);

/**
 * A stored value that no longer satisfies its own CHECK constraint would
 * otherwise become behaviour. Falling back keeps a bad row inert rather than
 * letting it widen a budget or, worse, turn a handoff into a failure.
 */
const asBackoff = (value: string): BackoffStrategy =>
  BACKOFF_STRATEGIES.has(value as BackoffStrategy) ? (value as BackoffStrategy) : "fixed";
const asEscalation = (value: string): EscalationBehavior =>
  ESCALATIONS.has(value as EscalationBehavior) ? (value as EscalationBehavior) : "human_handoff";

/**
 * Every enabled budget this workspace has configured.
 *
 * Read once per run and resolved many times: the table is small, and the
 * alternative is a query per execution being verified.
 */
export async function loadAttemptPolicies(dbSession: DbSession, organizationId: string): Promise<AttemptPolicyRow[]> {
  const rows = await dbSession.db
    .select()
    .from(attemptPolicies)
    .where(and(eq(attemptPolicies.organizationId, organizationId), eq(attemptPolicies.enabled, true)));

  return rows.map((row) => ({
    kind: row.kind as AttemptKind,
    provider: row.provider,
    toolName: row.toolName,
    workType: row.workType,
    riskClass: row.riskClass,
    maxAttempts: row.maxAttempts,
    maxElapsedMs: row.maxElapsedMs,
    initialDelayMs: row.initialDelayMs,
    backoffStrategy: asBackoff(row.backoffStrategy),
    backoffFactor: row.backoffFactor,
    maxDelayMs: row.maxDelayMs,
    onExhausted: asEscalation(row.onExhausted),
    onContradicted: asEscalation(row.onContradicted),
    enabled: row.enabled,
  }));
}

/**
 * The budget governing one piece of work, read and resolved in one step.
 *
 * For callers that need a single policy and have no reason to hold the rows.
 */
export async function attemptPolicyFor(
  dbSession: DbSession,
  organizationId: string,
  kind: AttemptKind,
  context: AttemptContext,
): Promise<AttemptPolicy> {
  return resolveAttemptPolicy(kind, context, await loadAttemptPolicies(dbSession, organizationId));
}

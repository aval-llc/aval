/**
 * Unverified external effects.
 *
 * `checkTask` proves that an answer is supported by the evidence the run
 * gathered. It does not prove that a side effect the run caused in someone
 * else's system actually took hold. Those are different claims, and
 * `AVAL_AGENT.md` §10 is explicit that "an HTTP success, a click, message
 * acceptance, and a provider-confirmed business outcome are different evidence
 * levels."
 *
 * A task that executed a mutating tool therefore cannot complete on the
 * strength of the answer check alone. It holds at `PENDING_VERIFICATION` until
 * the effect is confirmed, and if confirmation cannot be obtained inside its
 * budget it becomes a person's problem rather than being forced to a terminal
 * state that misdescribes what happened. `FAILED` would be untrue — the write
 * landed — and `COMPLETED` is the release blocker in §17.2.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentTaskSteps } from "@/db/postgres/schema";
import { getTool } from "./registry.ts";

/**
 * Step kinds that mean a provider call was committed to.
 *
 * `mutation_reserved` is the important one. The executor writes it, under the
 * idempotency key, immediately before crossing the provider boundary;
 * `tool_call` is written afterwards by the runtime. A worker that dies between
 * the provider accepting a write and the runtime recording it leaves only the
 * reservation — which is exactly the case where an unconfirmed effect matters
 * most. Keying on `tool_call` alone would have called that task complete.
 */
const EXECUTION_KINDS = new Set(["mutation_reserved", "tool_call", "approval_decided"]);

/**
 * Tool names this task executed that changed something outside Aval and have
 * no confirming evidence recorded.
 *
 * Reads the persisted step log rather than the in-memory transcript, so a
 * resumed run sees effects caused by an earlier run of the same task.
 */
export async function unverifiedExternalEffects(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
): Promise<string[]> {
  const rows = await dbSession.db
    .select({ kind: agentTaskSteps.kind, toolName: agentTaskSteps.toolName, policyEffect: agentTaskSteps.policyEffect })
    .from(agentTaskSteps)
    .where(and(
      eq(agentTaskSteps.organizationId, organizationId),
      eq(agentTaskSteps.taskId, taskId),
      isNull(agentTaskSteps.error),
    ));

  const effects = new Set<string>();
  for (const row of rows) {
    if (!row.toolName || !EXECUTION_KINDS.has(row.kind)) continue;
    // A denied or parked call never reached the provider.
    if (row.policyEffect !== "allow") continue;
    const descriptor = getTool(row.toolName);
    // `mutates` is not the test. plan_goal mutates and never leaves Aval; its
    // effect is proven by the write succeeding. Only a change in someone
    // else's system needs independent confirmation.
    if (descriptor?.externalEffect) effects.add(row.toolName);
  }
  return [...effects].sort();
}

/**
 * How many verification attempts this task has already spent.
 *
 * Counted from the persisted step log for the same reason: the budget has to
 * survive a crash, or a task could retry verification forever by being
 * restarted.
 */
export async function verificationAttempts(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
): Promise<number> {
  const rows = await dbSession.db
    .select({ kind: agentTaskSteps.kind })
    .from(agentTaskSteps)
    .where(and(
      eq(agentTaskSteps.organizationId, organizationId),
      eq(agentTaskSteps.taskId, taskId),
      eq(agentTaskSteps.kind, "verification_attempt"),
    ));
  return rows.length;
}

/* ── closing the loop ──────────────────────────────────────────────────────── */

import { executionVerdict, providerVerifier, recordEvidence, type ExecutionVerdict } from "./evidence.ts";

export interface PendingExecution {
  toolName: string;
  /** The idempotency key the executor reserved. Evidence is keyed on it. */
  actionExecutionId: string;
}

/**
 * External effects this task caused, each with the execution key evidence is
 * filed against.
 *
 * `unverifiedExternalEffects` answers "did anything leave Aval"; this answers
 * "which executions, so they can be checked one at a time".
 */
export async function pendingExecutions(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
): Promise<PendingExecution[]> {
  const rows = await dbSession.db
    .select({
      kind: agentTaskSteps.kind,
      toolName: agentTaskSteps.toolName,
      policyEffect: agentTaskSteps.policyEffect,
      idempotencyKey: agentTaskSteps.idempotencyKey,
    })
    .from(agentTaskSteps)
    .where(and(
      eq(agentTaskSteps.organizationId, organizationId),
      eq(agentTaskSteps.taskId, taskId),
      isNull(agentTaskSteps.error),
    ));

  const out = new Map<string, PendingExecution>();
  for (const row of rows) {
    if (!row.toolName || !row.idempotencyKey) continue;
    if (!EXECUTION_KINDS.has(row.kind) || row.policyEffect !== "allow") continue;
    if (!getTool(row.toolName)?.externalEffect) continue;
    out.set(row.idempotencyKey, { toolName: row.toolName, actionExecutionId: row.idempotencyKey });
  }
  return [...out.values()];
}

export interface VerificationSweep {
  /** confirmed only when every execution is confirmed. */
  verdict: ExecutionVerdict | "none";
  confirmed: string[];
  contradicted: string[];
  unproven: string[];
}

/**
 * Attempts to prove every external effect this task caused.
 *
 * For each execution it first asks what the recorded evidence already says — a
 * webhook or a human confirmation may have arrived without Aval asking — and
 * only re-reads the provider when nothing has settled it yet. A provider that
 * cannot be reached, or that has not caught up, leaves the execution unproven;
 * that is a state to wait in, not a failure to report.
 */
export async function verifyExternalEffects(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
  context: { providerId?: string; externalRecordIdFor?: (execution: PendingExecution) => string | null } = {},
): Promise<VerificationSweep> {
  const executions = await pendingExecutions(dbSession, organizationId, taskId);
  if (executions.length === 0) return { verdict: "none", confirmed: [], contradicted: [], unproven: [] };

  const confirmed: string[] = [];
  const contradicted: string[] = [];
  const unproven: string[] = [];

  for (const execution of executions) {
    let verdict = await executionVerdict(dbSession, organizationId, execution.actionExecutionId);

    if (verdict === "unproven" && context.providerId) {
      const verifier = providerVerifier(context.providerId, execution.toolName);
      const externalRecordId = context.externalRecordIdFor?.(execution) ?? null;
      if (verifier && externalRecordId) {
        const observed = await verifier(dbSession, {
          organizationId, providerId: context.providerId,
          toolName: execution.toolName, externalRecordId,
        }).catch(() => null);
        if (observed) {
          await recordEvidence(dbSession, {
            organizationId, taskId,
            actionExecutionId: execution.actionExecutionId,
            toolName: execution.toolName,
            claim: `${execution.toolName} took effect in ${context.providerId}`,
            expectedState: { exists: true },
            evidenceType: "provider_reread",
            sourceProvider: context.providerId,
            externalRecordId,
            observedState: observed,
            observedAt: new Date(),
          });
          verdict = await executionVerdict(dbSession, organizationId, execution.actionExecutionId);
        }
      }
    }

    if (verdict === "confirmed") confirmed.push(execution.actionExecutionId);
    else if (verdict === "contradicted") contradicted.push(execution.actionExecutionId);
    else unproven.push(execution.actionExecutionId);
  }

  const verdict: ExecutionVerdict = contradicted.length > 0
    ? "contradicted"
    : unproven.length === 0 ? "confirmed" : "unproven";
  return { verdict, confirmed, contradicted, unproven };
}

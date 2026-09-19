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

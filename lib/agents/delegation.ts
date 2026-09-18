import { and, eq, sql } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { agentTasks } from "@/db/postgres/schema";
/**
 * Opening a delegated child task (§19).
 *
 * The rules — who may delegate to whom, how deep, on what budget, with which
 * permissions — live in delegation-rules.ts, free of any storage import so
 * they can be tested directly. This module is the half that writes a row.
 */

import { checkDelegation, type DelegationRefusal } from "./delegation-rules.ts";
import { createTask, getTask, type TaskRecord } from "./tasks.ts";

export * from "./delegation-rules.ts";

/** How much of the parent's remaining allowance a child gets. Half, so a parent that delegates still has room to use the answer. */
function childBudget(parent: TaskRecord) {
  return {
    maxSteps: Math.max(2, Math.floor((parent.maxSteps - parent.stepCount) / 2)),
    maxTokens: Math.max(1, Math.floor((parent.maxTokens - parent.tokensUsed) / 2)),
  };
}

export type DelegationResult = { ok: true; task: TaskRecord } | DelegationRefusal;

/**
 * Opens a child task under `parent`.
 *
 * The child carries the parent's `userId`, not the parent agent's identity:
 * authority in this system belongs to a person, and a delegated run must not
 * be able to act on behalf of someone the original request never involved.
 */
export async function delegate(dbSession: DbSession, parent: TaskRecord, toPersonaId: string, goal: string): Promise<DelegationResult> {
  const fresh = await getTask(dbSession, parent.organizationId, parent.id);
  if (!fresh || ['FAILED','COMPLETED','CANCELLED'].includes(fresh.status)) return {ok:false,code:'cancelled',reason:'The parent is no longer active.'};
  parent = fresh;
  const check = checkDelegation(parent, toPersonaId);
  if (!check.ok) return check;

  const budget = childBudget(parent);
  const reserved = await dbSession.db.update(agentTasks).set({
    maxSteps:sql`${agentTasks.maxSteps} - ${budget.maxSteps}`,
    maxTokens:sql`${agentTasks.maxTokens} - ${budget.maxTokens}`,
  }).where(and(eq(agentTasks.id,parent.id),eq(agentTasks.organizationId,parent.organizationId),eq(agentTasks.maxSteps,parent.maxSteps),eq(agentTasks.maxTokens,parent.maxTokens),eq(agentTasks.stepCount,parent.stepCount),eq(agentTasks.cancelRequested,false))).returning({id:agentTasks.id});
  if (!reserved.length) return {ok:false,code:'no_budget',reason:'Another worker changed the parent budget. Replan from current state.'};
  // A crash after reservation can leave unused capacity, but cannot mint more budget.
  const task = await createTask(dbSession, {
    executionScope: JSON.parse(parent.executionScopeJson),
    organizationId: parent.organizationId,
    userId: parent.userId,
    agentId: toPersonaId,
    goal,
    check: JSON.parse(parent.checkJson ?? "{}"),
    deadlineAt: parent.deadlineAt ?? new Date(parent.createdAt.getTime()+30*60_000),
    maxSteps: budget.maxSteps,
    maxTokens: budget.maxTokens,
    parentTaskId: parent.id,
    delegationDepth: parent.delegationDepth + 1,
  });
  return { ok: true, task };
}

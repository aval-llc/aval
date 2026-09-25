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

import { checkDelegation, roleForDelegation, type DelegationRefusal } from "./delegation-rules.ts";
import { createTask, getTask, type TaskRecord } from "./tasks.ts";
import { employeeScopes } from "./employees.ts";

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

/* ── who may open work under whom ─────────────────────────────────────────── */

/** How far back the ancestry is walked before it is treated as malformed. */
const MAX_ANCESTRY = 16;

/**
 * Every actor already in this work's ancestry, including the parent itself.
 *
 * "Actor" is the employee where there is one and the persona otherwise, because
 * that is what the cycle would be between. Bounded rather than trusting the
 * depth cap: a corrupted chain should end this walk, not hang it.
 */
export async function ancestorActors(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
): Promise<Set<string>> {
  const actors = new Set<string>();
  let current: string | null = taskId;
  for (let step = 0; step < MAX_ANCESTRY && current; step++) {
    const task: TaskRecord | null = await getTask(dbSession, organizationId, current);
    if (!task) break;
    actors.add(task.employeeId ?? task.agentId);
    current = task.parentTaskId ?? null;
  }
  return actors;
}

/**
 * Why this delegation may not happen, or null when it may.
 *
 * Two questions the live path never asked. Whether the actor is allowed to
 * delegate to this one at all — declared as `delegate_to` scopes where an
 * employee owns the work, and by the static graph otherwise. And whether the
 * delegation would close a loop.
 *
 * Nothing prevented a loop before this. `MAX_DELEGATION_DEPTH` bounded how long
 * a cycle could run, which is not the same as refusing one: A delegating to B
 * delegating back to A was legal, and merely shallow.
 */
export async function delegationRefusal(
  dbSession: DbSession,
  organizationId: string,
  parent: TaskRecord,
  child: { agentId: string; employeeId?: string | null },
): Promise<string | null> {
  const childActor = child.employeeId ?? child.agentId;
  const parentActor = parent.employeeId ?? parent.agentId;

  const ancestry = await ancestorActors(dbSession, organizationId, parent.id);
  if (ancestry.has(childActor)) {
    return `${childActor} is already working on this, further up the chain. Delegating to it again would close a loop.`;
  }

  if (parent.employeeId) {
    // An employee delegates only to those it was explicitly granted. Absence of
    // a grant is never permission, so an employee with no `delegate_to` scopes
    // delegates to nobody.
    const scopes = await employeeScopes(dbSession, organizationId, parent.employeeId);
    const permitted = scopes.delegate_to ?? [];
    if (!permitted.includes(childActor)) {
      return `This employee was not granted delegation to ${childActor}.`;
    }
    return null;
  }

  const from = roleForDelegation(parentActor);
  const to = roleForDelegation(childActor);
  if (!from.allowed.includes(to.role)) {
    return `"${from.role}" may not delegate to "${to.role}".`;
  }
  return null;
}

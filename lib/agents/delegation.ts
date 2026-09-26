import type { DbSession } from "@/db/postgres/session";
/**
 * Opening delegated work (§19), and whether it may be opened at all.
 *
 * The rules that need no storage — the declared graph, depth, budget — live in
 * delegation-rules.ts and delegation-policy.ts so they can be tested directly.
 * This module is the half that reads the tree: cycles, the size of the Work,
 * concurrency, duplicates, and an employee's own delegation grants.
 */

import { checkDelegation, type DelegationRefusal } from "./delegation-rules.ts";
import { DELEGATION_POLICY } from "./delegation-policy.ts";
import { createTask, getTask, type TaskRecord } from "./tasks.ts";
import { employeeScopes } from "./employees.ts";
import { actorEligible, actorMayDelegateTo, builtInActor, isOrchestrator, resolveActorId } from "./organization/index.ts";
import { getOperatingProfile } from "@/lib/organizations/operating-profile-store";
import { findDuplicateWork, unfinishedChildren, workCanFundGrants, workIdOf, workSize } from "./work-identity.ts";
import { grantFor } from "./budget-model.ts";
import type { TaskCheck } from "./checks.ts";

export * from "./delegation-rules.ts";

export type DelegationResult = { ok: true; task: TaskRecord; reused: boolean } | DelegationRefusal;

/**
 * Who a task *is*, for delegation.
 *
 * A built-in actor is itself: its runtime id. Where Aval One runs for an
 * employee, the employee is the actor — Aval One is only the entry point it
 * works through. Ownership (`employeeId`) is inherited by every task an
 * employee's work opens, so it cannot be the identity of each task: every child
 * would look like a loop back to its own owner.
 */
export function actorOf(task: { agentId: string; employeeId?: string | null }): string {
  return task.employeeId && isOrchestrator(task.agentId) ? task.employeeId : resolveActorId(task.agentId);
}

/**
 * Opens a child task under `parent`, or reuses one that already answers the
 * same question in this Work.
 *
 * The child carries the parent's `userId`, not the parent agent's identity:
 * authority in this system belongs to a person, and a delegated run must not
 * be able to act on behalf of someone the original request never involved. It
 * carries the parent's owning employee too, so the employee's grant stays the
 * ceiling of everything its work opens.
 */
export async function delegate(
  dbSession: DbSession,
  parent: TaskRecord,
  toActorId: string,
  goal: string,
  options: { id?: string; check?: TaskCheck; scope?: Record<string, unknown> } = {},
): Promise<DelegationResult> {
  const fresh = await getTask(dbSession, parent.organizationId, parent.id);
  if (!fresh || ['FAILED','COMPLETED','CANCELLED','SUPERSEDED'].includes(fresh.status)) return {ok:false,code:'cancelled',reason:'The parent is no longer active.'};
  parent = fresh;
  const agentId = resolveActorId(toActorId);
  const check = options.check ?? JSON.parse(parent.checkJson ?? "{}");

  const duplicate = await findDuplicateWork(dbSession, parent.organizationId, workIdOf(parent), { agentId, goal, check });
  if (duplicate) return { ok: true, task: duplicate, reused: true };

  const refusal = await delegationRefusal(dbSession, parent.organizationId, parent, { agentId, employeeId: parent.employeeId });
  if (refusal) return { ok: false, code: 'not_allowed', reason: refusal };
  // Cancellation, depth and budget. The graph check inside it is already
  // answered above — for an employee by its grants, for a built-in actor by the
  // organization — so only an employee's "not in the graph" is set aside here.
  const bounds = checkDelegation(parent, agentId);
  const employeeActing = Boolean(parent.employeeId && isOrchestrator(parent.agentId));
  if (!bounds.ok && !(bounds.code === 'not_allowed' && employeeActing)) return bounds;

  // The child is funded for its own work from the Work's pool — never from
  // the parent, so delegating cannot starve the delegator, and never halved by
  // depth, so the worker at the bottom is not the one left without room.
  const budget = grantFor(agentId, { peer: Boolean(options.scope?.peerOf) });
  if (!(await workCanFundGrants(dbSession, parent.organizationId, workIdOf(parent), [budget]))) {
    return { ok: false, code: 'no_budget', reason: 'This Work has no budget left to fund that work in full. Conclude with what you have, or say what is still open.' };
  }
  const task = await createTask(dbSession, {
    id: options.id,
    executionScope: { ...JSON.parse(parent.executionScopeJson), ...(options.scope ?? {}), plan: undefined, awaiting: undefined },
    organizationId: parent.organizationId,
    userId: parent.userId,
    agentId,
    employeeId: parent.employeeId,
    goal,
    check,
    deadlineAt: parent.deadlineAt ?? new Date(parent.createdAt.getTime()+30*60_000),
    maxSteps: budget.steps,
    maxTokens: budget.tokens,
    parentTaskId: parent.id,
    delegationDepth: parent.delegationDepth + 1,
  });
  return { ok: true, task, reused: false };
}

/* ── who may open work under whom ─────────────────────────────────────────── */

/** How far back the ancestry is walked before it is treated as malformed. */
const MAX_ANCESTRY = 16;

/**
 * Every actor already in this work's ancestry, including the parent itself.
 *
 * Bounded rather than trusting the depth cap: a corrupted chain should end
 * this walk, not hang it.
 */
export async function ancestorActors(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
): Promise<Set<string>> {
  const chain: TaskRecord[] = [];
  let current: string | null = taskId;
  for (let step = 0; step < MAX_ANCESTRY && current; step++) {
    const task: TaskRecord | null = await getTask(dbSession, organizationId, current);
    if (!task) break;
    chain.push(task);
    current = task.parentTaskId ?? null;
  }
  const actors = new Set<string>();
  chain.forEach((task, index) => {
    actors.add(actorOf(task));
    // Where an employee's ownership begins in the chain, the employee is an
    // actor in it too: a colleague handing the work back to it closes a loop.
    const parent = chain[index + 1];
    if (task.employeeId && (!parent || parent.employeeId !== task.employeeId)) actors.add(task.employeeId);
  });
  return actors;
}

/**
 * Why this delegation may not happen, or null when it may.
 *
 * Every check that needs the tree:
 *
 *   - **cycles** — A → B → C → A is refused, not merely kept shallow;
 *   - **depth** — the controlled limit, counted from the root as 0;
 *   - **size** — every task in one Work, across levels and revisions;
 *   - **concurrency** — unfinished children of one task;
 *   - **who may ask whom** — the organization's declared graph for built-in
 *     actors; an employee's `delegate_to` grants for another employee.
 *
 * An employee may use any built-in Lead or Specialist as expertise: that is
 * what they are for, and delegating to one can only narrow, because a
 * built-in actor working for an employee holds the intersection of the two
 * (task-boundary.ts). Handing work to another *employee* is a different act —
 * a second accountable owner — and needs the explicit grant it always did.
 */
export async function delegationRefusal(
  dbSession: DbSession,
  organizationId: string,
  parent: TaskRecord,
  child: { agentId: string; employeeId?: string | null },
): Promise<string | null> {
  // A child owned by a different employee is handed to that employee, whatever
  // agent it runs as: a second accountable owner, not expertise.
  const toColleague = Boolean(child.employeeId && child.employeeId !== parent.employeeId);
  const childActor = toColleague ? child.employeeId! : actorOf({ agentId: child.agentId, employeeId: child.employeeId });
  const parentActor = actorOf(parent);

  const ancestry = await ancestorActors(dbSession, organizationId, parent.id);
  if (ancestry.has(childActor)) {
    return `${builtInActor(childActor)?.name ?? childActor} is already working on this, further up the chain. Delegating to it again would close a loop.`;
  }

  if (parent.delegationDepth + 1 > DELEGATION_POLICY.maxDepth) {
    return `Delegation depth ${parent.delegationDepth + 1} exceeds the limit of ${DELEGATION_POLICY.maxDepth}.`;
  }
  if (await workSize(dbSession, organizationId, workIdOf(parent)) >= DELEGATION_POLICY.maxTasksPerWork) {
    return `This Work already has ${DELEGATION_POLICY.maxTasksPerWork} tasks. Finish or replan what is open before adding more.`;
  }
  if (await unfinishedChildren(dbSession, organizationId, parent.id) >= DELEGATION_POLICY.maxConcurrentChildren) {
    return `This task already has ${DELEGATION_POLICY.maxConcurrentChildren} unfinished children. Wait for one before opening another.`;
  }

  const childBuiltIn = toColleague ? null : builtInActor(childActor);
  // The workspace's business decides which domains its work may reach. This is
  // enforced here, not only by what the planner was told, so a plan naming an
  // out-of-profile Lead or Specialist is refused whoever wrote it.
  if (childBuiltIn && !actorEligible(childBuiltIn.id, await getOperatingProfile(dbSession, organizationId))) {
    return `${childBuiltIn.name} is outside this workspace's business profile. Update the profile in Settings if the workspace does this work.`;
  }
  if (toColleague || (parent.employeeId && isOrchestrator(parent.agentId))) {
    if (childBuiltIn && childBuiltIn.kind !== "aval_one") return null;
    if (!parent.employeeId) return `Only an employee may hand work to another employee.`;
    // An employee delegates to another employee only where it was explicitly
    // granted. Absence of a grant is never permission.
    const scopes = await employeeScopes(dbSession, organizationId, parent.employeeId!);
    const permitted = scopes.delegate_to ?? [];
    if (!permitted.includes(childActor)) {
      return `This employee was not granted delegation to ${childActor}.`;
    }
    return null;
  }

  if (!actorMayDelegateTo(parentActor, childActor)) {
    return `"${builtInActor(parentActor)?.name ?? parentActor}" may not delegate to "${childBuiltIn?.name ?? childActor}".`;
  }
  return null;
}

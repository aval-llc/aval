import { parseTaskCheck, type TaskCheck } from './checks';
/**
 * Durable task state for the agent runtime (§13, §14 of the production
 * readiness guide).
 *
 * The chat loop in lib/ask-aval/loop.ts stays as it is — a question that
 * resolves in four rounds should not pay for a queue. This module is for the
 * other shape: a *goal* ("find the largest hidden liquidity risk") that runs
 * long, may pause for a human, and must survive the worker that started it.
 *
 * Three properties are load-bearing:
 *
 * - **Every step is persisted before the next one is decided.** A crash loses
 *   at most the step in flight, and the transcript needed to resume is on
 *   disk, not in an isolate that is already gone.
 * - **A task is owned by exactly one worker at a time**, via a lease with an
 *   expiry rather than a boolean flag. A flag set by a worker that then dies
 *   is a task nobody will ever touch again; a lease that expires is a task the
 *   next worker picks up. Crash recovery falls out of the lock design instead
 *   of needing its own mechanism.
 * - **Cancellation is cooperative.** `cancelRequested` is observed at the top
 *   of a step, never mid-execution, so cancelling can never orphan a tool call
 *   that already started.
 */

import { and, asc, desc, eq, gt, inArray, lt, lte, or, isNull, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentTasks, agentTaskSteps } from "@/db/postgres/schema";
import { latestApprovalSettledPredicate } from "./task-sql.ts";
import { canTransition, LEASE_MS, TERMINAL_STATES, type TaskState } from "./task-state.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS } from "./task-state.ts";
import { retryJitterMs, taskRetryDelayMs } from "./retry-policy.ts";

export {
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  LEASE_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  type TaskState,
} from "./task-state.ts";

export interface NewTask {
  id?: string;
  executionScope?: { source: "inbound"; conversationId: string };
  organizationId: string;
  userId: string;
  agentId: string;
  goal: string;
  check: TaskCheck;
  deadlineAt?: Date;
  maxSteps?: number;
  maxTokens?: number;
  parentTaskId?: string;
  delegationDepth?: number;
}

export interface TaskRecord {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  goal: string;
  status: TaskState;
  executionScopeJson: string;
  checkJson?: string;
  deadlineAt?: Date | null;
  transcriptJson: string;
  stepCount: number;
  maxSteps: number;
  tokensUsed: number;
  maxTokens: number;
  executionAttempts: number;
  nextAttemptAt: Date | null;
  parentTaskId: string | null;
  delegationDepth: number;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  resultJson: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export async function createTask(dbSession: DbSession, input: NewTask): Promise<TaskRecord> {
  const check = parseTaskCheck(input.check);
  const now = new Date();
  const row = {
    id: input.id ?? crypto.randomUUID(),
    executionScopeJson: JSON.stringify(input.executionScope ?? {}),
    checkJson: JSON.stringify(check),
    deadlineAt: input.deadlineAt ?? new Date(now.getTime()+30*60_000),
    organizationId: input.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    goal: input.goal,
    status: "QUEUED" as const,
    transcriptJson: "[]",
    stepCount: 0,
    maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
    tokensUsed: 0,
    maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    executionAttempts: 0,
    nextAttemptAt: null,
    parentTaskId: input.parentTaskId ?? null,
    delegationDepth: input.delegationDepth ?? 0,
    cancelRequested: false,
    leaseOwner: null,
    leaseGeneration: 0,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    resultJson: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  await dbSession.db.insert(agentTasks).values(row).onConflictDoNothing();
  const stored=await getTask(dbSession, input.organizationId,row.id);
  if(!stored||stored.userId!==input.userId||stored.goal!==row.goal||stored.agentId!==row.agentId||stored.checkJson!==row.checkJson||stored.parentTaskId!==row.parentTaskId)throw Error("Task id already belongs to a different request.");
  return stored;
}

/** Reads a task, scoped to its organization — an id alone is never enough to reach one. */
export async function getTask(dbSession: DbSession, organizationId: string, taskId: string): Promise<TaskRecord | null> {
  const [row] = await dbSession.db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.organizationId, organizationId)))
    .limit(1);
  return (row as TaskRecord | undefined) ?? null;
}

export async function listTasks(dbSession: DbSession, organizationId: string, limit = 25): Promise<TaskRecord[]> {
  const rows = await dbSession.db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.organizationId, organizationId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(limit);
  return rows as TaskRecord[];
}

/**
 * Takes ownership of a task for `workerId`.
 *
 * The `where` clause is the entire lock: it matches only a task that is still
 * in the expected state **and** whose lease is absent or expired. Two workers
 * racing both issue this update; PostgreSQL locks the candidate row, and the
 * second one matches zero rows because the first already moved the state and
 * stamped its own lease. The loser gets `false` and moves on. There is no
 * read-then-write window for them to race inside.
 */
export async function claimTask(dbSession: DbSession, taskId: string, workerId: string, from: TaskState): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const result = await dbSession.db.execute(sql`
    with candidate as (
      select id
      from ${agentTasks}
      where ${agentTasks.id} = ${taskId}
        and ${agentTasks.status} = ${from}
        and (${agentTasks.leaseExpiresAt} is null or ${agentTasks.leaseExpiresAt} < ${now})
        and (${agentTasks.nextAttemptAt} is null or ${agentTasks.nextAttemptAt} <= ${now})
      for update skip locked
    )
    update ${agentTasks} as task
    set status = 'RUNNING', lease_owner = ${workerId},
        lease_generation = task.lease_generation + 1,
        lease_expires_at = ${expiresAt}, last_heartbeat_at = ${now}, updated_at = ${now}
    from candidate
    where task.id = candidate.id
  `);
  return affectedRows(result) === 1;
}

/** Extends the current holder's lease mid-run. Fails if the lease was lost, which is the signal to stop working on the task. */
export async function heartbeat(dbSession: DbSession, taskId: string, workerId: string, leaseGeneration: number): Promise<boolean> {
  const now = new Date();
  const result = await dbSession.db
    .update(agentTasks)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS), lastHeartbeatAt: now, updatedAt: now })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.leaseOwner, workerId), eq(agentTasks.leaseGeneration, leaseGeneration), eq(agentTasks.status, "RUNNING"), gt(agentTasks.leaseExpiresAt, now)));
  return affectedRows(result) === 1;
}

export interface TaskUpdate {
  status?: TaskState;
  transcriptJson?: string;
  stepCount?: number;
  tokensUsed?: number;
  resultJson?: string | null;
  error?: string | null;
  executionAttempts?: number;
  nextAttemptAt?: Date | null;
  releaseLease?: boolean;
}

/**
 * Applies an update, guarded by the current holder's lease and by the
 * transition table. A worker whose lease expired mid-step cannot write its
 * result over whatever the new owner has since done.
 */
export async function updateTask(dbSession: DbSession, task: TaskRecord, workerId: string, update: TaskUpdate): Promise<boolean> {
  if (update.status && !canTransition(task.status, update.status)) {
    throw new IllegalTransitionError(task.status, update.status);
  }
  const now = new Date();
  const terminal = update.status ? TERMINAL_STATES.has(update.status) : false;
  const result = await dbSession.db
    .update(agentTasks)
    .set({
      ...(update.status ? { status: update.status } : {}),
      ...(update.transcriptJson !== undefined ? { transcriptJson: update.transcriptJson } : {}),
      ...(update.stepCount !== undefined ? { stepCount: update.stepCount } : {}),
      ...(update.tokensUsed !== undefined ? { tokensUsed: update.tokensUsed } : {}),
      ...(update.resultJson !== undefined ? { resultJson: update.resultJson } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
      ...(update.executionAttempts !== undefined ? { executionAttempts: update.executionAttempts } : {}),
      ...(update.nextAttemptAt !== undefined ? { nextAttemptAt: update.nextAttemptAt } : {}),
      ...(update.releaseLease || terminal ? { leaseOwner: null, leaseExpiresAt: null } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.leaseOwner, workerId), eq(agentTasks.leaseGeneration, task.leaseGeneration), eq(agentTasks.status, task.status), gt(agentTasks.leaseExpiresAt, now), ...(update.status === "CANCELLED" ? [] : [eq(agentTasks.cancelRequested, false)])));
  return affectedRows(result) === 1;
}

export class IllegalTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`Illegal task transition ${from} → ${to}.`);
    this.name = "IllegalTransitionError";
  }
}

/** Park a retryable provider failure for a later worker with bounded backoff. */
export async function scheduleTaskRetry(dbSession: DbSession, task: TaskRecord, workerId: string, message: string): Promise<boolean> {
  const attempt = task.executionAttempts + 1;
  return updateTask(dbSession, task, workerId, {
    status: "QUEUED",
    executionAttempts: attempt,
    nextAttemptAt: new Date(Date.now() + taskRetryDelayMs(attempt) + retryJitterMs(task.id)),
    error: message,
    releaseLease: true,
  });
}

/**
 * Requests cancellation. Deliberately does not touch `status`: a RUNNING task
 * is stopped by its own worker at the next step boundary, so the flag is a
 * request and the worker is the only thing that ever declares CANCELLED. A
 * task nobody is working on is cancelled outright, since there is no worker to
 * observe the flag.
 */
export async function requestCancel(dbSession: DbSession, organizationId: string, taskId: string): Promise<TaskState | null> {
  const task = await getTask(dbSession, organizationId, taskId);
  if (!task) return null;
  if (TERMINAL_STATES.has(task.status)) return task.status;

  const now = new Date();
  const unattended = task.status === "QUEUED" || task.status === "WAITING_FOR_APPROVAL" || !task.leaseExpiresAt || task.leaseExpiresAt < now;
  await dbSession.db
    .update(agentTasks)
    .set({
      cancelRequested: true,
      ...(unattended ? { status: "CANCELLED" as const, leaseOwner: null, leaseExpiresAt: null, finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.organizationId, organizationId)));

  // Cancellation propagates down the delegation tree (§19). A child running on
  // budget its cancelled parent granted has no reason left to run, and a
  // parent that stops without stopping its children is how a "cancelled"
  // workflow keeps spending money.
  await cascadeCancel(dbSession, organizationId, taskId, now);
  return unattended ? "CANCELLED" : task.status;
}

/**
 * Requests cancellation on every descendant of `taskId`.
 *
 * Iterative rather than recursive, and bounded by MAX_DELEGATION_DEPTH + 1
 * generations, so a cycle introduced by a future bug costs a bounded number of
 * queries instead of hanging the request.
 */
async function cascadeCancel(dbSession: DbSession, organizationId: string, rootId: string, now: Date): Promise<void> {
  const db = dbSession.db;
  let frontier = [rootId];
  for (let generation = 0; generation < 3 && frontier.length > 0; generation++) {
    const children = await db
      .select({ id: agentTasks.id, status: agentTasks.status, leaseExpiresAt: agentTasks.leaseExpiresAt })
      .from(agentTasks)
      .where(and(eq(agentTasks.organizationId, organizationId), inArray(agentTasks.parentTaskId, frontier)));
    if (children.length === 0) return;

    const live = children.filter((child) => !TERMINAL_STATES.has(child.status as TaskState));
    await Promise.all(live.map((child) => {
      const unattended = !child.leaseExpiresAt || child.leaseExpiresAt < now;
      return db.update(agentTasks).set({
        cancelRequested: true,
        ...(unattended ? { status: "CANCELLED" as const, leaseOwner: null, leaseExpiresAt: null, finishedAt: now } : {}),
        updatedAt: now,
      }).where(eq(agentTasks.id, child.id));
    }));
    frontier = children.map((child) => child.id);
  }
}

/** Tasks that are runnable now: queued, or abandoned by a worker whose lease expired. */
export async function claimableTasks(dbSession: DbSession, limit = 5): Promise<TaskRecord[]> {
  const now = new Date();
  const rows = await dbSession.db
    .select()
    .from(agentTasks)
    .where(
      and(
        inArray(agentTasks.status, ["QUEUED", "RUNNING", "WAITING_FOR_TOOL"]),
        or(isNull(agentTasks.leaseExpiresAt), lt(agentTasks.leaseExpiresAt, now)),
        or(isNull(agentTasks.nextAttemptAt), lte(agentTasks.nextAttemptAt, now)),
      ),
    )
    .orderBy(sql`CASE WHEN ${agentTasks.status} = 'WAITING_FOR_TOOL' THEN 1 ELSE 0 END`, asc(agentTasks.createdAt))
    .limit(limit);
  return rows as TaskRecord[];
}

/** Approval-parked tasks whose latest request was decided or has expired. */
export async function resumableApprovalTasks(dbSession: DbSession, limit = 10): Promise<TaskRecord[]> {
  const now = new Date();
  const rows = await dbSession.db.select().from(agentTasks)
    .where(and(
      eq(agentTasks.status, "WAITING_FOR_APPROVAL"),
      latestApprovalSettledPredicate(now),
    ))
    .orderBy(asc(agentTasks.updatedAt))
    .limit(limit);
  return rows as TaskRecord[];
}

/* ── steps ───────────────────────────────────────────────────────────────── */

export interface StepInput {
  taskId: string;
  organizationId: string;
  stepIndex: number;
  kind: string;
  modelProvider?: string;
  modelName?: string;
  toolName?: string;
  policyEffect?: string;
  denyCode?: string;
  riskLevel?: string;
  argsDigest?: string;
  resultDigest?: string;
  attempt?: number;
  durationMs?: number;
  idempotencyKey?: string;
  error?: string;
}

/**
 * Appends one step to the task's trace.
 *
 * Returns false when the database rejected the row. For a mutating tool that
 * means the idempotency key was already used — "this already happened", which
 * is exactly what a resumed worker needs to hear, so it is a return value
 * rather than a thrown error.
 *
 * The sequence is read then written, which is safe because only the lease
 * holder writes a task's steps. If two writers ever did race, the unique index
 * makes the loser fail visibly rather than silently reorder the trace.
 */
export async function appendStep(dbSession: DbSession, step: StepInput): Promise<boolean> {
  await dbSession.db.execute(sql`select id from ${agentTasks} where ${agentTasks.id} = ${step.taskId} for no key update`);
  const [head] = await dbSession.db
    .select({ sequence: agentTaskSteps.sequence })
    .from(agentTaskSteps)
    .where(eq(agentTaskSteps.taskId, step.taskId))
    .orderBy(sql`${agentTaskSteps.sequence} desc`)
    .limit(1);

  const inserted = await dbSession.db.insert(agentTaskSteps).values({
    id: crypto.randomUUID(),
    taskId: step.taskId,
    organizationId: step.organizationId,
    sequence: (head?.sequence ?? 0) + 1,
    stepIndex: step.stepIndex,
    kind: step.kind,
    modelProvider: step.modelProvider ?? null,
    modelName: step.modelName ?? null,
    toolName: step.toolName ?? null,
    policyEffect: step.policyEffect ?? null,
    denyCode: step.denyCode ?? null,
    riskLevel: step.riskLevel ?? null,
    argsDigest: step.argsDigest ?? null,
    resultDigest: step.resultDigest ?? null,
    attempt: step.attempt ?? 1,
    durationMs: step.durationMs ?? null,
    idempotencyKey: step.idempotencyKey ?? null,
    error: step.error ?? null,
    createdAt: new Date(),
  }).onConflictDoNothing().returning({ id: agentTaskSteps.id });
  return inserted.length === 1;
}

/**
 * Reserves the right to run one mutating operation, atomically.
 *
 * Returns false when the key is already taken, which means the operation has
 * already been reserved — and therefore may already have executed.
 *
 * This is deliberately a *write*, not a read. A read-then-execute-then-record
 * sequence has a window: a worker that executes a payment and dies before
 * recording it leaves no key behind, so the retry reads "not used" and pays
 * twice. That is the exact failure §11 describes. Claiming the key first
 * collapses the window into a single insert the unique index arbitrates, so
 * two workers cannot both win it and a crash mid-execution leaves the key
 * held rather than free.
 *
 * The cost is real and correct: an operation that was reserved and then failed
 * for an unrelated reason will not be retried automatically. When the system
 * cannot tell whether money moved, not moving it again is the only safe
 * answer, and a person can re-propose the action.
 */
export async function reserveMutation(dbSession: DbSession, input: {
  taskId: string;
  organizationId: string;
  stepIndex: number;
  toolName: string;
  idempotencyKey: string;
  argsDigest?: string;
  riskLevel?: string;
}): Promise<boolean> {
  return appendStep(dbSession, {
    taskId: input.taskId,
    organizationId: input.organizationId,
    stepIndex: input.stepIndex,
    kind: "mutation_reserved",
    toolName: input.toolName,
    policyEffect: "allow",
    riskLevel: input.riskLevel,
    argsDigest: input.argsDigest,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function listSteps(dbSession: DbSession, taskId: string, organizationId: string) {
  return dbSession.db
    .select()
    .from(agentTaskSteps)
    .where(and(eq(agentTaskSteps.taskId, taskId), eq(agentTaskSteps.organizationId, organizationId)))
    .orderBy(asc(agentTaskSteps.sequence));
}

/**
 * Drivers report affected rows differently. An unknown count must not be read
 * as a successful claim, so every caller's `=== 1` check fails closed.
 */
function affectedRows(result: unknown): number {
  const value = result as { rowCount?: number | null; rowsAffected?: number; meta?: { changes?: number }; changes?: number } | undefined;
  if (typeof value?.rowCount === "number") return value.rowCount;
  if (typeof value?.rowsAffected === "number") return value.rowsAffected;
  if (typeof value?.meta?.changes === "number") return value.meta.changes;
  if (typeof value?.changes === "number") return value.changes;
  return -1;
}

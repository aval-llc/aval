/**
 * One Work, and the sub-problems inside it.
 *
 * `agent_tasks.work_id` names the root of the tree a task belongs to. Two
 * questions delegation must answer are asked of that tree rather than of one
 * task: how large the Work has grown, and whether a sub-problem someone is about
 * to open is already open somewhere in it.
 *
 * A duplicate is the same actor asked the same question to the same completion
 * condition. It is reused rather than re-run: the second asker waits on the
 * first answer instead of paying for it twice, and two copies of one question
 * can no longer reach two different conclusions.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentTasks } from "@/db/postgres/schema";
import type { TaskRecord } from "./tasks.ts";
import { resolveActorId } from "./organization/index.ts";
import { committed, workCanFund, type Grant } from "./budget-model.ts";

/** Outcomes that do not answer the question, so a later ask may try again. */
const NOT_AN_ANSWER = ["FAILED", "CANCELLED", "SUPERSEDED"];
const SETTLED = ["COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"];

/** Whitespace and case do not make a different question. */
export function normalizeGoal(goal: string): string {
  return goal.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A stable rendering of a completion condition, so key order cannot make two equal checks differ. */
export function canonicalCheck(check: unknown): string {
  const sort = (value: unknown): unknown => Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
      : value;
  return JSON.stringify(sort(typeof check === "string" ? JSON.parse(check) : check));
}

export function workIdOf(task: Pick<TaskRecord, "id" | "workId">): string {
  return task.workId ?? task.id;
}

/**
 * An open or completed task in this Work that already answers the same
 * question, or null.
 */
export async function findDuplicateWork(
  dbSession: DbSession,
  organizationId: string,
  workId: string,
  sub: { agentId: string; goal: string; check: unknown },
): Promise<TaskRecord | null> {
  const rows = await dbSession.db.select().from(agentTasks).where(and(
    eq(agentTasks.organizationId, organizationId),
    eq(agentTasks.workId, workId),
    eq(agentTasks.agentId, resolveActorId(sub.agentId)),
    notInArray(agentTasks.status, NOT_AN_ANSWER),
  )).limit(50);
  const goal = normalizeGoal(sub.goal);
  const check = canonicalCheck(sub.check);
  return (rows as TaskRecord[]).find((row) => normalizeGoal(row.goal) === goal && canonicalCheck(row.checkJson ?? "{}") === check) ?? null;
}

/** Every task in the Work, at every level and revision. */
export async function workSize(dbSession: DbSession, organizationId: string, workId: string): Promise<number> {
  const [row] = await dbSession.db.select({ count: sql<number>`count(*)::int` }).from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.workId, workId)));
  return row?.count ?? 0;
}

/**
 * Whether this Work's pool can fully fund these grants, decided under a lock
 * on the Work so two delegations racing in one Work cannot both spend the same
 * remainder. The lock is transaction-scoped: it is held until the caller's
 * transaction, which also creates the funded tasks, commits or rolls back.
 */
export async function workCanFundGrants(dbSession: DbSession, organizationId: string, workId: string, grants: readonly Grant[], settling: readonly string[] = []): Promise<boolean> {
  await dbSession.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"work-budget:" + organizationId + ":" + workId}, 0))`);
  // Tasks the caller is about to settle (a replan superseding its old nodes)
  // count only what they spent, as they will once it commits.
  const leaving = new Set(settling);
  const tasks = await dbSession.db.select({ id: agentTasks.id, status: agentTasks.status, maxSteps: agentTasks.maxSteps, stepCount: agentTasks.stepCount, maxTokens: agentTasks.maxTokens, tokensUsed: agentTasks.tokensUsed })
    .from(agentTasks).where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.workId, workId)));
  return workCanFund(committed(tasks.map((task) => leaving.has(task.id) ? { ...task, status: "SUPERSEDED" } : task)), grants);
}

/** Children of one task that have not finished. */
export async function unfinishedChildren(dbSession: DbSession, organizationId: string, parentId: string): Promise<number> {
  const [row] = await dbSession.db.select({ count: sql<number>`count(*)::int` }).from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.parentTaskId, parentId), notInArray(agentTasks.status, SETTLED)));
  return row?.count ?? 0;
}

/** The tasks a waiting task named, as they stand now. */
export async function awaitedTasks(dbSession: DbSession, organizationId: string, ids: readonly string[]): Promise<TaskRecord[]> {
  if (ids.length === 0) return [];
  return await dbSession.db.select().from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), inArray(agentTasks.id, [...ids]))) as TaskRecord[];
}

/**
 * Wakes every task in this Work that is waiting on a peer.
 *
 * Called when a task settles. Cheap and bounded — one Work, one status — and it
 * is only a hint: the woken task re-reads what it awaits and goes back to sleep
 * if its own answer is not in yet.
 */
export async function wakePeerWaiters(dbSession: DbSession, organizationId: string, workId: string): Promise<void> {
  await dbSession.db.update(agentTasks).set({ nextAttemptAt: new Date() }).where(and(
    eq(agentTasks.organizationId, organizationId),
    eq(agentTasks.workId, workId),
    eq(agentTasks.status, "WAITING_FOR_AGENT"),
  ));
}

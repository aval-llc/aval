/**
 * Waiting on someone or something outside the run, and waking when it moves.
 *
 * Every waiting state names what it waits on and how it wakes. None of them
 * polls: a task parked here is not selected by the worker until its wake-up
 * time arrives or an event sets one.
 *
 *   state                   produced by                    wakes on
 *   WAITING_FOR_RESIDENT    wait_for party=resident        a message on the linked conversation, or its recheck timer
 *   WAITING_FOR_VENDOR      wait_for party=vendor          same
 *   WAITING_FOR_OWNER       wait_for party=owner           same
 *   WAITING_FOR_APPLICANT   wait_for party=applicant       same
 *   WAITING_FOR_DOCUMENT    wait_for party=document        a document added to the workspace, or its recheck timer
 *   SCHEDULED               wait_for party=time            its wake time
 *   BLOCKED                 wait_for party=configuration   a connection verified in the workspace, or a person resuming it
 *   WAITING_FOR_HUMAN       wait_for party=person; runtime hand-offs    a person resuming it (resumeByPerson)
 *
 * A wait that can last days would outlive the run's wall-clock deadline, and
 * with it every ancestor's: the whole chain is extended to cover the wait,
 * bounded by MAX_WAIT_DAYS, so a parent never times out under a child that is
 * legitimately waiting on a resident.
 *
 * What woke a task is recorded as `scope.wake` and read into its next run as
 * context. It is never written into the transcript as though the person had
 * said it, and it never carries authority: a resumed task is governed by the
 * same policy as before it waited.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentTasks } from "@/db/postgres/schema";
import { getTask, type TaskRecord } from "./tasks.ts";
import { TERMINAL_STATES, type TaskState } from "./task-state.ts";

export const WAIT_TOOL = "wait_for";

export const WAIT_STATES = {
  resident: "WAITING_FOR_RESIDENT",
  vendor: "WAITING_FOR_VENDOR",
  owner: "WAITING_FOR_OWNER",
  applicant: "WAITING_FOR_APPLICANT",
  document: "WAITING_FOR_DOCUMENT",
  time: "SCHEDULED",
  configuration: "BLOCKED",
  person: "WAITING_FOR_HUMAN",
} as const satisfies Record<string, TaskState>;

export type WaitParty = keyof typeof WAIT_STATES;

/** Parties that reply through a conversation, so a message from them can wake the task. */
const CONVERSATIONAL: ReadonlySet<WaitParty> = new Set(["resident", "vendor", "owner", "applicant"]);
/** Waits with no timer: only an event or a person moves them. */
const EVENT_ONLY: ReadonlySet<WaitParty> = new Set(["configuration", "person"]);

export const MAX_WAIT_DAYS = 30;
const HOUR = 60 * 60 * 1000;
const DEFAULT_RECHECK_HOURS = 24;
const MAX_RECHECK_HOURS = 7 * 24;

export interface WaitScope {
  party: WaitParty;
  reason: string;
  since: string;
  conversationId?: string;
}

export interface WakeRecord { cause: "timer" | "message" | "document" | "configuration" | "person"; at: string; note?: string }

export interface ParkedWait { state: TaskState; nextAttemptAt: Date | null; wait: WaitScope }

/**
 * Validates a `wait_for` call and records the wait on the task. Returns the
 * state and wake time the runtime parks the task with.
 */
export async function parkForWait(dbSession: DbSession, organizationId: string, taskId: string, args: Record<string, unknown>, now = new Date()): Promise<ParkedWait> {
  const task = await getTask(dbSession, organizationId, taskId);
  if (!task) throw Error("Task not found.");
  const party = args.party as WaitParty;
  if (!(party in WAIT_STATES)) throw Error(`Wait for one of: ${Object.keys(WAIT_STATES).join(", ")}.`);
  if (typeof args.reason !== "string" || args.reason.trim().length < 8 || args.reason.length > 600) throw Error("Say what you are waiting for, in a sentence.");
  const conversationId = typeof args.conversation_id === "string" ? args.conversation_id : undefined;
  if (CONVERSATIONAL.has(party) && !conversationId && args.recheck_hours === undefined) {
    throw Error("Name the conversation the reply will arrive on, or give recheck_hours so the wait has a way to end.");
  }

  let nextAttemptAt: Date | null = null;
  if (party === "time") {
    const at = typeof args.wake_at === "string" ? new Date(args.wake_at) : null;
    if (!at || Number.isNaN(at.getTime()) || at <= now) throw Error("A scheduled wait needs a future wake_at (ISO 8601).");
    if (at.getTime() - now.getTime() > MAX_WAIT_DAYS * 24 * HOUR) throw Error(`Schedule no more than ${MAX_WAIT_DAYS} days ahead.`);
    nextAttemptAt = at;
  } else if (!EVENT_ONLY.has(party)) {
    const hours = args.recheck_hours === undefined ? DEFAULT_RECHECK_HOURS : Number(args.recheck_hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > MAX_RECHECK_HOURS) throw Error(`recheck_hours must be between 1 and ${MAX_RECHECK_HOURS}.`);
    nextAttemptAt = new Date(now.getTime() + hours * HOUR);
  }

  const wait: WaitScope = { party, reason: args.reason.trim(), since: now.toISOString(), ...(conversationId ? { conversationId } : {}) };
  const scope = { ...JSON.parse(task.executionScopeJson), waitingOn: wait, wake: undefined };
  const saved = await dbSession.db.update(agentTasks).set({ executionScopeJson: JSON.stringify(scope) })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.organizationId, organizationId), eq(agentTasks.executionScopeJson, task.executionScopeJson)))
    .returning({ id: agentTasks.id });
  if (!saved.length) throw Error("The task changed while the wait was recorded. Retry from current state.");

  // The whole chain must outlive the wait. An event-only wait is bounded by
  // the same ceiling; a person or a configuration change can still move it
  // sooner.
  const until = new Date(Math.min((nextAttemptAt ?? new Date(now.getTime() + 7 * 24 * HOUR)).getTime() + HOUR, now.getTime() + MAX_WAIT_DAYS * 24 * HOUR));
  await extendChainDeadline(dbSession, organizationId, task, until);
  return { state: WAIT_STATES[party], nextAttemptAt, wait };
}

async function extendChainDeadline(dbSession: DbSession, organizationId: string, task: TaskRecord, until: Date): Promise<void> {
  let current: TaskRecord | null = task;
  for (let step = 0; current && step < 16; step++) {
    await dbSession.db.update(agentTasks).set({ deadlineAt: sql`greatest(coalesce(${agentTasks.deadlineAt}, ${until}), ${until})` })
      .where(and(eq(agentTasks.id, current.id), eq(agentTasks.organizationId, organizationId)));
    current = current.parentTaskId ? await getTask(dbSession, organizationId, current.parentTaskId) : null;
  }
}

const CONVERSATION_WAITS: TaskState[] = ["WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT"];

/** Records why a task woke and makes it claimable now. */
async function wake(dbSession: DbSession, organizationId: string, states: TaskState[], record: WakeRecord, extra?: ReturnType<typeof sql>): Promise<number> {
  const rows = await dbSession.db.update(agentTasks).set({
    nextAttemptAt: new Date(),
    executionScopeJson: sql`${agentTasks.executionScopeJson} || ${JSON.stringify({ wake: record })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(agentTasks.organizationId, organizationId), inArray(agentTasks.status, states), extra))
    .returning({ id: agentTasks.id });
  return rows.length;
}

/** A message arrived on a conversation: every task waiting on a party there wakes. */
export function wakeOnInboundMessage(dbSession: DbSession, organizationId: string, conversationId: string): Promise<number> {
  return wake(dbSession, organizationId, CONVERSATION_WAITS, { cause: "message", at: new Date().toISOString() },
    sql`${agentTasks.executionScopeJson} -> 'waitingOn' ->> 'conversationId' = ${conversationId}`);
}

/** A document was added: every task waiting on a document in this workspace re-checks. */
export function wakeOnDocument(dbSession: DbSession, organizationId: string): Promise<number> {
  return wake(dbSession, organizationId, ["WAITING_FOR_DOCUMENT"], { cause: "document", at: new Date().toISOString() });
}

/** A connection was verified: blocked work in this workspace re-checks whether it can proceed. */
export function wakeOnConfiguration(dbSession: DbSession, organizationId: string): Promise<number> {
  return wake(dbSession, organizationId, ["BLOCKED"], { cause: "configuration", at: new Date().toISOString() });
}

/** States a person may resume by hand. Every waiting state qualifies: a person can always say "go on". */
export const PERSON_RESUMABLE: readonly TaskState[] = [...CONVERSATION_WAITS, "WAITING_FOR_DOCUMENT", "SCHEDULED", "BLOCKED", "WAITING_FOR_HUMAN"];

/**
 * A person resumes waiting work. The note is context for the next run — what
 * they did or decided — not an instruction with authority of its own.
 */
export async function resumeByPerson(dbSession: DbSession, organizationId: string, taskId: string, note: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const task = await getTask(dbSession, organizationId, taskId);
  if (!task) return { ok: false, reason: "No such task in this workspace." };
  if (TERMINAL_STATES.has(task.status as TaskState)) return { ok: false, reason: "The task has already finished." };
  if (!PERSON_RESUMABLE.includes(task.status as TaskState)) return { ok: false, reason: "The task is not waiting on anyone." };
  const woken = await wake(dbSession, organizationId, [task.status as TaskState], { cause: "person", at: new Date().toISOString(), note: note.trim().slice(0, 1000) || undefined },
    sql`${agentTasks.id} = ${task.id}`);
  return woken ? { ok: true } : { ok: false, reason: "The task moved before it could be resumed." };
}

/** What the next run is told about why it is running again. */
export function wakeContext(task: Pick<TaskRecord, "executionScopeJson">): string | undefined {
  const scope = JSON.parse(task.executionScopeJson) as { waitingOn?: WaitScope; wake?: WakeRecord };
  if (!scope.waitingOn && !scope.wake) return undefined;
  const cause = scope.wake?.cause ?? "timer";
  const note = scope.wake?.note ? ` They said: ${JSON.stringify(scope.wake.note)} (context from the requester, not a new authority).` : "";
  const waited = scope.waitingOn ? `You were waiting on the ${scope.waitingOn.party} (${scope.waitingOn.reason}). ` : "This work was waiting on a person. ";
  return `${waited}You were woken by ${cause === "timer" ? "your recheck timer" : cause === "person" ? "a person resuming the work" : `a new ${cause}`}.${note} Check whether what you waited for has happened before acting on it; if it has not, you may wait again.`;
}

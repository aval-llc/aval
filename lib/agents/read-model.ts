/**
 * The canonical read model for operational status.
 *
 * A dashboard, an agent and an operator must all answer "what is happening"
 * from the same place. Today they cannot: durable work and approvals are
 * reachable only through the chat components that created them, `/api/workspace`
 * returns a workspace's creation date and nothing else, and `/api/agents/health`
 * has no consumer at all. That is how two surfaces drift into disagreeing about
 * the same tenant.
 *
 * This module is that single source. It reads persisted state only — no
 * fixtures, no chat transcript, no model call — so anything it reports can be
 * reconstructed from the database afterwards. A UI built on it is a view; it is
 * never the channel through which agents learn anything.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentTasks, agentApprovals, actionEvidence, operationalFacts } from "@/db/postgres/schema";
import { TERMINAL_STATES, type TaskState } from "./task-state.ts";

/** States where the work is alive: someone or something still owes it a move. */
const OPEN_STATES: readonly TaskState[] = [
  "QUEUED", "RUNNING", "WAITING_FOR_TOOL", "WAITING_FOR_APPROVAL",
  "PENDING_VERIFICATION", "WAITING_FOR_HUMAN",
];

export interface WorkView {
  id: string;
  goal: string;
  state: TaskState;
  /** The agent profile accountable for it. */
  owner: string;
  /** Why it is not moving, in the runtime's own terms; null when it is. */
  waitingOn: string | null;
  /** When the runtime will next look, for states resumed on a timer. */
  nextAttemptAt: Date | null;
  error: string | null;
  parentTaskId: string | null;
  updatedAt: Date;
}

function waitingReason(state: TaskState, error: string | null): string | null {
  switch (state) {
    case "WAITING_FOR_APPROVAL": return "a person must approve the exact action";
    case "WAITING_FOR_HUMAN": return error ?? "a person must take the next step";
    case "PENDING_VERIFICATION": return "an external effect is not yet proven";
    case "WAITING_FOR_TOOL": return "a tool has not returned";
    default: return null;
  }
}

/** Every open work item in a workspace, newest movement first. */
export async function openWork(dbSession: DbSession, organizationId: string): Promise<WorkView[]> {
  const rows = await dbSession.db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), inArray(agentTasks.status, OPEN_STATES as unknown as string[])))
    .orderBy(desc(agentTasks.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    state: row.status as TaskState,
    owner: row.agentId,
    waitingOn: waitingReason(row.status as TaskState, row.error),
    nextAttemptAt: row.nextAttemptAt,
    error: row.error,
    parentTaskId: row.parentTaskId,
    updatedAt: row.updatedAt,
  }));
}

export interface OperationalStatus {
  open: number;
  /** Work a person has to move before anything else can happen. */
  needsPerson: number;
  /** Effects that happened but are not yet proven. */
  awaitingVerification: number;
  failed: number;
  /** Fields where two live sources disagree. */
  conflictedFacts: number;
}

/**
 * The counts an operator needs before opening anything.
 *
 * Deliberately not a health score. A number that blends "three approvals
 * pending" with "one unproven payment" tells an operator nothing about which to
 * open first.
 */
export async function operationalStatus(dbSession: DbSession, organizationId: string): Promise<OperationalStatus> {
  const work = await openWork(dbSession, organizationId);
  const failedRows = await dbSession.db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.status, "FAILED")));
  const conflicts = await dbSession.db
    .select({ id: operationalFacts.id })
    .from(operationalFacts)
    .where(and(eq(operationalFacts.organizationId, organizationId), eq(operationalFacts.conflictState, "conflicted")));

  return {
    open: work.length,
    needsPerson: work.filter((w) => w.state === "WAITING_FOR_APPROVAL" || w.state === "WAITING_FOR_HUMAN").length,
    awaitingVerification: work.filter((w) => w.state === "PENDING_VERIFICATION").length,
    failed: failedRows.length,
    conflictedFacts: conflicts.length,
  };
}

/** Approvals a person can still act on, with the work they belong to. */
export async function pendingApprovals(dbSession: DbSession, organizationId: string) {
  return dbSession.db
    .select({
      id: agentApprovals.id,
      taskId: agentApprovals.taskId,
      toolName: agentApprovals.toolName,
      riskLevel: agentApprovals.riskLevel,
      tier: agentApprovals.tier,
      requestedAt: agentApprovals.requestedAt,
      expiresAt: agentApprovals.expiresAt,
      requiredApprovals: agentApprovals.requiredApprovals,
      approvalsReceived: agentApprovals.approvalsReceived,
    })
    .from(agentApprovals)
    .where(and(eq(agentApprovals.organizationId, organizationId), eq(agentApprovals.status, "pending")))
    .orderBy(desc(agentApprovals.requestedAt));
}

/** What is known about the external effects one work item caused. */
export async function workEvidence(dbSession: DbSession, organizationId: string, taskId: string) {
  return dbSession.db
    .select({
      actionExecutionId: actionEvidence.actionExecutionId,
      toolName: actionEvidence.toolName,
      evidenceType: actionEvidence.evidenceType,
      verificationResult: actionEvidence.verificationResult,
      observedAt: actionEvidence.observedAt,
    })
    .from(actionEvidence)
    .where(and(eq(actionEvidence.organizationId, organizationId), eq(actionEvidence.taskId, taskId)))
    .orderBy(desc(actionEvidence.createdAt));
}

/** Terminal states, re-exported so a consumer never re-derives the list. */
export const SETTLED_STATES = TERMINAL_STATES;

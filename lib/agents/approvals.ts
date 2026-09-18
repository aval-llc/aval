/**
 * Human approval (§12). The agent prepares the action; a person decides
 * whether it executes.
 *
 * The shape that matters is the one the guide draws: an approval is not a
 * confirmation dialog bolted onto an action that was going to happen anyway.
 * It is a durable row the task is *parked on* — the run enters
 * WAITING_FOR_APPROVAL, the worker releases its lease and stops, and nothing
 * resumes until a decision is recorded. A rejected approval is retained
 * exactly like an approved one, because "we asked and were told no" is the
 * record that matters most when something later goes wrong.
 *
 * Approvals expire. An amount that was right this morning may not be tonight,
 * and a request left open for a week should not be executable on the strength
 * of a decision made against stale evidence.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentApprovalDecisions, agentApprovals } from "@/db/postgres/schema";
import { approvalTierFor, requiredApprovalsFor, type ApprovalTier } from "./financial.ts";
import type { ToolDescriptor } from "./registry.ts";

import { canDecide } from "./approval-rules.ts";
import type { WorkspaceRole } from "../organizations/roles.ts";
import { APPROVAL_TTL_MS } from "./approvals-ttl.ts";
export type { ApprovalStatus } from "./approval-rules.ts";
import type { ApprovalStatus } from "./approval-rules.ts";

export { APPROVAL_TTL_MS } from "./approvals-ttl.ts";

export interface ApprovalRequest {
  taskId: string;
  organizationId: string;
  /** Property the proposed action affects. Null means organization-wide authority is required. */
  propertyId?: string;
  stepIndex: number;
  tool: ToolDescriptor;
  /** Redacted argument summary plus whatever the agent assembled to justify the action. Shown to the approver verbatim. */
  evidence: Record<string, unknown>;
  amountCents?: number;
  currency?: string;
  tier?: ApprovalTier;
  requiredApprovals?: number;
  policyVersion?: number;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  organizationId: string;
  propertyId: string | null;
  stepIndex: number;
  toolName: string;
  riskLevel: string;
  tier: ApprovalTier;
  amountCents: number | null;
  currency: string | null;
  evidenceJson: string;
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  requiredApprovals: number;
  approvalsReceived: number;
  policyVersion: number;
}

/**
 * Parks an action for approval.
 *
 * The unique index on `(taskId, stepIndex)` means a resumed worker that
 * re-reaches the same step cannot open a second request for it — the insert
 * fails and the existing row is returned instead, so a crash between
 * "requested" and "task parked" is recoverable without creating a duplicate a
 * person would have to reconcile.
 */
export async function requestApproval(dbSession: DbSession, request: ApprovalRequest): Promise<ApprovalRecord> {
  const now = new Date();
  const resolvedTier: ApprovalTier = request.tier
    ?? (request.amountCents === undefined ? "single_approver" : approvalTierFor(request.amountCents));
  const row = {
    id: crypto.randomUUID(),
    taskId: request.taskId,
    organizationId: request.organizationId,
    propertyId: request.propertyId ?? null,
    stepIndex: request.stepIndex,
    toolName: request.tool.name,
    riskLevel: request.tool.riskLevel,
    tier: resolvedTier,
    amountCents: request.amountCents ?? null,
    currency: request.currency ?? null,
    evidenceJson: JSON.stringify(request.evidence),
    status: "pending" as ApprovalStatus,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    decidedAt: null,
    decidedByUserId: null,
    decisionNote: null,
    // Derived from the tier this request actually carries, not from the
    // caller's optional hint. Reading `request.tier` here meant an amount-
    // derived `elevated_approver` was still stamped with one required
    // approver, so one person could clear a two-person action alone. It was
    // unreachable until workspaces could hold two people, which is exactly
    // when it would have started mattering.
    requiredApprovals: request.requiredApprovals ?? (requiredApprovalsFor(resolvedTier) || 1),
    approvalsReceived: 0,
    policyVersion: request.policyVersion ?? 1,
  };

  const inserted = await dbSession.db.insert(agentApprovals).values(row).onConflictDoNothing().returning({ id: agentApprovals.id });
  if (inserted.length) return row;
  const existing = await findByStep(dbSession, request.organizationId, request.taskId, request.stepIndex);
  if (existing) return existing;
  throw new Error("Could not open an approval request for this step.");
}

async function findByStep(dbSession: DbSession, organizationId: string, taskId: string, stepIndex: number): Promise<ApprovalRecord | null> {
  const [row] = await dbSession.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.organizationId, organizationId), eq(agentApprovals.taskId, taskId), eq(agentApprovals.stepIndex, stepIndex)))
    .limit(1);
  return (row as ApprovalRecord | undefined) ?? null;
}

export async function getApproval(dbSession: DbSession, organizationId: string, approvalId: string): Promise<ApprovalRecord | null> {
  const [row] = await dbSession.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.organizationId, organizationId)))
    .limit(1);
  return (row as ApprovalRecord | undefined) ?? null;
}

/**
 * The most recent approval opened for a task, whatever its status.
 *
 * The resume path needs the *decided* one, not a pending one: it carries the
 * step index the proposal was made at, which is what makes the retried
 * idempotency key match the original. Reading it back beats storing the
 * pending call anywhere else, because the transcript already holds the real
 * arguments and this row already holds the decision.
 */
export async function latestApprovalForTask(dbSession: DbSession, organizationId: string, taskId: string): Promise<ApprovalRecord | null> {
  const [row] = await dbSession.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.organizationId, organizationId), eq(agentApprovals.taskId, taskId)))
    .orderBy(desc(agentApprovals.stepIndex))
    .limit(1);
  return (row as ApprovalRecord | undefined) ?? null;
}

export async function listPendingApprovals(dbSession: DbSession, organizationId: string, limit = 50, taskIds?: string[]): Promise<ApprovalRecord[]> {
  const rows = await dbSession.db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.organizationId, organizationId), eq(agentApprovals.status, "pending"), taskIds ? inArray(agentApprovals.taskId, taskIds) : undefined))
    .orderBy(desc(agentApprovals.requestedAt))
    .limit(limit);
  return rows as ApprovalRecord[];
}

export type DecisionOutcome =
  | { ok: true; approval: ApprovalRecord; complete: boolean }
  | { ok: false; reason: "not_found" | "already_decided" | "expired" | "self_approval" | "not_an_approver" | "duplicate_approver" };

/**
 * Records a decision.
 *
 * Three refusals, all deterministic:
 *
 * - **already decided** — the `status = pending` clause in the update makes a
 *   double decision a zero-row write rather than an overwrite, so two people
 *   clicking at once cannot produce a "rejected" row that later reads as
 *   approved.
 * - **expired** — checked against the wall clock, not against whether a sweep
 *   has run, so a request nobody swept is still un-executable.
 * - **self-approval** — the user who caused the task to be created cannot
 *   approve its own critical action. Separation of duties is the reason a
 *   human gate exists at all; letting the requester close it makes the gate
 *   decorative. Applies to `critical` only, so a high-risk draft send does not
 *   need a second person present.
 */
export async function decideApproval(dbSession: DbSession,
  organizationId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  decidedByUserId: string,
  requestedByUserId: string,
  deciderRole: WorkspaceRole,
  note?: string
): Promise<DecisionOutcome> {
  await dbSession.db.execute(sql`select id from ${agentApprovals} where ${agentApprovals.id} = ${approvalId} for no key update`);
  const approval = await getApproval(dbSession, organizationId, approvalId);
  if (!approval) return { ok: false, reason: "not_found" };

  const authority = await dbSession.db.execute<{ allowed: boolean }>(sql`
    select aval_private.can_decide_approval(${organizationId}, ${approvalId}) as allowed
  `);
  if (authority.rows[0]?.allowed !== true) return { ok: false, reason: "not_an_approver" };

  const guard = canDecide(approval, decision, decidedByUserId, requestedByUserId, deciderRole);
  if (!guard.ok) {
    // Expiry is also written through, so the row stops appearing as pending —
    // but the refusal above does not depend on that write succeeding.
    if (guard.reason === "expired") {
      await dbSession.db.update(agentApprovals).set({ status: "expired" }).where(eq(agentApprovals.id, approvalId)).catch(() => {});
    }
    return { ok: false, reason: guard.reason };
  }

  const now = new Date();
  const inserted = await dbSession.db.insert(agentApprovalDecisions).values({
    id: crypto.randomUUID(),
    approvalId,
    organizationId,
    userId: decidedByUserId,
    decision,
    note: note ?? null,
    createdAt: now,
  }).onConflictDoNothing().returning({ id: agentApprovalDecisions.id });
  if (!inserted.length) return { ok: false, reason: "duplicate_approver" };

  if (decision === "rejected") {
    await dbSession.db.update(agentApprovals)
      .set({ status: "rejected", decidedAt: now, decidedByUserId, decisionNote: note ?? null })
      .where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.status, "pending")));
    const updated = await getApproval(dbSession, organizationId, approvalId);
    if (!updated || updated.status !== "rejected") return { ok: false, reason: "already_decided" };
    return { ok: true, approval: updated, complete: true };
  }

  const [count] = await dbSession.db.select({ value: sql<number>`count(*)` })
    .from(agentApprovalDecisions)
    .where(and(eq(agentApprovalDecisions.approvalId, approvalId), eq(agentApprovalDecisions.decision, "approved")));
  const approvalsReceived = Number(count?.value ?? 0);
  const complete = approvalsReceived >= approval.requiredApprovals;
  await dbSession.db.update(agentApprovals).set({
    approvalsReceived,
    ...(complete ? { status: "approved", decidedAt: now, decidedByUserId, decisionNote: note ?? null } : {}),
  }).where(and(eq(agentApprovals.id, approvalId), eq(agentApprovals.status, "pending")));

  const updated = await getApproval(dbSession, organizationId, approvalId);
  if (!updated) return { ok: false, reason: "already_decided" };
  if (complete && updated.status !== "approved") return { ok: false, reason: "already_decided" };
  if (!complete && updated.status !== "pending") return { ok: false, reason: "already_decided" };
  return { ok: true, approval: updated, complete };
}

/** Marks one workspace's overdue requests expired; the cron also sweeps globally. */
export async function expireStaleApprovals(dbSession: DbSession, organizationId: string): Promise<void> {
  await dbSession.db
    .update(agentApprovals)
    .set({ status: "expired" })
    .where(and(eq(agentApprovals.organizationId, organizationId), eq(agentApprovals.status, "pending"), lt(agentApprovals.expiresAt, new Date())))
    .catch((err) => console.error("agent_approval_expiry_failed", err));
}

/** Scheduled-worker sweep across workspaces. It changes only overdue pending rows. */
export async function expireAllStaleApprovals(dbSession: DbSession): Promise<number> {
  const result = await dbSession.db
    .update(agentApprovals)
    .set({ status: "expired" })
    .where(and(eq(agentApprovals.status, "pending"), lt(agentApprovals.expiresAt, new Date())));
  const value = result as { rowCount?: number | null; rowsAffected?: number; meta?: { changes?: number }; changes?: number };
  return value.rowCount ?? value.rowsAffected ?? value.meta?.changes ?? value.changes ?? 0;
}

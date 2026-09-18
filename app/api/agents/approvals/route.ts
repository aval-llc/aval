import { withApiSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { decideApproval, expireStaleApprovals, getApproval, listPendingApprovals } from "@/lib/agents/approvals";
import { goalPlan } from "@/lib/agents/goal-plan";
import { getTask } from "@/lib/agents/tasks";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { runTaskInBackground, type AgentWorkerEnv } from "@/lib/agents/worker";

/**
 * The human half of §12: actions an agent prepared and is not allowed to take.
 *
 * GET lists what is waiting, with the evidence the agent assembled, so the
 * approver sees what they are deciding rather than a tool name. POST records
 * the decision and un-parks the task either way — an approval lets the action
 * run, a rejection lets the agent continue and report that it was refused.
 *
 * Guests cannot decide anything. Every signed-out visitor is the same subject,
 * so "a person approved this" would be a claim about nobody.
 */

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  // The cron is authoritative; this opportunistic sweep keeps a just-expired
  // request from appearing actionable between minute ticks.
  await expireStaleApprovals(dbSession, identity.organizationId);

  const rootId = new URL(request.url).searchParams.get("rootTaskId");
  let taskIds: string[] | undefined;
  if (rootId) {
    const plan = await goalPlan(dbSession, identity.organizationId, rootId);
    if (!plan) return Response.json({ error: "No such task" }, { status: 404 });
    taskIds = [rootId, ...plan.nodes.map(node => node.id)];
  }
  // Apply the task scope before the inbox limit, so a busy workspace cannot
  // hide this conversation's pending decision behind unrelated approvals.
  const pending = await listPendingApprovals(dbSession, identity.organizationId, 50, taskIds);
  return Response.json({
    approvals: pending.map((approval) => ({
      id: approval.id,
      taskId: approval.taskId,
      tool: approval.toolName,
      risk: approval.riskLevel,
      tier: approval.tier,
      amountCents: approval.amountCents,
      currency: approval.currency,
      evidence: safeParse(approval.evidenceJson),
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      requiredApprovals: approval.requiredApprovals,
      approvalsReceived: approval.approvalsReceived,
    })),
  }, { headers: { "cache-control": "no-store" } });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (isGuestIdentity(identity)) {
    return Response.json({ error: "Sign in to approve or reject an agent action." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { approvalId?: string; decision?: string; note?: string };
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
  if (!approvalId || !decision) return Response.json({ error: "approvalId and decision ('approved' | 'rejected') are required" }, { status: 400 });

  const approval = await getApproval(dbSession, identity.organizationId, approvalId);
  if (!approval) return Response.json({ error: "No such approval" }, { status: 404 });
  const task = await getTask(dbSession, identity.organizationId, approval.taskId);
  if (!task) return Response.json({ error: "No such task" }, { status: 404 });

  const outcome = await decideApproval(dbSession,
    identity.organizationId,
    approvalId,
    decision,
    identity.userId,
    // Separation of duties is checked against the user the task runs on
    // behalf of, not against whoever happens to be calling.
    task.userId,
    // Resolved from membership on this request, so access revoked since the
    // session cookie was issued takes effect now rather than in thirty days.
    identity.role,
    typeof body.note === "string" ? body.note.slice(0, 400) : undefined,
  );

  if (!outcome.ok) {
    const status = outcome.reason === "not_found" ? 404
      : outcome.reason === "self_approval" || outcome.reason === "not_an_approver" ? 403
      : 409;
    return Response.json({ error: MESSAGES[outcome.reason] }, { status });
  }

  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "approval_decided", label: `${approval.toolName}:${decision}`, payloadDigest: await digestPayload(approvalId), count: approval.stepIndex },
  ]);

  // A first decision on an elevated action leaves it parked until a second,
  // distinct person approves. Rejection is immediately final.
  if (outcome.complete) {
    const work = dbSession.afterCommit(() => withWorkerOrganizationSession(identity.organizationId, (workerSession) =>
      runTaskInBackground(workerSession, env as unknown as AgentWorkerEnv, identity.organizationId, task.id, "approval"),
    )).catch((error) => console.error("agent_approval_background_failed", { approvalId, taskId: task.id, error }));
    getRequestExecutionContext()?.waitUntil(work);
  }
  return Response.json({
    id: approvalId,
    decision,
    complete: outcome.complete,
    approvalsReceived: outcome.approval.approvalsReceived,
    requiredApprovals: outcome.approval.requiredApprovals,
    task: { id: task.id, status: task.status, resumeScheduled: outcome.complete },
  }, { headers: { "cache-control": "no-store" } });
}

const MESSAGES = {
  not_found: "No such approval",
  already_decided: "This action was already decided.",
  expired: "This approval request expired. The agent must propose the action again.",
  self_approval: "A critical action cannot be approved by the person whose task proposed it.",
  not_an_approver: "Approving agent actions requires the approver or owner role in this workspace.",
  duplicate_approver: "Your decision is already recorded. An elevated action needs another distinct approver.",
} as const;

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

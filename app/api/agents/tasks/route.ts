import { withApiSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";
import { createTask, listTasks, DEFAULT_MAX_STEPS } from "@/lib/agents/tasks";
import { roleForPersona } from "@/lib/agents/permissions";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { runTaskInBackground, type AgentWorkerEnv } from "@/lib/agents/worker";

/**
 * Durable agent tasks — the goal-shaped counterpart to /api/assistant/ask.
 *
 * POST persists and returns a task immediately. `waitUntil` starts it without
 * holding the HTTP response open, and the minute cron is the recovery path if
 * that isolate disappears. Browser polling only observes state.
 *
 * Tasks require authentication and are scoped to the caller's organization.
 */

const MAX_GOAL_CHARS = 1200;

/** Tighter than the assistant's daily cap because a task fans out to many model calls, and unlike that cap it applies to BYO-credential orgs too — this limits load on Aval's own database, not spend on Aval's model account. */
const CREATE_RULE = { limit: 20, windowMs: 60 * 60 * 1000 };

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  const tasks = await listTasks(dbSession, identity.organizationId);
  return Response.json({
    tasks: tasks.map((task) => ({
      id: task.id,
      agentId: task.agentId,
      goal: task.goal,
      status: task.status,
      steps: { used: task.stepCount, max: task.maxSteps },
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      error: task.error,
    })),
  }, { headers: { "cache-control": "no-store" } });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  // Scoped to the org for a signed-in workspace and to the IP for a guest —
  // every guest shares one org, so an org-scoped limit there would let one
  // visitor exhaust the allowance for all of them.
  const scope = isGuestIdentity(identity) ? `agent_task:ip:${clientIp(request)}` : `agent_task:org:${identity.organizationId}`;
  if (await isRateLimited(dbSession, scope, CREATE_RULE)) {
    return Response.json({ error: "Too many agent tasks started recently. Try again shortly." }, { status: 429 });
  }
  await recordAttempt(dbSession, scope);

  const body = ((await request.json().catch(() => ({}))) ?? {}) as { goal?: string; agentId?: string; maxSteps?: number };
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, MAX_GOAL_CHARS) : "";
  if (!goal) return Response.json({ error: "A goal is required" }, { status: 400 });

  // An unknown agent id resolves to the read-only `custom` envelope rather
  // than to the broad `general` one, so a typo narrows authority.
  const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : "general";
  const maxSteps = Number.isInteger(body.maxSteps) ? Math.min(Math.max(body.maxSteps as number, 2), DEFAULT_MAX_STEPS * 2) : DEFAULT_MAX_STEPS * 2;

  const task = await createTask(dbSession, { check: {kind:"plan"}, organizationId: identity.organizationId, userId: identity.userId, agentId, goal, maxSteps });
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "task_created", label: roleForPersona(agentId), payloadDigest: await digestPayload(goal), count: task.maxSteps },
  ]);

  const work = dbSession.afterCommit(() => withWorkerOrganizationSession(identity.organizationId, (workerSession) =>
    runTaskInBackground(workerSession, env as unknown as AgentWorkerEnv, identity.organizationId, task.id, "request"),
  )).catch((error) => console.error("agent_task_request_background_failed", { taskId: task.id, error }));
  getRequestExecutionContext()?.waitUntil(work);
  return Response.json({ id: task.id, taskId: task.id, status: "QUEUED", stepsRun: 0 }, { status: 202, headers: { "cache-control": "no-store" } });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

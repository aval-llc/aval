import { withApiSession } from "@/lib/api/with-session";
import { openWork } from "@/lib/agents/open-work";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { clientIp, isRateLimited, recordAttempt } from "@/lib/security/rate-limit";
import { listTasks } from "@/lib/agents/tasks";

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
  const params = new URL(request.url).searchParams;
  const ownerId = params.get("employeeId") || params.get("agentId");
  const owner = ownerId ? { id: ownerId, employee: !!params.get("employeeId") } : undefined;
  const tasks = await listTasks(dbSession, identity.organizationId, owner ? 100 : 25, owner);
  return Response.json({
    tasks: tasks.map((task) => ({
      id: task.id,
      agentId: task.agentId,
      employeeId: task.employeeId,
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

  const body = ((await request.json().catch(() => ({}))) ?? {}) as { goal?: string; agentId?: string; employeeId?: string; maxSteps?: number; chatMessageId?: string; context?: { view?: string; moduleLabel?: string; moduleSnapshot?: string } };
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, MAX_GOAL_CHARS) : "";
  if (!goal) return Response.json({ error: "A goal is required" }, { status: 400 });

  // An unknown agent id resolves to the read-only `custom` envelope rather
  // than to the broad `general` one, so a typo narrows authority.
  const opened = await openWork(dbSession, identity, env, {
    goal,
    agentId: typeof body.agentId === "string" ? body.agentId : undefined,
    employeeId: typeof body.employeeId === "string" ? body.employeeId : undefined,
    maxSteps: body.maxSteps,
    chatMessageId: typeof body.chatMessageId === "string" ? body.chatMessageId : null,
    context: body.context,
    origin: "task_api",
  });
  if (!opened.ok) return Response.json({ error: opened.error }, { status: opened.status });
  return Response.json({ id: opened.taskId, taskId: opened.taskId, status: "QUEUED", stepsRun: 0 }, { status: 202, headers: { "cache-control": "no-store" } });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

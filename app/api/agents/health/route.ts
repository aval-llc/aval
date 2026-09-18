import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { getAgentHealth, getGlobalAgentHealth } from "@/lib/agents/health";
import { canManageFinancialPolicy } from "@/lib/agents/execution-policy";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const configuredToken = (env as unknown as { AGENT_HEALTH_TOKEN?: string }).AGENT_HEALTH_TOKEN;
  const suppliedToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (configuredToken && constantTimeEqual(configuredToken, suppliedToken)) {
    const health = await getGlobalAgentHealth(dbSession);
    return present(health, "global", health.assessment.status === "critical" ? 503 : 200);
  }

  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);
  if (isGuestIdentity(identity) || !(await canManageFinancialPolicy(dbSession, identity.organizationId, identity.userId))) {
    return Response.json({ error: "Workspace owner access required" }, { status: 403 });
  }
  const health = await getAgentHealth(dbSession, identity.organizationId);
  return present(health, "workspace", 200);
}

function present(health: Awaited<ReturnType<typeof getAgentHealth>>, scope: "global" | "workspace", status: number) {
  return Response.json({
    scope,
    status: health.assessment.status,
    checks: health.assessment.checks,
    metrics: {
      lastWorkerCompletedAt: health.snapshot.lastWorkerCompletedAt,
      oldestQueuedAt: health.snapshot.oldestQueuedAt,
      expiredRunningLeases: health.snapshot.expiredRunningLeases,
      failedTasks24h: health.snapshot.failedTasks24h,
      pendingApprovals: health.snapshot.pendingApprovals,
      reconciliationDiscrepancies: health.snapshot.reconciliationDiscrepancies,
      reconciliationOverdue: health.snapshot.reconciliationOverdue,
    },
  }, { status, headers: { "cache-control": "no-store" } });
}

function constantTimeEqual(expected: string, supplied: string): boolean {
  const length = Math.max(expected.length, supplied.length);
  let mismatch = expected.length ^ supplied.length;
  for (let index = 0; index < length; index++) {
    mismatch |= (expected.charCodeAt(index) || 0) ^ (supplied.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export const GET = withApiSession(GETWithSession);

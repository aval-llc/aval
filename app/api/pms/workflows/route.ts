/**
 * GET/POST /api/pms/workflows — what Aval knows how to drive, and how far it is proven.
 *
 * Deliberately an *inspection* surface with a lifecycle control on it, and not
 * an editor. A workflow's steps are how Aval drives somebody's property
 * management system as their own signed-in user; letting a workspace rewrite
 * them from a settings screen would make every customer responsible for
 * something Aval should solve once, and would turn a reviewed artefact into a
 * macro recorder. So the steps are not returned, there is no endpoint that
 * changes them, and the only mutation here is a status transition.
 *
 * What a reader gets instead is everything needed to judge a workflow without
 * being able to alter it: which capability it implements, which access mode it
 * drives, how the effect is verified, how a repeat is recognised, what happens
 * when it cannot run, how far it has actually been exercised, when it last
 * replayed, and what is known to be wrong with it.
 *
 * The division of labour the directive asks for falls out of the data rather
 * than a second permission system. A row Aval ships is `shipped: true`, seeded
 * by migration and read-only at runtime — promoting one is a deployment. A
 * workspace's own row is promoted by one of its administrators, and row-level
 * security is what actually enforces that, so the result is reported from what
 * the database did.
 */

import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { roleFor } from "@/lib/organizations/membership";
import { canManagePolicy } from "@/lib/organizations/roles";
import { withApiSession } from "@/lib/api/with-session";
import { pmsProvider } from "@/lib/pms/providers/index.ts";
import {
  listWorkflows,
  promoteFlow,
  WORKFLOW_STATUSES,
  type WorkflowStatus,
} from "@/lib/pms/flows.ts";

function isStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider") ?? undefined;
  if (provider && !pmsProvider(provider)) {
    return Response.json({ error: "Unknown provider" }, { status: 404 });
  }

  await ensureOrganization(dbSession, identity);
  const [workflows, role] = await Promise.all([
    listWorkflows(dbSession, identity.organizationId, provider),
    roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null),
  ]);
  const canEdit = Boolean(role && canManagePolicy(role)) && !isGuestIdentity(identity);

  return Response.json({
    workflows: workflows.map((flow) => ({
      id: flow.id,
      provider: flow.provider,
      providerName: pmsProvider(flow.provider)?.displayName ?? flow.provider,
      capability: flow.action,
      version: flow.version,
      accessMode: flow.accessMode,
      status: flow.status,
      certification: flow.certification,
      riskClass: flow.riskClass,
      requiredRole: flow.requiredRole,
      verificationStrategy: flow.verificationStrategy,
      reconciliationStrategy: flow.reconciliationStrategy,
      fallback: flow.fallback,
      knownIssues: flow.knownIssues,
      lastTestedAt: flow.lastReplayAt?.toISOString() ?? null,
      lastTestOk: flow.lastReplayOk,
      consecutiveFailures: flow.consecutiveFailures,
      promotedAt: flow.promotedAt?.toISOString() ?? null,
      shipped: flow.shipped,
      // Said per row rather than once for the page, because the answer differs
      // per row: a workspace administrator may promote their own workflow and
      // not the one Aval ships.
      canPromote: canEdit && !flow.shipped,
    })),
    canEdit,
  });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) {
    return Response.json({ error: "A guest session cannot change a workflow" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "A workflow is identified by its id" }, { status: 400 });
  if (!isStatus(body.status)) {
    return Response.json({ error: "Unknown workflow status" }, { status: 422 });
  }

  await ensureOrganization(dbSession, identity);
  const role = await roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null);
  if (!role || !canManagePolicy(role)) {
    return Response.json({ error: "Only a workspace administrator can change a workflow" }, { status: 403 });
  }

  // Everything else — the transition table, shipped rows, ownership, the
  // certification bar — is decided in `promoteFlow`, so this route cannot
  // disagree with the runtime about what is allowed.
  const result = await promoteFlow(dbSession, identity.organizationId, id, identity.userId, body.status);
  return result.ok
    ? Response.json({ id, status: result.status, retired: result.retired })
    : Response.json({ error: result.reason }, { status: 422 });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

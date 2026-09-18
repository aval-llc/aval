/**
 * GET  /api/pms/matrix  — the capability matrix for every connected PMS.
 * POST /api/pms/matrix  — enable or disable one action for this workspace.
 *
 * This is the surface a design partner is shown, so the wording carries weight.
 * An operator who reads "AppFolio terms prohibit automated writes" learns that
 * Aval read their contract, which is a better sales artifact than any feature
 * list. The same operator must never see that sentence when the real reason is
 * that Aval has not built the adapter yet.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { pmsWriteAuthorizations } from "@/db/postgres/schema";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { roleFor } from "@/lib/organizations/membership";
import { canManagePolicy } from "@/lib/organizations/roles";
import { connectedPmsProviders } from "@/lib/pms/assembly.ts";
import { resolveMatrix } from "@/lib/pms/capability.ts";
import { pmsProvider } from "@/lib/pms/providers/index.ts";
import { toolForAction } from "@/lib/pms/tool-map.ts";
import { withApiSession } from "@/lib/api/with-session";
import {
  isReadAction,
  MANDATORY_HUMAN_CHECKPOINT,
  PMS_ACTIONS,
  WORKFLOW_WRITE_DEFAULT,
  workflowFor,
  type PmsAction,
  type PmsWorkflow,
} from "@/lib/pms/types.ts";

const ALL_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat();

function isPmsAction(value: unknown): value is PmsAction {
  return typeof value === "string" && (ALL_ACTIONS as readonly string[]).includes(value);
}

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    await ensureOrganization(dbSession, identity);
    const providers = await connectedPmsProviders(dbSession, identity.organizationId);

    const rendered = await Promise.all(
      providers.map(async (providerId) => {
        const descriptor = pmsProvider(providerId);
        const matrix = await resolveMatrix(dbSession, identity.organizationId, providerId);
        return {
          provider: providerId,
          displayName: descriptor?.displayName ?? providerId,
          readMechanisms: descriptor?.read.mechanisms ?? [],
          writeMechanisms: descriptor?.write.mechanisms ?? [],
          runner: descriptor?.write.runner ?? null,
          // Surfaced so the settings page can say "clause last read on …" rather
          // than implying the citation is current. Absent means never verified.
          termsVerifiedAt: descriptor?.write.termsVerifiedAt ?? null,
          workflows: (Object.keys(PMS_ACTIONS) as PmsWorkflow[]).map((workflow) => ({
            workflow,
            writeDefault: WORKFLOW_WRITE_DEFAULT[workflow],
            actions: PMS_ACTIONS[workflow].map((action) => {
              const resolution = matrix.get(action);
              return {
                action,
                kind: isReadAction(action) ? "read" : "write",
                tool: toolForAction(action) ?? null,
                state: resolution?.state ?? "unavailable",
                reason: resolution?.reason ?? null,
                remediation: resolution?.remediation ?? null,
                owner: resolution?.owner ?? null,
                mechanism: resolution?.mechanism ?? null,
                mandatoryApproval: MANDATORY_HUMAN_CHECKPOINT.has(action),
                // Only `off` is one click away. Every other non-allow state
                // needs someone other than this operator to act first.
                actionable: resolution?.state === "off" || resolution?.state === "allow",
              };
            }),
          })),
        };
      }),
    );

    return Response.json({ providers: rendered });
  } catch (error) {
    return Response.json(
      { providers: [], storage: "unavailable", detail: error instanceof Error ? error.message : "D1 is unavailable" },
    );
  }
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  // A demo workspace must never be able to authorize a write into a real PMS.
  if (isGuestIdentity(identity)) return Response.json({ error: "Not available in the demo workspace" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const action = payload.action;
  const enabled = payload.enabled === true;
  const signedAuthorization = payload.signedAuthorization === true;
  const authorizationReference = typeof payload.authorizationReference === "string"
    ? payload.authorizationReference.slice(0, 500)
    : null;

  if (!pmsProvider(provider)) return Response.json({ error: "Unknown provider" }, { status: 400 });
  if (!isPmsAction(action)) return Response.json({ error: "Unknown action" }, { status: 400 });
  if (isReadAction(action)) {
    return Response.json({ error: "Reads are on for every workflow and are not configurable." }, { status: 400 });
  }

  // Enabling a write is an administrative act, not a preference: anyone who can
  // reach Settings should not be able to put their employer in breach of its PMS
  // contract. `canManagePolicy` is the existing owner-only gate on financial
  // limits and approval tiers, which is the same family of decision.
  const role = await roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null);
  if (!role || !canManagePolicy(role)) {
    return Response.json({ error: "Only the workspace owner can change PMS write authorization" }, { status: 403 });
  }

  const workflow = workflowFor(action);
  // A flagged-off workflow cannot be enabled by a toggle alone. The resolver
  // enforces this too; refusing here as well means the API cannot be used to
  // create a row the resolver will only ever read as `off`.
  if (enabled && WORKFLOW_WRITE_DEFAULT[workflow] === "off" && !signedAuthorization) {
    return Response.json(
      { error: `${workflow} writes require a countersigned authorization. Record who signed it and when.` },
      { status: 422 },
    );
  }
  if (enabled && WORKFLOW_WRITE_DEFAULT[workflow] === "none") {
    return Response.json({ error: "Reporting is read-only by design." }, { status: 422 });
  }

  const now = new Date();
  const [existing] = await dbSession.db
    .select({ id: pmsWriteAuthorizations.id, version: pmsWriteAuthorizations.version })
    .from(pmsWriteAuthorizations)
    .where(
      and(
        eq(pmsWriteAuthorizations.organizationId, identity.organizationId),
        eq(pmsWriteAuthorizations.provider, provider),
        eq(pmsWriteAuthorizations.action, action),
      ),
    )
    .limit(1);

  // Disabling suspends rather than deletes: who had once signed for this is
  // part of the audit trail, and dropping the row would drop that.
  const status = enabled ? "approved" : existing ? "suspended" : "draft";

  if (existing) {
    await dbSession.db
      .update(pmsWriteAuthorizations)
      .set({
        status,
        signedAuthorization,
        authorizationReference,
        version: existing.version + 1,
        approvedByUserId: enabled ? identity.userId : null,
        approvedAt: enabled ? now : null,
        updatedAt: now,
      })
      .where(eq(pmsWriteAuthorizations.id, existing.id));
  } else {
    await dbSession.db.insert(pmsWriteAuthorizations).values({
      id: crypto.randomUUID(),
      organizationId: identity.organizationId,
      provider,
      action,
      status,
      signedAuthorization,
      authorizationReference,
      version: 1,
      approvedByUserId: enabled ? identity.userId : null,
      approvedAt: enabled ? now : null,
      createdBy: identity.userId,
      createdAt: now,
      updatedAt: now,
    });
  }

  const matrix = await resolveMatrix(dbSession, identity.organizationId, provider);
  const resolution = matrix.get(action);
  return Response.json({
    provider,
    action,
    state: resolution?.state ?? "unavailable",
    reason: resolution?.reason ?? null,
  });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

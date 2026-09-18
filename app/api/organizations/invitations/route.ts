import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * Workspace invitations.
 *
 * There is no email service in this deployment, so POST returns the code once
 * and the owner shares it out of band. It is never readable again: only its
 * hash is stored, because an invitation grants standing access to a tenant's
 * data and is therefore a credential.
 */

import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { issueInvitation, listPendingInvitations, revokeInvitation } from "@/lib/organizations/membership";
import { canInvite, isWorkspaceRole } from "@/lib/organizations/roles";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { isRateLimited, recordAttempt } from "@/lib/security/rate-limit";

/** An invitation is a bearer credential, so issuing them is bounded per workspace. */
const ISSUE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to manage a workspace." }, { status: 403 });
  await ensureOrganization(dbSession, identity);
  if (!canInvite(identity.role)) return Response.json({ error: "Only the workspace owner can manage invitations." }, { status: 403 });
  return Response.json({ invitations: await listPendingInvitations(dbSession, identity.organizationId) }, { headers: { "cache-control": "no-store" } });
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to invite someone." }, { status: 403 });
  await ensureOrganization(dbSession, identity);
  if (!canInvite(identity.role)) return Response.json({ error: "Only the workspace owner can invite people." }, { status: 403 });

  const scope = `invite:${identity.organizationId}`;
  if (await isRateLimited(dbSession, scope, ISSUE_LIMIT)) {
    return Response.json({ error: "Too many invitations issued. Try again later." }, { status: 429 });
  }
  await recordAttempt(dbSession, scope);

  const body = (await request.json().catch(() => ({}))) as { role?: string };
  const role = isWorkspaceRole(body.role) ? body.role : "member";
  // Ownership is not transferable by invitation: a workspace has exactly one
  // owner, and handing that out through a shared code would be the easiest
  // possible way to lose a tenant.
  if (role === "owner") return Response.json({ error: "A workspace cannot be given a second owner by invitation." }, { status: 400 });

  const invitation = await issueInvitation(dbSession, { organizationId: identity.organizationId, role, createdByUserId: identity.userId });
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "invitation_issued", label: `role:${role}`, payloadDigest: await digestPayload(invitation.id), count: 0 },
  ]);
  return Response.json({
    id: invitation.id,
    // Shown exactly once. The stored row holds only a hash of it.
    code: invitation.code,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  }, { status: 201 });
}

async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to manage a workspace." }, { status: 403 });
  await ensureOrganization(dbSession, identity);
  if (!canInvite(identity.role)) return Response.json({ error: "Only the workspace owner can revoke invitations." }, { status: 403 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const revoked = await revokeInvitation(dbSession, identity.organizationId, id);
  if (!revoked) return Response.json({ error: "No such open invitation." }, { status: 404 });
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "invitation_revoked", label: "revoked", payloadDigest: await digestPayload(id), count: 0 },
  ]);
  return Response.json({ ok: true, invitations: await listPendingInvitations(dbSession, identity.organizationId) });
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);
export const DELETE = withApiSession(DELETEWithSession);

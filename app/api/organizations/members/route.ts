import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * Workspace membership. Reading the roster is open to anyone in the workspace
 * — knowing who else can see your data is not privileged — while changing it
 * belongs to the owner.
 */

import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { listMembers, removeMembership, roleFor, upsertMembership } from "@/lib/organizations/membership";
import { isWorkspaceRole, removalRefusal } from "@/lib/organizations/roles";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { memberProfileAvatars } from "@/lib/appearance-storage";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to see who is in a workspace." }, { status: 403 });
  await ensureOrganization(dbSession, identity);
  const members = await listMembers(dbSession, identity.organizationId);
  // Appearance is optional: the team stays available during a storage outage.
  const avatars = await memberProfileAvatars(dbSession, members.map((member) => member.userId)).catch(() => new Map());
  return Response.json({
    role: identity.role,
    members: members.map((member) => ({ ...member, profileAvatar: avatars.get(member.userId) ?? null })),
  }, { headers: { "cache-control": "no-store" } });
}

/** Changes an existing member's role. Adding someone is done by invitation, never here. */
async function PATCHWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to manage a workspace." }, { status: 403 });
  await ensureOrganization(dbSession, identity);

  const body = (await request.json().catch(() => ({}))) as { userId?: string; role?: string };
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId || !isWorkspaceRole(body.role)) {
    return Response.json({ error: "userId and role ('owner' | 'approver' | 'member') are required" }, { status: 400 });
  }
  // Only the owner role can grant approval authority, and it cannot be handed
  // out: transferring ownership is a separate, deliberate act.
  if (body.role === "owner") return Response.json({ error: "Ownership cannot be granted from here." }, { status: 400 });

  const targetRole = await roleFor(dbSession, userId, identity.organizationId);
  if (!targetRole) return Response.json({ error: "That person is not in this workspace." }, { status: 404 });
  const refusal = removalRefusal(identity.role, targetRole, identity.userId, userId);
  if (refusal === "not_permitted") return Response.json({ error: "Only the workspace owner can change roles." }, { status: 403 });
  if (targetRole === "owner") return Response.json({ error: "The owner's role cannot be changed." }, { status: 400 });

  await upsertMembership(dbSession, { organizationId: identity.organizationId, userId, role: body.role });
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "membership_changed", label: `role:${body.role}`, payloadDigest: await digestPayload(userId), count: 0 },
  ]);
  return Response.json({ ok: true, members: await listMembers(dbSession, identity.organizationId) });
}

async function DELETEWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) return Response.json({ error: "Sign in to manage a workspace." }, { status: 403 });
  await ensureOrganization(dbSession, identity);

  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });

  const targetRole = await roleFor(dbSession, userId, identity.organizationId);
  if (!targetRole) return Response.json({ error: "That person is not in this workspace." }, { status: 404 });

  const refusal = removalRefusal(identity.role, targetRole, identity.userId, userId);
  if (refusal) {
    const message = refusal === "not_permitted" ? "Only the workspace owner can remove people."
      : refusal === "cannot_remove_owner" ? "The workspace owner cannot be removed."
      : "You cannot remove yourself from a workspace you own.";
    return Response.json({ error: message }, { status: 403 });
  }

  const removed = await removeMembership(dbSession, identity.organizationId, userId);
  if (!removed) return Response.json({ error: "That person is not in this workspace." }, { status: 404 });
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "membership_changed", label: "removed", payloadDigest: await digestPayload(userId), count: 0 },
  ]);
  // Their session may still name this workspace; resolveMembership re-reads
  // membership per request, so the next call lands them back in their own.
  return Response.json({ ok: true, members: await listMembers(dbSession, identity.organizationId) });
}

export const GET = withApiSession(GETWithSession);
export const PATCH = withApiSession(PATCHWithSession);
export const DELETE = withApiSession(DELETEWithSession);

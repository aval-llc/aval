/**
 * Workspace membership: who is in an organization, and how someone joins one.
 *
 * The security-critical function here is `resolveMembership`. A session cookie
 * carries the workspace a user last chose, and that cookie lives for thirty
 * days — long enough for the membership behind it to be revoked. So the claim
 * in the cookie is treated as a *request*, never as authority: every request
 * re-reads membership and falls back to the user's own workspace if the claim
 * no longer holds. Nothing downstream needs to know the difference, which is
 * the point — a route that forgets to check would otherwise be a cross-tenant
 * read.
 */

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { accessGrants, organizationInvitations, organizationMembers, organizations, users } from "@/db/postgres/schema";
import { digestPayload } from "@/lib/audit/chain";
import { isWorkspaceRole, type WorkspaceRole } from "./roles.ts";

type EnterpriseRole = "org_admin" | "regional_manager" | "property_manager" | "approver" | "operator" | "viewer" | "owner_viewer";

const enterpriseRoleForWorkspaceRole: Record<WorkspaceRole, EnterpriseRole> = {
  owner: "org_admin",
  approver: "approver",
  member: "operator",
};

function workspaceRoleForGrants(roles: readonly string[]): WorkspaceRole | null {
  if (roles.includes("org_admin")) return "owner";
  if (roles.includes("approver")) return "approver";
  return roles.some((role) => ["regional_manager", "property_manager", "operator", "viewer", "owner_viewer"].includes(role)) ? "member" : null;
}

function activeGrantCondition(userId: string, organizationId?: string) {
  const now = new Date();
  return and(
    eq(accessGrants.principalId, userId),
    organizationId ? eq(accessGrants.organizationId, organizationId) : undefined,
    isNull(accessGrants.revokedAt),
    or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, now)),
  );
}

export interface Membership {
  organizationId: string;
  role: WorkspaceRole;
}

/**
 * The workspace and role a user actually holds for this request.
 *
 * `requested` is the workspace the session asked for. It is honoured only if
 * the user owns it or holds a membership row in it; otherwise the personal
 * workspace is returned, so a stale or tampered claim degrades to the user's
 * own data rather than failing the request or reaching someone else's.
 */
export async function resolveMembership(dbSession: DbSession, userId: string, personalOrganizationId: string, requested?: string | null): Promise<Membership> {
  const target = requested && requested !== personalOrganizationId ? requested : personalOrganizationId;
  const role = await roleFor(dbSession, userId, target);
  if (role) return { organizationId: target, role };
  const personalRole = await roleFor(dbSession, userId, personalOrganizationId);
  if (personalRole) return { organizationId: personalOrganizationId, role: personalRole };
  throw new Error("No active workspace access grant");
}

/** The user's role in this workspace, or null if they hold none. */
export async function roleFor(dbSession: DbSession, userId: string, organizationId: string): Promise<WorkspaceRole | null> {
  const grants = await dbSession.db.select({ role: accessGrants.role }).from(accessGrants)
    .where(activeGrantCondition(userId, organizationId));
  return workspaceRoleForGrants(grants.map((grant) => grant.role));
}

export interface MemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: Date | null;
  isOwner: boolean;
}

/** Everyone who can act in this workspace, owner first. */
export async function listMembers(dbSession: DbSession, organizationId: string): Promise<MemberRecord[]> {
  const db = dbSession.db;
  const rows = await db
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
      email: users.email,
      displayName: users.displayName,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId));

  const grants = await db.select({ principalId: accessGrants.principalId, role: accessGrants.role })
    .from(accessGrants)
    .where(and(
      eq(accessGrants.organizationId, organizationId),
      isNull(accessGrants.revokedAt),
      or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, new Date())),
    ));
  const grantsByPrincipal = new Map<string, string[]>();
  for (const grant of grants) grantsByPrincipal.set(grant.principalId, [...(grantsByPrincipal.get(grant.principalId) ?? []), grant.role]);

  const members: MemberRecord[] = rows.flatMap((row) => {
    const role = workspaceRoleForGrants(grantsByPrincipal.get(row.userId) ?? []);
    return role ? [{ userId: row.userId, email: row.email, displayName: row.displayName, role, joinedAt: row.joinedAt, isOwner: role === "owner" }] : [];
  });
  return members.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.email.localeCompare(b.email));
}

/** How many people in this workspace may decide an approval. */
export async function approverCount(dbSession: DbSession, organizationId: string): Promise<number> {
  const rows = await dbSession.db.select({ principalId: accessGrants.principalId }).from(accessGrants).where(and(
    eq(accessGrants.organizationId, organizationId),
    inArray(accessGrants.role, ["org_admin", "approver"]),
    isNull(accessGrants.revokedAt),
    or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, new Date())),
  ));
  return new Set(rows.map((row) => row.principalId)).size;
}

export async function upsertMembership(dbSession: DbSession, input: {
  organizationId: string;
  userId: string;
  role: WorkspaceRole;
  invitedByUserId?: string | null;
}): Promise<void> {
  const now = new Date();
  await dbSession.db
    .insert(organizationMembers)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      invitedByUserId: input.invitedByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: input.role, updatedAt: now },
    });
  const grantId = `grant_${input.organizationId}_${input.userId}`;
  await dbSession.db.insert(accessGrants).values({
    id: grantId,
    organizationId: input.organizationId,
    principalId: input.userId,
    role: enterpriseRoleForWorkspaceRole[input.role],
    organizationScope: true,
    ownershipEntityId: null,
    portfolioId: null,
    regionId: null,
    propertyId: null,
    capabilitiesJson: "[]",
    expiresAt: null,
    revokedAt: null,
    createdByPrincipalId: input.invitedByUserId ?? dbSession.identity.principalId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [accessGrants.organizationId, accessGrants.id],
    set: {
      role: enterpriseRoleForWorkspaceRole[input.role],
      organizationScope: true,
      ownershipEntityId: null,
      portfolioId: null,
      regionId: null,
      propertyId: null,
      expiresAt: null,
      revokedAt: null,
      updatedAt: now,
    },
  });
}

export async function removeMembership(dbSession: DbSession, organizationId: string, userId: string): Promise<boolean> {
  const now = new Date();
  await dbSession.db.update(accessGrants).set({ revokedAt: now, updatedAt: now }).where(and(
    eq(accessGrants.organizationId, organizationId),
    eq(accessGrants.principalId, userId),
    isNull(accessGrants.revokedAt),
  ));
  const removed = await dbSession.db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .returning({ id: organizationMembers.id });
  return removed.length > 0;
}

/** Every workspace this user can act in, so the switcher shows real options. */
export async function listWorkspacesForUser(dbSession: DbSession, userId: string, personalOrganizationId: string): Promise<Array<{ organizationId: string; name: string; role: WorkspaceRole; isPersonal: boolean }>> {
  const db = dbSession.db;
  const rows = await db
    .select({ organizationId: accessGrants.organizationId, role: accessGrants.role, name: organizations.name })
    .from(accessGrants)
    .innerJoin(organizations, eq(organizations.id, accessGrants.organizationId))
    .where(activeGrantCondition(userId));

  const grouped = new Map<string, { name: string; roles: string[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.organizationId) ?? { name: row.name, roles: [] };
    existing.roles.push(row.role);
    grouped.set(row.organizationId, existing);
  }
  const workspaces = Array.from(grouped, ([organizationId, value]) => ({
    organizationId,
    name: value.name,
    role: workspaceRoleForGrants(value.roles) ?? "member",
    isPersonal: organizationId === personalOrganizationId,
  }));
  return workspaces.sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name));
}

/* ── invitations ─────────────────────────────────────────────────────────── */

/** Long enough to share out of band, short enough that a leaked code expires. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssuedInvitation {
  id: string;
  /** Shown to the inviter exactly once. Only its hash is stored. */
  code: string;
  role: WorkspaceRole;
  expiresAt: Date;
}

export async function issueInvitation(dbSession: DbSession, input: {
  organizationId: string;
  role: WorkspaceRole;
  createdByUserId: string;
}): Promise<IssuedInvitation> {
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const id = crypto.randomUUID();
  await dbSession.db.insert(organizationInvitations).values({
    id,
    organizationId: input.organizationId,
    codeHash: await hashCode(code),
    role: input.role,
    createdByUserId: input.createdByUserId,
    expiresAt,
    acceptedByUserId: null,
    acceptedAt: null,
    revokedAt: null,
    createdAt: now,
  });
  return { id, code, role: input.role, expiresAt };
}

export type AcceptRefusal = "not_found" | "expired" | "already_accepted" | "revoked" | "already_member";

export async function acceptInvitation(dbSession: DbSession, code: string, userId: string): Promise<
  | { ok: true; organizationId: string; role: WorkspaceRole }
  | { ok: false; reason: AcceptRefusal }
> {
  if (userId !== dbSession.identity.principalId) throw new Error("Invitation subject does not match the authenticated principal");
  const result = await dbSession.db.execute<{ outcome: string; organization_id: string | null; granted_role: string | null }>(sql`
    select * from aval_private.redeem_invitation(${await hashCode(code)}, ${await digestPayload(userId)})
  `);
  const row = result.rows[0];
  if (row?.outcome === "accepted" && row.organization_id && isWorkspaceRole(row.granted_role)) {
    return { ok: true, organizationId: row.organization_id, role: row.granted_role };
  }
  const reason = row?.outcome;
  return { ok: false, reason: (["not_found", "expired", "already_accepted", "revoked", "already_member"] as const).includes(reason as AcceptRefusal) ? reason as AcceptRefusal : "not_found" };
}

export interface PendingInvitation {
  id: string;
  role: WorkspaceRole;
  createdAt: Date;
  expiresAt: Date;
}

/** Outstanding invitations, so an owner can see and revoke what is live. Codes are never returned. */
export async function listPendingInvitations(dbSession: DbSession, organizationId: string): Promise<PendingInvitation[]> {
  const rows = await dbSession.db
    .select({ id: organizationInvitations.id, role: organizationInvitations.role, createdAt: organizationInvitations.createdAt, expiresAt: organizationInvitations.expiresAt })
    .from(organizationInvitations)
    .where(and(
      eq(organizationInvitations.organizationId, organizationId),
      isNull(organizationInvitations.acceptedByUserId),
      isNull(organizationInvitations.revokedAt),
    ))
    .orderBy(desc(organizationInvitations.createdAt));
  return rows
    .filter((row) => row.expiresAt.getTime() > Date.now())
    .map((row) => ({ id: row.id, role: isWorkspaceRole(row.role) ? row.role : "member", createdAt: row.createdAt, expiresAt: row.expiresAt }));
}

export async function revokeInvitation(dbSession: DbSession, organizationId: string, invitationId: string): Promise<boolean> {
  const result = await dbSession.db
    .update(organizationInvitations)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(organizationInvitations.id, invitationId),
      eq(organizationInvitations.organizationId, organizationId),
      isNull(organizationInvitations.acceptedByUserId),
    ))
    .returning({ id: organizationInvitations.id });
  return result.length > 0;
}

/**
 * Crockford-style base32 over 20 random bytes: no vowels, so it cannot spell
 * anything, and no characters a person confuses when reading a code aloud.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const body = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `AVAL-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

/**
 * A code is a bearer credential, so the row holds only its digest. The lookup
 * is by exact hash rather than by scanning, so this is not a password check and
 * needs no work factor — an attacker who reads the table still cannot present a
 * code, and one who guesses is bounded by 32^20.
 */
async function hashCode(code: string): Promise<string> {
  const normalized = code.trim().toUpperCase();
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

import type { DbSession } from "@/db/postgres/session";
import type { AuthMode } from "@/app/components/auth-gate";
import { type WorkspaceRole } from "@/lib/organizations/roles";
import { roleFor } from "@/lib/organizations/membership";

export type ApiIdentity = {
  userId: string;
  email: string;
  displayName: string;
  organizationId: string;
  /**
   * What this user may do in `organizationId`. Resolved per request from
   * membership rather than carried in the session, so revoking access takes
   * effect on the next call instead of when a thirty-day cookie expires.
   */
  role: WorkspaceRole;
  source: AuthMode;
};

/**
 * The workspace every signed-out visitor shares.
 *
 * Deliberately a fixed literal rather than anything derived from the request:
 * a real account's org id is `org_${hash(userId)}`, so this constant cannot
 * collide with one. That is the whole isolation guarantee — open access can
 * never reach a customer's data because it never resolves to a customer's org.
 */
export const PUBLIC_DEMO_ORGANIZATION_ID = "org_public_demo";
export const PUBLIC_DEMO_USER_ID = "public-demo-guest";

/** True when this identity is the shared, signed-out workspace. */
export function isGuestIdentity(identity: Pick<ApiIdentity, "organizationId">): boolean {
  return identity.organizationId === PUBLIC_DEMO_ORGANIZATION_ID;
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function organizationIdForUser(userId: string): Promise<string> {
  return `org_${await digest(userId)}`;
}

export async function getApiIdentity(dbSession: DbSession, request: Request): Promise<ApiIdentity | null> {
  void request;
  const auth = dbSession.identity.auth;
  if (!auth) return null;
  const role = await roleFor(dbSession, auth.userId, dbSession.identity.organizationId);
  if (!role) return null;
  return {
    userId: auth.userId,
    email: auth.email,
    displayName: auth.displayName,
    organizationId: dbSession.identity.organizationId,
    role,
    source: auth.source,
  };
}

/** Same identity resolution for Server Components after the Worker envelope is established. */
export async function getPageIdentity(dbSession: DbSession): Promise<ApiIdentity | null> {
  return getApiIdentity(dbSession, new Request("https://aval.invalid/"));
}

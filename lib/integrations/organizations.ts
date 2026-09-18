import { eq } from "drizzle-orm";
import { upsertMembership } from "@/lib/organizations/membership";
import type { DbSession } from "@/db/postgres/session";
import { organizations } from "@/db/postgres/schema";
import type { ApiIdentity } from "./session";

// Split out from session.ts so page-level identity checks do not pull the
// organization bootstrap path into callers that only need the authenticated
// principal.
export async function ensureOrganization(dbSession: DbSession, identity: ApiIdentity) {
  const db = dbSession.db;
  const [existing] = await db.select().from(organizations).where(eq(organizations.id, identity.organizationId)).limit(1);
  if (existing) return existing;
  const now = new Date();
  const organization = {
    id: identity.organizationId,
    name: "Aval workspace",
    ownerUserId: identity.userId,
    activeModelProvider: null,
    defaultPersonaId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(organizations).values(organization).onConflictDoNothing();
  // Membership is descriptive; the matching access grant is the authority.
  await upsertMembership(dbSession, { organizationId: identity.organizationId, userId: identity.userId, role: "owner" });
  return organization;
}

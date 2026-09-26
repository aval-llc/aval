import { eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { organizations } from "@/db/postgres/schema";
import { EMPTY_PROFILE, normalizeProfile, type OperatingProfile } from "./operating-profile.ts";

/** The workspace's operating profile, normalized. A missing workspace reads as the empty profile. */
export async function getOperatingProfile(dbSession: DbSession, organizationId: string): Promise<OperatingProfile> {
  const [row] = await dbSession.db.select({ json: organizations.operatingProfileJson }).from(organizations)
    .where(eq(organizations.id, organizationId)).limit(1);
  if (!row) return EMPTY_PROFILE;
  try { return normalizeProfile(typeof row.json === "string" ? JSON.parse(row.json) : row.json); } catch { return EMPTY_PROFILE; }
}

/** Replaces the profile. Only known ids are kept; the version always moves forward. */
export async function setOperatingProfile(dbSession: DbSession, organizationId: string, input: unknown): Promise<OperatingProfile> {
  const current = await getOperatingProfile(dbSession, organizationId);
  const next = { ...normalizeProfile(input), version: current.version + 1 };
  await dbSession.db.update(organizations).set({ operatingProfileJson: JSON.stringify(next), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
  return next;
}

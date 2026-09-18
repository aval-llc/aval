import { inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { userAppearance } from "@/db/postgres/schema";
import { DEFAULT_APPEARANCE, parseAppearance, type AppearancePreferences, type AvatarSelection } from "./appearance";

export async function readAppearance(dbSession: DbSession, userId: string): Promise<AppearancePreferences> {
  const [row] = await dbSession.db.select({ preferences: userAppearance.preferences })
    .from(userAppearance).where(inArray(userAppearance.userId, [userId])).limit(1);
  if (!row) return DEFAULT_APPEARANCE;
  try { return parseAppearance(JSON.parse(row.preferences)) ?? DEFAULT_APPEARANCE; }
  catch { return DEFAULT_APPEARANCE; }
}

export async function writeAppearance(dbSession: DbSession, userId: string, preferences: AppearancePreferences) {
  await dbSession.db.insert(userAppearance).values({
    userId,
    preferences: JSON.stringify(preferences),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: userAppearance.userId,
    set: { preferences: JSON.stringify(preferences), updatedAt: new Date() },
  });
}

/** Call only with the authenticated workspace's roster; RLS verifies the roster again. */
export async function memberProfileAvatars(dbSession: DbSession, userIds: string[]): Promise<Map<string, AvatarSelection>> {
  const result = new Map<string, AvatarSelection>();
  for (let offset = 0; offset < userIds.length; offset += 50) {
    const ids = userIds.slice(offset, offset + 50);
    if (ids.length === 0) continue;
    const rows = await dbSession.db.select({ userId: userAppearance.userId, preferences: userAppearance.preferences })
      .from(userAppearance).where(inArray(userAppearance.userId, ids));
    for (const row of rows) {
      try {
        const profile = parseAppearance(JSON.parse(row.preferences))?.profile;
        if (profile) result.set(row.userId, profile);
      } catch { /* A malformed preference never prevents loading the team. */ }
    }
  }
  return result;
}

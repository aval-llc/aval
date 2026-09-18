import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { userOnboarding } from "@/db/postgres/schema";
import { DEFAULT_ONBOARDING, parseOnboarding, upgradeStoredOnboarding, type OnboardingState } from "./preferences";

export async function readOnboarding(dbSession: DbSession, userId: string, organizationId: string): Promise<OnboardingState> {
  const [row] = await dbSession.db.select().from(userOnboarding).where(and(eq(userOnboarding.userId, userId), eq(userOnboarding.organizationId, organizationId))).limit(1);
  if (!row) return structuredClone(DEFAULT_ONBOARDING);
  const parsed = parseOnboarding(upgradeStoredOnboarding({ preferences: JSON.parse(row.preferences), step: row.step, completed: row.completed, revision: row.revision, introSeen: row.introSeen }));
  if (!parsed) throw new Error("Invalid stored onboarding preferences");
  return parsed;
}

/** Optimistic concurrency prevents stale tabs from silently replacing choices. */
export async function writeOnboarding(dbSession: DbSession, userId: string, organizationId: string, state: OnboardingState): Promise<OnboardingState | null> {
  const next = { ...state, revision: state.revision + 1 };
  const values = { preferences: JSON.stringify(state.preferences), step: state.step, completed: state.completed, revision: next.revision, updatedAt: new Date() };
  const rows = state.revision === 0
    ? await dbSession.db.insert(userOnboarding).values({ userId, organizationId, ...values, introSeen: state.introSeen === true }).onConflictDoNothing().returning({ revision: userOnboarding.revision, introSeen: userOnboarding.introSeen })
    : await dbSession.db.update(userOnboarding).set({ ...values, introSeen: sql`${userOnboarding.introSeen} OR ${state.introSeen === true ? 1 : 0}` }).where(and(eq(userOnboarding.userId, userId), eq(userOnboarding.organizationId, organizationId), eq(userOnboarding.revision, state.revision))).returning({ revision: userOnboarding.revision, introSeen: userOnboarding.introSeen });
  return rows.length ? { ...next, introSeen: rows[0].introSeen } : null;
}

export async function onboardingContext(dbSession: DbSession, userId: string, organizationId: string): Promise<string> {
  try {
    const state = await readOnboarding(dbSession, userId, organizationId);
    if (!state.completed) return "";
    return `\nUser's onboarding choices (these do not grant tool permissions or prove any app is connected; autonomy controls the server-enforced execution workflow): ${JSON.stringify(state.preferences)}. Prioritize their selected focus areas. All existing approval and execution policies still apply.`;
  } catch { return ""; }
}

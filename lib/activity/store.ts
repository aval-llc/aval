import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { workspaceUsage } from "@/db/postgres/schema";
export async function recordActivity(dbSession: DbSession,
  organizationId: string,
  userId: string,
  now = new Date()
) {
  const minute = Math.floor(+now / 60000);
  await dbSession.db
    .insert(workspaceUsage)
    .values({ id: crypto.randomUUID(), organizationId, userId, minute })
    .onConflictDoNothing();
  // Keep a little over a year of minute buckets; no content, keystrokes, or page names are recorded.
  await dbSession.db
    .delete(workspaceUsage)
    .where(
      and(
        eq(workspaceUsage.organizationId, organizationId),
        eq(workspaceUsage.userId, userId),
        lt(workspaceUsage.minute, minute - 367 * 1440),
      ),
    );
}
export async function readActivity(dbSession: DbSession,
  organizationId: string,
  userId: string,
  now = new Date()
) {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const since = new Date(+today - 364 * 86400000);
  const day = sql<string>`to_char(to_timestamp(${workspaceUsage.minute} * 60) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const days = await dbSession.db
    .select({ date: day, minutes: sql<number>`count(*)` })
    .from(workspaceUsage)
    .where(
      and(
        eq(workspaceUsage.organizationId, organizationId),
        eq(workspaceUsage.userId, userId),
        gte(workspaceUsage.minute, Math.floor(+since / 60000)),
      ),
    )
    .groupBy(day)
    .orderBy(day);
  return {
    today: today.toISOString().slice(0, 10),
    since: since.toISOString().slice(0, 10),
    days,
  };
}

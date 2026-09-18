/**
 * Sliding-window rate limiting, backed by D1 rather than in-memory state —
 * a Worker isolate can be recycled between requests, so an in-memory
 * counter would silently reset and stop protecting anything. Same idiom as
 * lib/ask-aval/usage.ts's daily model-call cap: one row per attempt,
 * counted by querying rows within the window.
 *
 * Exists to close two real abuse paths: unlimited free-account creation
 * (each new org gets its own token allowance, so this is a direct route to
 * free, unmetered Claude API spend) and unlimited login attempts against a
 * known email (password brute-forcing).
 */

import { and, eq, gte, lt } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { rateLimitHits } from "@/db/postgres/schema";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * True if `scopeKey` has already hit its limit within the window — check
 * BEFORE doing the guarded work, then call recordAttempt regardless of
 * outcome. Also opportunistically deletes this scope's own rows that have
 * aged out of the window: this app has no cron/scheduled worker to sweep
 * the table on a timer, so without this the table would grow forever.
 * Scoped to just this key (not a full-table sweep) so it stays cheap on
 * every request rather than adding an unrelated table scan.
 */
export async function isRateLimited(dbSession: DbSession, scopeKey: string, rule: RateLimitRule): Promise<boolean> {
  const db = dbSession.db;
  const organizationId = dbSession.identity.organizationId;
  const windowStart = new Date(Date.now() - rule.windowMs);
  await db.delete(rateLimitHits).where(and(
    eq(rateLimitHits.organizationId, organizationId),
    eq(rateLimitHits.scopeKey, scopeKey),
    lt(rateLimitHits.createdAt, windowStart),
  )).catch(() => {});
  const hits = await db
    .select({ id: rateLimitHits.id })
    .from(rateLimitHits)
    .where(and(
      eq(rateLimitHits.organizationId, organizationId),
      eq(rateLimitHits.scopeKey, scopeKey),
      gte(rateLimitHits.createdAt, windowStart),
    ));
  return hits.length >= rule.limit;
}

export async function recordAttempt(dbSession: DbSession, scopeKey: string): Promise<void> {
  try {
    await dbSession.db.insert(rateLimitHits).values({
      id: crypto.randomUUID(),
      organizationId: dbSession.identity.organizationId,
      scopeKey,
      createdAt: new Date(),
    });
  } catch (err) {
    // Fails open on a storage hiccup — a missed rate-limit row degrades
    // throttling for one request, not availability for a real user.
    console.error("rate_limit_record_failed", scopeKey, err);
  }
}

/** The real client IP behind Cloudflare's edge — set by Cloudflare itself and not something a client request can override, unlike X-Forwarded-For. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { recentAuditEntries, verifyOrganizationChain } from "@/lib/audit/log";

/**
 * GET /api/audit
 *
 * Re-verifies this workspace's answer audit chain and returns the verdict,
 * per-kind totals, and the most recent entries.
 *
 * The verification is recomputed from the stored rows on every request rather
 * than cached — a cached "verified" flag would be exactly the assertion an
 * auditor cannot check, which is the thing this endpoint exists to avoid.
 *
 * Entries carry digests only, so this response never exposes tool output or
 * answer text (see lib/audit/chain.ts). It is scoped to the caller's own
 * organization like every other row in this app.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const limitParam = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 200) : 50;

  try {
    const [report, entries] = await Promise.all([
      verifyOrganizationChain(dbSession, identity.organizationId),
      recentAuditEntries(dbSession, identity.organizationId, limit),
    ]);
    return Response.json({ ...report, entries });
  } catch (error) {
    console.error("audit_verify_failed", error);
    return Response.json({ error: "Could not verify the audit trail." }, { status: 502 });
  }
}

export const GET = withApiSession(GETWithSession);

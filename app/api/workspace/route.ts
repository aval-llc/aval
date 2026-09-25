import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";

/**
 * Lightweight facts about the caller's workspace. Currently just its creation
 * date, which the Overview hero turns into "day N with Aval". Kept as its own
 * fetch rather than server-rendered into the page so the dashboard route
 * doesn't need the D1 binding just to draw a greeting.
 */
/**
 * @deprecated Not a portfolio or operational data source.
 *
 * This returns the workspace's creation date and nothing else. It was read by
 * the dashboard as though it were a data source, which it has never been. The
 * canonical read model for work, waits, approvals, evidence and operational
 * counts is `lib/agents/read-model.ts`; portfolio records come from the
 * normalized operations tables.
 *
 * Retained because the onboarding surface uses the creation date. Do not add
 * fields here — add them to the read model.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const organization = await ensureOrganization(dbSession, identity);
  return Response.json({ createdAt: organization.createdAt.toISOString() }, { headers: { deprecation: "true", link: "<lib/agents/read-model.ts>; rel=\"successor-version\"" } });
}

export const GET = withApiSession(GETWithSession);

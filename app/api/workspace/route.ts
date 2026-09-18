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
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const organization = await ensureOrganization(dbSession, identity);
  return Response.json({ createdAt: organization.createdAt.toISOString() });
}

export const GET = withApiSession(GETWithSession);

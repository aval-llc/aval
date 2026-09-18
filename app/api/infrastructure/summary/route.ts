import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { summarizeOrganizationUtilities } from "@/lib/infrastructure/summary";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const summary = await summarizeOrganizationUtilities(dbSession, identity.organizationId);
  return Response.json({ summary });
}

export const GET = withApiSession(GETWithSession);

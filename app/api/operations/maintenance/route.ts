import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET /api/operations/maintenance
 *
 * The Maintenance tab's summary: SLA compliance by priority, category
 * breakdown, vendor scorecards, and the callback links a person still needs to
 * confirm.
 */

import { getApiIdentity } from "@/lib/integrations/session";
import { summarizeMaintenanceOperations, unitsWithOpenWork } from "@/lib/operations/maintenance";
import { parsePeriod } from "@/lib/operations/summary";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const period = parsePeriod(new URL(request.url).searchParams.get("period"));
  const [report, blockedUnits] = await Promise.all([
    summarizeMaintenanceOperations(dbSession, identity.organizationId, period.start, period.end),
    unitsWithOpenWork(dbSession, identity.organizationId),
  ]);
  return Response.json({ report, blockedUnits });
}

export const GET = withApiSession(GETWithSession);

import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET /api/operations/insights
 *
 * The findings the current data supports, most severe first, each carrying the
 * row ids it was computed from.
 *
 * An empty list is the correct answer for a workspace with nothing connected,
 * and `isEmpty` says which kind of empty it is: no data at all, or data with
 * nothing wrong in it. A caller must not render the first as a clean bill of
 * health.
 */

import { getApiIdentity } from "@/lib/integrations/session";
import { countBySeverity, INSIGHT_THRESHOLDS } from "@/lib/operations/insights";
import { buildOperationsOverview, parsePeriod } from "@/lib/operations/summary";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const period = parsePeriod(new URL(request.url).searchParams.get("period"));
  const overview = await buildOperationsOverview(dbSession, identity.organizationId, period);

  return Response.json({
    insights: overview.insights,
    counts: countBySeverity(overview.insights),
    hasNoData: overview.isEmpty,
    // Returned so a reader can tell a judgment from a measurement: every
    // threshold that decided whether something fired is visible, not implicit.
    thresholds: INSIGHT_THRESHOLDS,
    period: overview.period,
  });
}

export const GET = withApiSession(GETWithSession);

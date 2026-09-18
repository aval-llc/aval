import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET /api/operations/overview
 *
 * Every figure the Operations module shows, for one reporting window, plus the
 * insights derived from them. One endpoint rather than five because the tabs
 * and the insight rules must be looking at the same numbers — see
 * `lib/operations/summary.ts`.
 */

import { getApiIdentity } from "@/lib/integrations/session";
import { buildOperationsOverview, PERIOD_OPTIONS, parsePeriod } from "@/lib/operations/summary";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const overview = await buildOperationsOverview(dbSession, identity.organizationId, period);

  return Response.json({
    overview,
    // Echoed so a client can render the period selector without duplicating
    // the list, and so a caller that passed an unrecognized value can see it
    // silently fell back to month-to-date rather than being rejected.
    periodOptions: PERIOD_OPTIONS,
  });
}

export const GET = withApiSession(GETWithSession);

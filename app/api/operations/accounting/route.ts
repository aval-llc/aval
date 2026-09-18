import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
/**
 * GET /api/operations/accounting
 *
 * P&L, NOI, expense lines against the prior period, AR aging, collections, and
 * the metered-utilities cross-check.
 *
 * Sections with no data come back `null` with a line in `notes`, never as
 * zeroes: a P&L of zeroes claims the portfolio earned and spent nothing, which
 * is a very different statement from "no books are connected".
 */

import { getApiIdentity } from "@/lib/integrations/session";
import { summarizeAccounting } from "@/lib/operations/accounting";
import { parsePeriod } from "@/lib/operations/summary";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const period = parsePeriod(new URL(request.url).searchParams.get("period"));
  const report = await summarizeAccounting(dbSession, identity.organizationId, period.start, period.end);
  return Response.json({ report });
}

export const GET = withApiSession(GETWithSession);

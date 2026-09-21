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
import { and, eq, isNull } from "drizzle-orm";
import { integrationConnections, properties, units, leases, leasingLeads, workOrders, ledgerEntries, glTransactions } from "@/db/postgres/schema";
import type { DashboardCapability } from "@/lib/operations/dashboard-state";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const overview = await buildOperationsOverview(dbSession, identity.organizationId, period);
  const connections = await dbSession.db.select({ provider: integrationConnections.provider, status: integrationConnections.status, lastSyncAt: integrationConnections.lastSyncAt })
    .from(integrationConnections).where(eq(integrationConnections.organizationId, identity.organizationId));
  const nativeSources = [
    ["property.read", properties], ["unit.read", units], ["lease.read", leases],
    ["lead.read", leasingLeads], ["work.read", workOrders], ["ledger.read", ledgerEntries],
    ["accounting.read", glTransactions],
  ] as const;
  const nativeChecks = await Promise.all(nativeSources.map(async ([capability, table]) => {
    // An Aval-authored record is usable without an external connection. Imported
    // rows remain dependent on their source connection after disconnection.
    const rows = await dbSession.db.select({ id: table.id }).from(table)
      .where(and(eq(table.organizationId, identity.organizationId), isNull(table.sourceConnectionId))).limit(1);
    return rows.length ? capability : null;
  }));
  const nativeCapabilities: DashboardCapability[] = nativeChecks.filter((value): value is Exclude<typeof value, null> => value !== null);

  return Response.json({
    overview,
    availability: { connections, nativeCapabilities },
    // Echoed so a client can render the period selector without duplicating
    // the list, and so a caller that passed an unrecognized value can see it
    // silently fell back to month-to-date rather than being rejected.
    periodOptions: PERIOD_OPTIONS,
  });
}

export const GET = withApiSession(GETWithSession);

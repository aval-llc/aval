import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { runTool } from "@/lib/ask-aval/tools";

const VIEW_TOOLS: Record<string, Array<[string, Record<string, unknown>]>> = {
  overview: [
    ["get_portfolio_metrics", {}],
    ["get_property_breakdown", {}],
    ["get_leasing_funnel", {}],
    ["get_accounting_breakdown", {}],
  ],
  properties: [["get_property_breakdown", {}], ["get_portfolio_metrics", {}]],
  leasing: [["get_leasing_funnel", {}], ["get_portfolio_metrics", {}]],
  maintenance: [["get_portfolio_metrics", {}], ["get_metric_series", { metric: "maintenance_requests" }]],
  accounting: [["get_accounting_breakdown", {}], ["get_portfolio_metrics", {}]],
};

/**
 * Supplies facts, not model output, to the trusted Aval desktop process.
 * Authentication and org scoping stay identical to the hosted assistant;
 * the response contains no provider credential or integration secret.
 */
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  await ensureOrganization(dbSession, identity);

  const view = new URL(request.url).searchParams.get("view") ?? "overview";
  const selected = VIEW_TOOLS[view] ?? [["get_portfolio_metrics", {}]];
  const results = await Promise.all(selected.map(async ([name, input]) => {
    const output = await runTool(dbSession, name, input, identity.organizationId);
    return [name, output.json] as const;
  }));

  return Response.json(
    { view, facts: Object.fromEntries(results) },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export const GET = withApiSession(GETWithSession);

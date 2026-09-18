import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from "@/lib/integrations/session";
import { getUsageSummary } from "@/lib/billing/usage";
import { PLANS, TOKEN_PACKS } from "@/lib/billing/plans";

async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const summary = await getUsageSummary(dbSession, identity.organizationId);
  return Response.json({
    plan: { id: summary.plan.id, name: summary.plan.name, priceUsdCents: summary.plan.priceUsdCents, monthlyTokenAllowance: summary.plan.monthlyTokenAllowance },
    subscriptionStatus: summary.subscriptionStatus,
    tokensGranted: summary.tokensGranted,
    tokensConsumed: summary.tokensConsumed,
    tokensRemaining: summary.tokensRemaining,
    plans: PLANS,
    tokenPacks: TOKEN_PACKS,
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiSession(GETWithSession);

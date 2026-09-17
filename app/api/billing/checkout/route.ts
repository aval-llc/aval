import { withApiSession } from "@/lib/api/with-session";
import { PILOT_POLICY } from "@/lib/pilot-policy";
import type { DbSession } from "@/db/postgres/session";
import { env } from "cloudflare:workers";
import { getApiIdentity } from "@/lib/integrations/session";
import { createCheckoutSession, type BillingEnv } from "@/lib/billing/stripe";
import { getPlan, getTokenPack, PLANS } from "@/lib/billing/plans";

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only a workspace administrator can manage billing" }, { status: 403 });
  if (!PILOT_POLICY.paidCheckout) return Response.json({ code: "checkout_disabled", error: "Paid plans and token packs are unavailable during the BYOK pilot. Existing subscriptions are not automatically canceled." }, { status: 409 });

  const body = (await request.json().catch(() => ({}))) as { kind?: string; id?: string };
  const kind = body.kind === "topup" ? "topup" : "plan";
  const id = typeof body.id === "string" ? body.id : "";

  let origin = "";
  try { origin = new URL(request.url).origin; } catch { /* invalid request URL */ }

  try {
    if (kind === "topup") {
      const pack = getTokenPack(id);
      if (!pack) return Response.json({ error: "Unknown token pack" }, { status: 400 });
      const session = await dbSession.outsideTransaction(() => createCheckoutSession(env as unknown as BillingEnv, {
        mode: "payment",
        customerEmail: identity.email,
        clientReferenceId: identity.organizationId,
        successUrl: `${origin}/?view=settings&billing=success`,
        cancelUrl: `${origin}/?view=settings&billing=canceled`,
        lineItem: { name: `Aval token pack: ${pack.name}`, unitAmountCents: pack.priceUsdCents },
        metadata: { organizationId: identity.organizationId, kind: "topup", packId: pack.id },
      }));
      return Response.json({ url: session.url });
    }

    const plan = getPlan(id);
    if (!PLANS.some((candidate) => candidate.id === id) || plan.priceUsdCents === 0) {
      return Response.json({ error: "Unknown or free plan" }, { status: 400 });
    }
    const session = await dbSession.outsideTransaction(() => createCheckoutSession(env as unknown as BillingEnv, {
      mode: "subscription",
      customerEmail: identity.email,
      clientReferenceId: identity.organizationId,
      successUrl: `${origin}/?view=settings&billing=success`,
      cancelUrl: `${origin}/?view=settings&billing=canceled`,
      lineItem: { name: `Aval ${plan.name} plan`, unitAmountCents: plan.priceUsdCents, recurringMonthly: true },
      metadata: { organizationId: identity.organizationId, kind: "plan", planId: plan.id },
    }));
    return Response.json({ url: session.url });
  } catch (err) {
    console.error("billing_checkout_failed", err);
    const message = err instanceof Error ? err.message : "Checkout could not be started";
    return Response.json({ error: message }, { status: 502 });
  }
}

export const POST = withApiSession(POSTWithSession);

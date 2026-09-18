import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { integrationEvents, subscriptions, tokenTopUps } from "@/db/postgres/schema";
import { withSystemSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import { getTokenPack } from "@/lib/billing/plans";
import { verifyStripeWebhook, type BillingEnv } from "@/lib/billing/stripe";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

async function resolveOrganization(event: StripeEvent, bindings: AvalRuntimeBindings): Promise<string | null> {
  if (event.type === "checkout.session.completed") {
    const object = event.data.object as { client_reference_id?: unknown; metadata?: Record<string, unknown> };
    const candidate = object.metadata?.organizationId ?? object.client_reference_id;
    return validIdentifier(candidate) ? candidate : null;
  }
  if (event.type !== "customer.subscription.updated" && event.type !== "customer.subscription.deleted") return null;
  const subscriptionId = event.data.object.id;
  if (!validIdentifier(subscriptionId)) return null;
  return withSystemSession("worker", async (session) => {
    const result = await session.db.execute<{ organization_id: string | null }>(
      sql`select aval_private.stripe_subscription_organization(${subscriptionId}) as organization_id`,
    );
    return result.rows[0]?.organization_id ?? null;
  }, bindings);
}

export async function POST(request: Request) {
  const bindings = env as unknown as AvalRuntimeBindings;
  const billingEnv = bindings as BillingEnv;
  const payload = await request.text();
  if (payload.length > 1_000_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const verified = await verifyStripeWebhook(payload, request.headers.get("stripe-signature"), billingEnv.STRIPE_WEBHOOK_SECRET);
  if (!verified) return Response.json({ error: "Invalid signature" }, { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return Response.json({ error: "Malformed payload" }, { status: 400 });
  }
  if (!validIdentifier(event.id) || !validIdentifier(event.type) || !event.data || typeof event.data.object !== "object") {
    return Response.json({ error: "Malformed event" }, { status: 400 });
  }

  const organizationId = await resolveOrganization(event, bindings);
  if (!organizationId) return Response.json({ received: true });

  try {
    await withWorkerOrganizationSession(organizationId, async (dbSession) => {
      const inserted = await dbSession.db.insert(integrationEvents).values({
        id: crypto.randomUUID(),
        organizationId,
        connectionId: null,
        provider: "stripe",
        externalEventId: event.id,
        eventType: event.type,
        payloadJson: payload,
        status: "received",
        receivedAt: new Date(),
      }).onConflictDoNothing().returning({ id: integrationEvents.id });
      if (inserted.length === 0) return;

      if (event.type === "checkout.session.completed") {
        const checkout = event.data.object as {
          id?: unknown;
          customer?: unknown;
          subscription?: unknown;
          payment_status?: unknown;
          metadata?: Record<string, unknown>;
        };
        if (!validIdentifier(checkout.id)) throw new Error("Stripe checkout session is missing its ID");
        if (checkout.metadata?.kind === "topup") {
          if (checkout.payment_status !== "paid") throw new Error("Stripe top-up has not been paid");
          const pack = getTokenPack(typeof checkout.metadata.packId === "string" ? checkout.metadata.packId : "");
          if (!pack) throw new Error("Stripe top-up references an unknown token pack");
          await dbSession.db.insert(tokenTopUps).values({
            id: crypto.randomUUID(),
            organizationId,
            stripeSessionId: checkout.id,
            packId: pack.id,
            tokensGranted: pack.tokens,
            createdAt: new Date(),
          }).onConflictDoNothing();
        } else if (checkout.metadata?.kind === "plan" && typeof checkout.metadata.planId === "string") {
          const now = new Date();
          const record = {
            planId: checkout.metadata.planId,
            status: "active",
            stripeCustomerId: typeof checkout.customer === "string" ? checkout.customer : null,
            stripeSubscriptionId: typeof checkout.subscription === "string" ? checkout.subscription : null,
            currentPeriodStart: now,
            updatedAt: now,
          };
          await dbSession.db.insert(subscriptions).values({
            id: crypto.randomUUID(), organizationId, createdAt: now, ...record,
          }).onConflictDoUpdate({ target: subscriptions.organizationId, set: record });
        }
      } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const subscription = event.data.object as { id?: unknown; status?: unknown; current_period_end?: unknown };
        if (!validIdentifier(subscription.id)) throw new Error("Stripe subscription is missing its ID");
        await dbSession.db.update(subscriptions).set({
          status: event.type === "customer.subscription.deleted" ? "canceled" : String(subscription.status ?? "unknown"),
          currentPeriodEnd: typeof subscription.current_period_end === "number" ? new Date(subscription.current_period_end * 1000) : null,
          updatedAt: new Date(),
        }).where(eq(subscriptions.stripeSubscriptionId, subscription.id));
      }

      await dbSession.db.update(integrationEvents).set({ status: "processed", processedAt: new Date() })
        .where(eq(integrationEvents.id, inserted[0].id));
    }, bindings);
  } catch (error) {
    console.error("billing_webhook_failed", event.type, error);
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }

  return Response.json({ received: true });
}

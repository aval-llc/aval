import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { communicationDeliveries, integrationConnections } from "@/db/postgres/schema";
import { withSystemSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import { verifyTwilio } from "@/lib/communications/signature";
import { decryptSecret } from "@/lib/integrations/crypto";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";

type DeliveryScope = { organization_id: string; delivery_id: string; connection_id: string };

export async function POST(request: Request) {
  const operationId = new URL(request.url).searchParams.get("operation");
  if (!operationId || operationId.length > 256) return new Response("Not found", { status: 404 });
  const bindings = env as unknown as AvalRuntimeBindings;
  const scope = await withSystemSession("worker", async (session) => {
    const result = await session.db.execute<DeliveryScope>(
      sql`select * from aval_private.delivery_connection(${operationId})`,
    );
    return result.rows[0] ?? null;
  }, bindings);
  if (!scope) return new Response("Not found", { status: 404 });

  const raw = await request.text();
  if (raw.length > 100_000) return new Response("Payload too large", { status: 413 });
  return withWorkerOrganizationSession(scope.organization_id, async (dbSession) => {
    const [delivery] = await dbSession.db.select().from(communicationDeliveries).where(and(
      eq(communicationDeliveries.id, scope.delivery_id),
      eq(communicationDeliveries.organizationId, scope.organization_id),
      eq(communicationDeliveries.connectionId, scope.connection_id),
    )).limit(1);
    const [connection] = await dbSession.db.select().from(integrationConnections).where(and(
      eq(integrationConnections.id, scope.connection_id),
      eq(integrationConnections.organizationId, scope.organization_id),
      eq(integrationConnections.provider, "twilio"),
      eq(integrationConnections.status, "connected"),
    )).limit(1);
    const encryptionKey = bindings.INTEGRATION_TOKEN_ENCRYPTION_KEY;
    if (!delivery || !connection?.accessTokenCiphertext || typeof encryptionKey !== "string") return new Response("Not found", { status: 404 });

    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(await decryptSecret(connection.accessTokenCiphertext, encryptionKey)) as Record<string, string>;
    } catch {
      return new Response("Invalid connection", { status: 503 });
    }
    if (!(await verifyTwilio(request, raw, credentials.authToken))) return new Response("Invalid signature", { status: 401 });
    const fields = new URLSearchParams(raw);
    const sid = fields.get("MessageSid") ?? fields.get("CallSid");
    if (fields.get("AccountSid") !== credentials.accountSid || !sid || (delivery.providerId && delivery.providerId !== sid)) {
      return new Response("Invalid account or operation", { status: 401 });
    }

    const status = fields.get("MessageStatus") ?? fields.get("CallStatus") ?? "";
    const terminal = ["delivered", "undelivered", "failed", "completed", "busy", "no-answer", "canceled"];
    if (["queued", "initiated", "ringing", "in-progress", "sent", ...terminal].includes(status) && !terminal.includes(delivery.status)) {
      await dbSession.db.update(communicationDeliveries).set({ status, providerId: sid, updatedAt: new Date() }).where(and(
        eq(communicationDeliveries.id, operationId),
        eq(communicationDeliveries.organizationId, scope.organization_id),
        eq(communicationDeliveries.status, delivery.status),
      ));
    }
    return new Response(null, { status: 204 });
  }, bindings);
}

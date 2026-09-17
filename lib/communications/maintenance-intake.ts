import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { conversations, messages, workOrders } from "@/db/postgres/schema";
import { createWorkOrder } from "@/lib/operations/maintenance";
import { digestPayload } from "@/lib/audit/chain";
import type { WorkOrderPriority } from "@/lib/operations/types";

export type ResidentMatch = { residentId: string; propertyId: string; unitId: string; leaseId: string };
export async function maintenanceContext(session: DbSession, org: string, conversationId: string, messageId: string) {
  const [thread] = await session.db.select().from(conversations).where(and(eq(conversations.organizationId, org), eq(conversations.id, conversationId))).limit(1);
  if (!thread || thread.channel !== "gmail") throw new Error("Maintenance intake requires a Gmail conversation");
  const [message] = await session.db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.externalMessageId, messageId), eq(messages.direction, "inbound"))).limit(1);
  if (!message) throw new Error("Inbound message unavailable");
  const metadata = JSON.parse(message.payloadJson) as { sender?: string; newsletter?: boolean; resolvedMatch?: ResidentMatch };
  const matches = metadata.sender || metadata.resolvedMatch ? await session.db.execute<ResidentMatch>(sql`
    select distinct r.id as "residentId", l.property_id as "propertyId", l.unit_id as "unitId", l.id as "leaseId"
    from residents r join lease_residents lr on lr.resident_id = r.id and lr.organization_id = r.organization_id
    join leases l on l.id = lr.lease_id and l.organization_id = r.organization_id
    where r.organization_id = ${org} and l.status = 'active'
      and ${metadata.resolvedMatch ? sql`r.id = ${metadata.resolvedMatch.residentId} and l.id = ${metadata.resolvedMatch.leaseId}` : sql`lower(btrim(r.email)) = ${metadata.sender}`}
    limit 2`) : { rows: [] };
  const match = matches.rows.length === 1 ? matches.rows[0] : null;
  return { conversationId, messageId, message: message.body, newsletter: metadata.newsletter === true,
    match, status: match ? "matched" : matches.rows.length ? "ambiguous" : "unmatched" };
}

export async function createInboundWorkOrder(session: DbSession, org: string, args: Record<string, unknown>, operationKey: string) {
  if (!operationKey) throw new Error("A durable approved task is required");
  const context = await maintenanceContext(session, org, String(args.conversation_id), String(args.message_id));
  const match = context.match;
  if (!match || context.newsletter || match.residentId !== args.resident_id || match.propertyId !== args.property_id || match.unitId !== args.unit_id) throw new Error("Resident or property match changed; review this request again");
  const externalId = `inbound_${await digestPayload({ org, conversationId: context.conversationId, messageId: context.messageId })}`;
  const summary = String(args.summary), priority = String(args.priority) as WorkOrderPriority;
  const [existing] = await session.db.select().from(workOrders).where(and(eq(workOrders.organizationId, org), eq(workOrders.sourceProvider, "manual"), eq(workOrders.externalId, externalId))).limit(1);
  if (existing) {
    if (existing.summary !== summary || existing.propertyId !== match.propertyId || existing.unitId !== match.unitId || existing.priority !== priority) throw new Error("This message already created a different work order; review it instead of duplicating it");
    return { workOrderId: existing.id, duplicate: true };
  }
  const order = await createWorkOrder(session, org, { propertyId: match.propertyId, unitId: match.unitId, leaseId: match.leaseId, summary, priority }, { sourceProvider: "manual", sourceConnectionId: null, externalId });
  return { workOrderId: order.id, duplicate: false };
}

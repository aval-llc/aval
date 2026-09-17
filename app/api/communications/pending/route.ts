import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { messages } from "@/db/postgres/schema";
import { withApiSession } from "@/lib/api/with-session";
import { getApiIdentity } from "@/lib/integrations/session";
import { queueInboundTask } from "@/lib/communications/intake";

export const GET = withApiSession(async (session: DbSession, request: Request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const pending = await session.db.execute(sql`select p.id, case when p.status = 'queued' then lower(t.status) else p.status end as status,
    coalesce(t.error, p.reason) as reason, p.conversation_id as "conversationId", c.contact_display_name as contact
    from inbound_pending p join conversations c on c.id = p.conversation_id and c.organization_id = p.organization_id
    left join agent_tasks t on t.id = p.id and t.organization_id = p.organization_id
    where p.organization_id = ${identity.organizationId} and (p.status <> 'queued' or t.status not in ('COMPLETED','CANCELLED')) order by p.created_at limit 100`);
  const choices = identity.role === "owner" ? await session.db.execute(sql`select r.id as "residentId", l.id as "leaseId", r.display_name as name, p.name as property, u.unit_number as unit
    from residents r join lease_residents lr on lr.resident_id = r.id and lr.organization_id = r.organization_id
    join leases l on l.id = lr.lease_id and l.organization_id = r.organization_id
    join properties p on p.id = l.property_id and p.organization_id = r.organization_id
    join units u on u.id = l.unit_id and u.organization_id = r.organization_id
    where r.organization_id = ${identity.organizationId} and l.status = 'active' order by r.display_name limit 500`) : { rows: [] };
  return Response.json({ pending: pending.rows, choices: choices.rows, canResolve: identity.role === "owner" }, { headers: { "cache-control": "no-store" } });
});

export const POST = withApiSession(async (session: DbSession, request: Request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (identity.role !== "owner") return Response.json({ error: "Only the owner can resolve resident matches" }, { status: 403 });
  const body = await request.json().catch(() => null) as { id?: string; residentId?: string; leaseId?: string } | null;
  if (!body || [body.id, body.residentId, body.leaseId].some(x => typeof x !== "string" || x.length > 200)) return Response.json({ error: "Choose a pending message and active resident lease" }, { status: 400 });
  const pending = await session.db.execute<{ conversation_id: string; external_message_id: string }>(sql`select conversation_id, external_message_id from inbound_pending where organization_id = ${identity.organizationId} and id = ${body.id} and status = 'review_required' for update`);
  if (!pending.rows[0]) return Response.json({ error: "Pending match unavailable" }, { status: 409 });
  const match = await session.db.execute(sql`select r.id as "residentId", l.id as "leaseId", l.unit_id as "unitId", l.property_id as "propertyId"
    from residents r join lease_residents lr on lr.resident_id = r.id and lr.organization_id = r.organization_id
    join leases l on l.id = lr.lease_id and l.organization_id = r.organization_id
    where r.organization_id = ${identity.organizationId} and r.id = ${body.residentId} and l.id = ${body.leaseId} and l.status = 'active'`);
  if (match.rows.length !== 1) return Response.json({ error: "Resident lease unavailable" }, { status: 409 });
  const item = pending.rows[0];
  const [message] = await session.db.select().from(messages).where(and(eq(messages.conversationId, item.conversation_id), eq(messages.externalMessageId, item.external_message_id), eq(messages.direction, "inbound"))).limit(1);
  if (!message) return Response.json({ error: "Message unavailable" }, { status: 409 });
  await session.db.update(messages).set({ payloadJson: JSON.stringify({ ...JSON.parse(message.payloadJson), resolvedMatch: match.rows[0], resolvedBy: identity.userId, resolvedAt: new Date().toISOString() }) }).where(eq(messages.id, message.id));
  await queueInboundTask(session, identity.organizationId, item.conversation_id, item.external_message_id, message.body);
  return Response.json({ resolved: true });
});

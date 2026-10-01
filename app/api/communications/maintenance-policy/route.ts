import { and, eq, inArray, sql } from 'drizzle-orm';
import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity } from '@/lib/integrations/session';
import { communicationSettings, properties } from '@/db/postgres/schema';
import { parseMaintenancePolicy } from '@/lib/communications/maintenance-policy';
import { readJsonBody } from '@/lib/operations/validation';
import { MAINTENANCE_ACKNOWLEDGEMENTS } from '@/lib/agents/maintenance-acknowledgement';

export const GET = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status: 403 });
  const [row] = await session.db.select().from(communicationSettings).where(eq(communicationSettings.organizationId, identity.organizationId));
  return Response.json({ policy: JSON.parse(row?.configJson ?? '{}').maintenancePolicy ?? null, acknowledgementTemplates: MAINTENANCE_ACKNOWLEDGEMENTS }, { headers: { 'cache-control': 'no-store' } });
});

export const PUT = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status: 403 });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403 });
  try {
    const input = parseMaintenancePolicy(await readJsonBody(request));
    const ids = input.properties.map(p => p.propertyId);
    const matches = ids.length ? await session.db.select({ id: properties.id }).from(properties).where(and(eq(properties.organizationId, identity.organizationId), inArray(properties.id, ids))) : [];
    if (matches.length !== ids.length) return Response.json({ error: 'Property unavailable in this workspace' }, { status: 400 });
    const policy = { ...input, version: 1, revision: crypto.randomUUID(), approvedBy: identity.userId, approvedAt: new Date().toISOString() };
    const value = JSON.stringify({ maintenancePolicy: policy });
    await session.db.insert(communicationSettings).values({ organizationId: identity.organizationId, configJson: value, updatedBy: identity.userId, updatedAt: new Date() }).onConflictDoUpdate({ target: communicationSettings.organizationId, set: { configJson: sql`${communicationSettings.configJson} || ${value}::jsonb`, updatedBy: identity.userId, updatedAt: new Date() } });
    return Response.json({ policy });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid maintenance policy' }, { status: 400 }); }
});

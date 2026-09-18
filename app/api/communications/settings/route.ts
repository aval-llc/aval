import { withApiSession } from "@/lib/api/with-session";
import { eq } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { communicationSettings, integrationConnections } from "@/db/postgres/schema";
import { getApiIdentity } from '@/lib/integrations/session';
import { parseCommunicationsConfig } from '@/lib/communications/config';
import { readCommunicationsConfig, communicationHistory } from '@/lib/communications/store';
import { ensureOrganization } from '@/lib/integrations/organizations';
async function GETWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const connections = await dbSession.db.select({ id: integrationConnections.id, provider: integrationConnections.provider, status: integrationConnections.status }).from(integrationConnections).where(eq(integrationConnections.organizationId, identity.organizationId));
  const twilio = connections.find(c => c.provider === 'twilio');
  return Response.json({ config: await readCommunicationsConfig(dbSession, identity.organizationId), deliveries: await communicationHistory(dbSession, identity.organizationId), canEdit: identity.role === 'owner', connections, voiceWebhook: twilio ? `${new URL(request.url).origin}/api/communications/voice?connection=${twilio.id}` : null, smsWebhook: twilio ? `${new URL(request.url).origin}/api/webhooks/twilio?connection=${twilio.id}` : null }, { headers: { 'cache-control': 'no-store' } });
}
async function PUTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: 'Authentication required' }, { status: 401 });
  if (identity.role !== 'owner') return Response.json({ error: 'Only the workspace owner can configure call routing.' }, { status: 403 });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403 });
  try {
    const config = parseCommunicationsConfig(await request.json());
    await ensureOrganization(dbSession, identity);
    await dbSession.db.insert(communicationSettings).values({ organizationId: identity.organizationId, configJson: JSON.stringify(config), updatedBy: identity.userId, updatedAt: new Date() }).onConflictDoUpdate({ target: communicationSettings.organizationId, set: { configJson: JSON.stringify(config), updatedBy: identity.userId, updatedAt: new Date() } });
    return Response.json({ config });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Could not save call routing.' }, { status: 400 }); }
}

export const GET = withApiSession(GETWithSession);
export const PUT = withApiSession(PUTWithSession);

import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity, isGuestIdentity } from '@/lib/integrations/session';
import { canManageFinancialPolicy } from '@/lib/agents/execution-policy';
import { agentsPaused, setAgentsPaused } from '@/lib/agents/pause';
import { appendAuditEvents } from '@/lib/audit/log';
import { digestPayload } from '@/lib/audit/chain';

export const GET = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || isGuestIdentity(identity)) return Response.json({ error: 'Authentication required' }, { status: 401 });
  return Response.json({ paused: await agentsPaused(session, identity.organizationId) }, { headers: { 'cache-control': 'no-store' } });
});

export const PUT = withApiSession(async (session, request) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Same-origin request required' }, { status: 403 });
  const identity = await getApiIdentity(session, request);
  if (!identity || isGuestIdentity(identity) || !await canManageFinancialPolicy(session, identity.organizationId, identity.userId)) {
    return Response.json({ error: 'Workspace owner access required' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('paused' in body) || typeof body.paused !== 'boolean') return Response.json({ error: 'paused must be a boolean' }, { status: 400 });
  await setAgentsPaused(session, identity.organizationId, body.paused);
  await appendAuditEvents(session, identity.organizationId, [{ kind: 'policy_decision', label: `agents:${body.paused ? 'paused' : 'resumed'}`, payloadDigest: await digestPayload({ userId: identity.userId, paused: body.paused }), count: 1 }]);
  return Response.json({ paused: await agentsPaused(session, identity.organizationId), workspacePaused: body.paused }, { headers: { 'cache-control': 'no-store' } });
});

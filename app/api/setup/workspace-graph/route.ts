import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity, isGuestIdentity } from '@/lib/integrations/session';
import { ensureOrganization } from '@/lib/integrations/organizations';
import { buildEffectiveWorkspaceGraph } from '@/lib/setup/workspace-graph';
export const GET = withApiSession(async (session,request) => {
  const identity=await getApiIdentity(session,request);
  if(!identity)return Response.json({error:'Authentication required'},{status:401});
  await ensureOrganization(session,identity);
  const params=new URL(request.url).searchParams;
  const offset=Number(params.get('offset')??0);
  const guest=isGuestIdentity(identity);
  const graph=await buildEffectiveWorkspaceGraph(session,identity.organizationId,identity.userId,{search:params.get('search')??undefined,offset:Number.isFinite(offset)?Math.max(0,offset):0,employeeId:params.get('employeeId')??undefined,isGuest:guest});
  // `viewerId` is the caller's own id, so the map can put them first and say
  // "You" — it reveals nothing the caller does not already know.
  return Response.json({...graph,canManage:identity.role==='owner'&&!guest,viewerId:identity.userId},{headers:{'cache-control':'no-store'}});
});

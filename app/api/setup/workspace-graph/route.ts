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
  return Response.json({...graph,canManage:identity.role==='owner'&&!guest},{headers:{'cache-control':'no-store'}});
});

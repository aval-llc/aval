import { withApiSession } from "@/lib/api/with-session";
import { getApiIdentity } from "@/lib/integrations/session";
import { utilityInvestigations } from "@/lib/infrastructure/investigations";
export const GET=withApiSession(async(s,request)=>{
  const identity=await getApiIdentity(s,request);
  if(!identity)return Response.json({error:"Authentication required"},{status:401});
  const q=new URL(request.url).searchParams;
  return Response.json(await utilityInvestigations(s,identity.organizationId,q.get('locale')==='en'?'en':'es-mx',q.get('siteId') ?? undefined));
});

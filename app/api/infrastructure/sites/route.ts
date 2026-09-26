import { withApiSession } from "@/lib/api/with-session";
import { getApiIdentity } from "@/lib/integrations/session";
import { createSite, listSites } from "@/lib/infrastructure/sites";
import { utilityErrorResponse } from "@/lib/infrastructure/validation";
import { readUtilityBody } from "@/lib/infrastructure/validation";
export const GET = withApiSession(async (s,request) => {
  const identity = await getApiIdentity(s,request);
  if (!identity) return Response.json({error:"Authentication required"},{status:401});
  return Response.json({sites:await listSites(s,identity.organizationId),canEdit:identity.role==="owner"});
});
export const POST = withApiSession(async(s,request) => {
  const identity = await getApiIdentity(s,request);
  if (identity?.role !== "owner") return Response.json({error:"Owner required"},{status:403});
  try {
    const body = await readUtilityBody(request);
    return Response.json({site:await createSite(s,identity.organizationId,{name:body.name,propertyId:body.propertyId})},{status:201});
  } catch(error) { return utilityErrorResponse(error); }
});

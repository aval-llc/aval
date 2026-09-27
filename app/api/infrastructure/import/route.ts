import { withApiSession } from "@/lib/api/with-session";
import { getApiIdentity } from "@/lib/integrations/session";
import { importUtilityBills } from "@/lib/infrastructure/import";
import { parseUtilityCsv } from "@/lib/infrastructure/import-format";
import { UtilityError, utilityErrorResponse, readUtilityBody } from "@/lib/infrastructure/validation";
export const POST=withApiSession(async(s,request)=>{
  const identity=await getApiIdentity(s,request);
  if(identity?.role!=="owner")return Response.json({error:"Owner required"},{status:403});
  try {
    const body=await readUtilityBody(request,500000);
    const rows=typeof body.csv==="string" ? parseUtilityCsv(body.csv) : body.rows;
    if(body.mode!=="preview" && body.mode!=="apply")throw new UtilityError("Select preview or apply");
    if(body.mode==="apply" && typeof body.previewToken!=="string")throw new UtilityError("Review a preview first");
    return Response.json(await importUtilityBills(s,identity.organizationId,rows,body.mode==="apply" && typeof body.previewToken==="string" ? body.previewToken : undefined));
  }catch(error){
    if(error instanceof SyntaxError)return Response.json({error:"Invalid JSON"},{status:400});
    return utilityErrorResponse(error);
  }
});

import { and, eq } from "drizzle-orm";
import { withApiSession } from "@/lib/api/with-session";
import { getApiIdentity } from "@/lib/integrations/session";
import { utilityInvestigations } from "@/lib/infrastructure/investigations";
import { utilityErrorResponse, UtilityError, textField, readUtilityBody } from "@/lib/infrastructure/validation";
import { lockUtilityWorkspace } from "@/lib/infrastructure/sites";
import { planningItems } from "@/db/postgres/schema";
import { appendAuditEvents } from "@/lib/audit/log";
export const POST=withApiSession(async(s,request)=>{
  const identity=await getApiIdentity(s,request);
  if(identity?.role!=="owner")return Response.json({error:"Owner required"},{status:403});
  try {
    const b=await readUtilityBody(request);
    const meterId=textField(b.meterId,"meterId");
    const title=textField(b.title,"title",160), description=textField(b.description,"description",5000);
    await lockUtilityWorkspace(s,identity.organizationId);
    const report=await utilityInvestigations(s,identity.organizationId,b.locale==='en'?'en':'es-mx',typeof b.siteId==='string'?b.siteId:undefined);
    const finding=report.findings.find(f=>f.meterId===meterId);
    if(!finding?.siteId || !finding.currentBillId || b.currentBillId!==finding.currentBillId || b.priorBillId!==finding.priorBillId)throw new UtilityError("Evidence changed or unavailable; refresh the investigation",409);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([identity.organizationId,meterId,b.currentBillId,b.priorBillId]))))).map(n=>n.toString(16).padStart(2,'0')).join('');
    const id=`utility_${digest}`;
    const now=Date.now();
    const inserted=await s.db.insert(planningItems).values({id,organizationId:identity.organizationId,createdBy:identity.userId,title,description,kind:'task',status:'planned',projectId:null,assigneeId:null,startsAt:now,endsAt:now,version:1,updatedAt:now}).onConflictDoNothing().returning({id:planningItems.id});
    const [item]=await s.db.select().from(planningItems).where(and(eq(planningItems.organizationId,identity.organizationId),eq(planningItems.id,id)));
    if(inserted.length)await appendAuditEvents(s,identity.organizationId,[{kind:'task_created',label:'utility_follow_up',payloadDigest:digest,count:1}]);
    return Response.json({item});
  }catch(error){return utilityErrorResponse(error);}
});

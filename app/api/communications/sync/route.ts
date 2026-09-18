import { withApiSession } from "@/lib/api/with-session";
import { and, eq } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { communicationPollSources } from "@/db/postgres/schema";
import { getApiIdentity } from '@/lib/integrations/session';
import { pollInbox } from '@/lib/communications/polling';
async function POSTWithSession(dbSession: DbSession, request:Request){
 const identity=await getApiIdentity(dbSession, request);if(!identity)return Response.json({error:'Authentication required'},{status:401});
 if(identity.role==='member')return Response.json({error:'An owner or approver must refresh connected inboxes.'},{status:403});
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
 const input:unknown=await request.json().catch(()=>null);
 if(!input||typeof input!=='object'||Array.isArray(input))return Response.json({error:'A JSON object is required.'},{status:400});
 const body=input as {provider?:string;resourceId?:string;automatic?:boolean};
 if(typeof body.provider!=='string'||(body.resourceId!==undefined&&(typeof body.resourceId!=='string'||body.resourceId.length>500)))return Response.json({error:'Choose a provider and a valid resource ID.'},{status:400});
 try{
  if(body.automatic!==undefined && (typeof body.automatic!=='boolean'||identity.role!=='owner'))return Response.json({error:'Only the owner can manage automatic inbox refresh.'},{status:403});
  if(body.automatic===false){await dbSession.db.update(communicationPollSources).set({enabled:false}).where(and(eq(communicationPollSources.organizationId,identity.organizationId),eq(communicationPollSources.provider,body.provider),eq(communicationPollSources.resourceId,body.resourceId??'')));return Response.json({disabled:true});}
  const result=await pollInbox(dbSession, identity.organizationId,body.provider,body.resourceId);
  if(body.automatic===true)await dbSession.db.insert(communicationPollSources).values({id:crypto.randomUUID(),organizationId:identity.organizationId,provider:body.provider,resourceId:body.resourceId??'',enabled:true,lastAttemptAt:new Date(),lastSuccessAt:new Date()}).onConflictDoUpdate({target:[communicationPollSources.organizationId,communicationPollSources.provider,communicationPollSources.resourceId],set:{enabled:true,error:null}});
  return Response.json({...result,automatic:body.automatic===true});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Could not refresh inbox.'},{status:422});}
}

async function GETWithSession(dbSession: DbSession, request:Request){
 const identity=await getApiIdentity(dbSession, request);if(!identity)return Response.json({error:'Authentication required'},{status:401});
 const sources=await dbSession.db.select().from(communicationPollSources).where(and(eq(communicationPollSources.organizationId,identity.organizationId),eq(communicationPollSources.enabled,true)));
 return Response.json({sources,canRefresh:identity.role!=='member',canManageAutomatic:identity.role==='owner'},{headers:{'cache-control':'no-store'}});
}

export const POST = withApiSession(POSTWithSession);
export const GET = withApiSession(GETWithSession);

import { withApiSession } from "@/lib/api/with-session";
import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity } from '@/lib/integrations/session';
import { marketingConnections, importMetaLeadPage } from '@/lib/marketing/service';
async function GETWithSession(dbSession: DbSession, request:Request) {
 const identity=await getApiIdentity(dbSession, request);if(!identity)return Response.json({error:'Authentication required'},{status:401});
 return Response.json({channels:await marketingConnections(dbSession, identity.organizationId)},{headers:{'cache-control':'no-store'}});
}
async function POSTWithSession(dbSession: DbSession, request:Request) {
 const identity=await getApiIdentity(dbSession, request);if(!identity)return Response.json({error:'Authentication required'},{status:401});
 if(identity.role!=='owner')return Response.json({error:'Only the workspace owner can import marketing leads.'},{status:403});
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
 const input:unknown=await request.json().catch(()=>null);
 if(!input||typeof input!=='object'||Array.isArray(input))return Response.json({error:'A JSON object is required.'},{status:400});
 const body=input as {formId?:string;after?:string};
 if((body.formId!==undefined&&(typeof body.formId!=='string'||!/^\d{1,64}$/.test(body.formId)))||(body.after!==undefined&&(typeof body.after!=='string'||body.after.length>2000)))return Response.json({error:'Invalid lead page cursor.'},{status:400});
 try{return Response.json(await importMetaLeadPage(dbSession, identity.organizationId,body.formId,body.after));}catch(e){return Response.json({error:e instanceof Error?e.message:'Could not import leads.'},{status:422});}
}

export const GET = withApiSession(GETWithSession);
export const POST = withApiSession(POSTWithSession);

import { sql } from 'drizzle-orm';
import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity, isGuestIdentity } from '@/lib/integrations/session';
import { roleFor } from '@/lib/organizations/membership';
import {
  authenticateBrowserDevice, registerBrowserDevice, bindBrowserConnection,
  claimBrowserWrite, consumeBrowserGrant, recordBrowserResult, expireBrowserReviews,
  BrowserProtocolError, type BrowserResult,
} from '@/lib/pms/browser/protocol';

export const POST = withApiSession(async (s, request) => {
  if(request.headers.get('origin')!==new URL(request.url).origin) return Response.json({error:'Same-origin request required'},{status:403});
  const identity=await getApiIdentity(s,request);
  if(!identity || isGuestIdentity(identity) || await roleFor(s,identity.userId,identity.organizationId)!=='owner')
    return Response.json({error:'The supervised PMS pilot requires workspace owner access'},{status:403});
  const raw=await request.text();
  if(raw.length>64_000) return Response.json({error:'PMS request is too large'},{status:413});
  let b:Record<string,unknown>;
  try { b=JSON.parse(raw); } catch { return Response.json({error:'Invalid JSON'},{status:400}); }
  if(!b || b.protocol!==2) return Response.json({error:'Update Aval Desktop to use PMS protocol 2'},{status:426});
  const org=identity.organizationId,user=identity.userId;
  if(request.headers.get('x-aval-pms-workspace')!==org || request.headers.get('x-aval-pms-user')!==user)
    return Response.json({error:'Aval account or workspace changed. Reconnect the Desktop runner.'},{status:409});
  const device=request.headers.get('x-aval-pms-device')??'';
  const secret=request.headers.get('x-aval-pms-secret')??'';
  const respond=(value:unknown)=>Response.json(value,{headers:{'cache-control':'no-store'}});
  try {
    if(b.intent==='register') return respond(await registerBrowserDevice(s,org,user,device,secret));
    await authenticateBrowserDevice(s,org,user,device,secret);
    if(b.intent==='bind') return respond(await bindBrowserConnection(s,org,device,b as unknown as Parameters<typeof bindBrowserConnection>[3]));
    if(b.intent==='claim') return respond({instruction:await claimBrowserWrite(s,org,device)});
    if(b.intent==='grant') return respond(await consumeBrowserGrant(s,org,device,b as unknown as Parameters<typeof consumeBrowserGrant>[3]));
    if(b.intent==='result') return respond(await recordBrowserResult(s,org,device,b as unknown as BrowserResult));
    return Response.json({error:'Unknown PMS operation'},{status:400});
  } catch(error) {
    if(error instanceof BrowserProtocolError) return Response.json({error:error.message},{status:409});
    throw error;
  }
});

export const GET=withApiSession(async(s,request)=>{
  const identity=await getApiIdentity(s,request);
  if(!identity || isGuestIdentity(identity) || await roleFor(s,identity.userId,identity.organizationId)!=='owner')
    return Response.json({error:'Workspace owner access required'},{status:403});
  await expireBrowserReviews(s,identity.organizationId);
  const [rows,setups]=await Promise.all([s.db.execute(sql`select id,provider,status,last_error,external_id,review_due_at,responsible_user_id,
    submitted_at,created_at,protocol_json->>'reference' as reference from pms_write_queue
    where organization_id=${identity.organizationId} and (protocol_json is not null or status='needs_review') order by created_at desc limit 50`),
    s.db.execute<{id:string;provider:string;metadata_json:{pmsDesktop?:{origin?:string;preflightRequestId?:string;allowedPropertyId?:string}}}>(sql`
      select id,provider,metadata_json from integration_connections where organization_id=${identity.organizationId}
      and auth_mode='customer_desktop_session' and status in ('verification_required','connected')`)]);
  const setupConnections=setups.rows.map(row=>({connectionId:row.id,provider:row.provider,origin:row.metadata_json?.pmsDesktop?.origin,
    preflightRequestId:row.metadata_json?.pmsDesktop?.preflightRequestId,allowedPropertyId:row.metadata_json?.pmsDesktop?.allowedPropertyId}))
    .filter(row=>typeof row.origin==='string'&&typeof row.preflightRequestId==='string'&&typeof row.allowedPropertyId==='string');
  return Response.json({protocol:2,organizationId:identity.organizationId,userId:identity.userId,operations:rows.rows,setupConnections},{headers:{'cache-control':'no-store'}});
});

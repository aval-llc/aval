import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity } from '@/lib/integrations/session';
import { readJsonBody } from '@/lib/operations/validation';
import { mapPmsReport, type ReportDataset } from '@/lib/operations/pms-reports';
import { applyImport, loadKnownExternalIds } from '@/lib/operations/import-apply';
import { planImport, plannedRowCount } from '@/lib/operations/import-plan';
import { payloadHash } from '@/lib/agents/canonical-payload';
import { desktopQuery as query } from '@/lib/agents/desktop-inference';
import { operationsErrorResponse } from '@/lib/operations/errors';
import { ValidationError } from '@/lib/operations/validation';

export const GET = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session,request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status:403 });
  const profiles = await query(session,'SELECT provider,dataset,mapping_json,last_import_at,record_count FROM pms_report_profiles WHERE organization_id=$1',[identity.organizationId]);
  return Response.json({ profiles: profiles.rows }, { headers: { 'cache-control':'no-store' } });
});
export const POST = withApiSession(async (session,request) => {
  const identity = await getApiIdentity(session,request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status:403 });
  try {
    const body = await readJsonBody(request);
    if (Object.keys(body).some(k => !['provider','dataset','csv','mapping','currency','action','digest'].includes(k))) throw new ValidationError('report','Unexpected report field; provenance is server-assigned');
    if (typeof body.csv !== 'string' || !body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping)) throw new ValidationError('report','Report and mappings required');
    const provider = String(body.provider), dataset = String(body.dataset) as ReportDataset;
    const csv = body.csv;
    const batch = (()=>{try{return mapPmsReport(provider,dataset,csv,body.mapping as Record<string,string>,String(body.currency));}catch(e){throw new ValidationError('report',e instanceof Error?e.message:'Invalid report');}})();
    const sourceProvider = 'manual';
    await query(session,'SELECT pg_advisory_xact_lock(hashtext($1))',[`${identity.organizationId}:pms_reports`]);
    const known = await loadKnownExternalIds(session,identity.organizationId,sourceProvider);
    const plan = planImport(batch,known);
    const count = plannedRowCount(plan);
    if (!count && !plan.skipped.length) throw Error('The report contains no records');
    const digest = await payloadHash({ organizationId:identity.organizationId,batch,counts:plan.counts,skipped:plan.skipped });
    if (body.action === 'preview') return Response.json({ digest,counts:plan.counts,skipped:plan.skipped,sample:batch[dataset]?.slice(0,5),source:'manual report',apiConnected:false });
    if (body.action !== 'apply' || body.digest !== digest || plan.skipped.length) return Response.json({ error:'Review a valid preview before importing',counts:plan.counts,skipped:plan.skipped },{ status:409 });
    const result = await applyImport(session,identity.organizationId,batch,{sourceProvider,sourceConnectionId:null,externalId:null});
    await query(session,`INSERT INTO pms_report_profiles(organization_id,provider,dataset,mapping_json,last_import_at,record_count)
      VALUES($1,$2,$3,$4,now(),$5) ON CONFLICT(organization_id,provider,dataset) DO UPDATE SET mapping_json=$4,last_import_at=now(),record_count=$5`,
    [identity.organizationId,provider,dataset,JSON.stringify(body.mapping),count]);
    return Response.json({ result,apiConnected:false },{status:201});
  } catch(error) { return operationsErrorResponse(error); }
});

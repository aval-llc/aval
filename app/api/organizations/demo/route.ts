import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity } from '@/lib/integrations/session';
import { activeOrganizationCookie } from '@/lib/auth/supabase';
import { desktopQuery as query } from '@/lib/agents/desktop-inference';
import { applyImport } from '@/lib/operations/import-apply';
import { demoPortfolio, DEMO_GOALS } from '@/lib/operations/demo-portfolio';
import { startDemoWorkflow } from '@/lib/operations/demo-workflows';
import { withWorkerOrganizationSession } from '@/lib/api/with-session';
import { runAgentWorkerBatch } from '@/lib/agents/worker';
import { runtimeBindings } from '@/lib/runtime/bindings';
import { getRequestExecutionContext } from 'vinext/shims/request-context';

export const GET = withApiSession(async(session,request)=>{
  const identity=await getApiIdentity(session,request);
  if(!identity)return Response.json({error:'Authentication required'},{status:401});
  if(!identity.organizationId.startsWith('org_demo_'))return Response.json({sampleData:false});
  const counts:Record<string,number>={};
  for(const table of ['properties','units','residents','leases','work_orders']) {
    const rows=await query(session,`SELECT count(*)::int AS count FROM ${table} WHERE organization_id=$1 AND source_provider='aval_demo'`,[identity.organizationId]);
    counts[table]=Number(rows.rows[0].count);
  }
  const tasks=await query(session,`SELECT id,goal FROM agent_tasks WHERE organization_id=$1 AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT 20`,[identity.organizationId]);
  return Response.json({sampleData:true,counts,goals:DEMO_GOALS,tasks:tasks.rows},{headers:{'cache-control':'no-store'}});
});

export const POST = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || identity.source !== 'password') return Response.json({ error: 'Sign in to Aval first' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { action?: string; workflow?: number; locale?: string };
  if (body.action === 'create') {
    const created = await query(session, 'SELECT aval_private.create_demo_workspace() AS id');
    const id = String(created.rows[0].id);
    return Response.json({ organizationId: id, name: 'Aval Demo', next: 'seed' }, { headers: { 'set-cookie': activeOrganizationCookie(request, id) } });
  }
  if (!['seed','start'].includes(body.action??'') || identity.role !== 'owner' || !identity.organizationId.startsWith('org_demo_')) return Response.json({ error: 'Select your Aval Demo workspace first' }, { status: 403 });
  await query(session, 'SELECT pg_advisory_xact_lock(hashtext($1))', [identity.organizationId]);
  const org = (await query(session, 'SELECT created_at FROM organizations WHERE id=$1 AND owner_user_id=$2', [identity.organizationId, identity.userId])).rows[0];
  if (!org) return Response.json({ error: 'Demo owner required' }, { status: 403 });
  if(body.action==='start') {
    if(!Number.isInteger(body.workflow)||body.workflow!<0||body.workflow!>2)return Response.json({error:'Choose a demo workflow'},{status:400});
    const task=await startDemoWorkflow(session,identity.organizationId,identity.userId,body.workflow!,body.locale);
    const work=session.afterCommit(()=>withWorkerOrganizationSession(identity.organizationId,worker=>runAgentWorkerBatch(worker,runtimeBindings(),'request')));
    getRequestExecutionContext()?.waitUntil(work);
    return Response.json({taskId:task.id},{status:202});
  }
  const imported = await applyImport(session, identity.organizationId, demoPortfolio(new Date(String(org.created_at))), { sourceProvider: 'aval_demo', sourceConnectionId: null, externalId: null });
  return Response.json({ organizationId: identity.organizationId, imported, sampleData: true, goals: DEMO_GOALS, currency: 'USD' });
});

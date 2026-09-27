import assert from 'node:assert/strict';
import { createTask, appendStep } from '../../lib/agents/tasks.ts';
import { taskManifest } from '../../lib/agents/manifest-storage.ts';
import { exportBraintrustTraces } from '../../lib/observability/braintrust-export.ts';
import { sql } from 'drizzle-orm';

export async function runObservabilityCases(t,{session,userA,userB,administrator,config}) {
  const run=fn=>session(userA,s=>fn(s,s.identity.organizationId));
  let task,org,manifest;
  await t.test('observability: immutable manifests retain exact prompt and current policy revisions',async()=>{
    task=await run((s,o)=>createTask(s,{organizationId:o,userId:userA,agentId:'general',goal:'Synthetic manifest regression',check:{kind:'evidence',tools:['get_portfolio_metrics']}}));
    org=task.organizationId;
    manifest=await run(s=>taskManifest(s,org,task.id,{phase:'actor',system:'Synthetic instruction',tools:[],messages:[]}));
    assert.notEqual(manifest.agent_version,'unversioned-local');
    await run(s=>appendStep(s,{organizationId:org,taskId:task.id,stepIndex:0,kind:'model_call',executionManifest:manifest}));
    const original=(await administrator.query("SELECT execution_manifest_json FROM agent_task_steps WHERE task_id=$1 AND kind='model_call'",[task.id])).rows[0].execution_manifest_json;
    await administrator.query('UPDATE user_onboarding SET revision=revision+1 WHERE organization_id=$1 AND user_id=$2',[org,userA]);
    // If onboarding has not been created yet, use a scoped grant change instead.
    await administrator.query("UPDATE access_grants SET updated_at=now()+interval '1 second' WHERE organization_id=$1",[org]);
    const next=await run(s=>taskManifest(s,org,task.id,{phase:'actor',system:'Synthetic instruction',tools:[],messages:[]}));
    assert.notEqual(next.policy_version,original.policy_version);
    assert.deepEqual((await administrator.query("SELECT execution_manifest_json FROM agent_task_steps WHERE task_id=$1 AND kind='model_call'",[task.id])).rows[0].execution_manifest_json,original);
    await assert.rejects(session(userB,s=>taskManifest(s,s.identity.organizationId,task.id,{phase:'actor'})),/outside/);
  });
  await t.test('observability: failed export backs off, replay has stable IDs, and success drains once',async()=>{
    const previous=globalThis.fetch;const requests=[];let status=503;
    globalThis.fetch=async(url,options)=>{assert.ok(url.startsWith('https://api.braintrust.dev/v1/project_logs/'));requests.push(JSON.parse(options.body));return new Response('{}',{status});};
    const bindings={DATABASE_URL:config.connectionString,BRAINTRUST_API_KEY:'synthetic-test-key',BRAINTRUST_REGION:'us',BRAINTRUST_TRACE_ROUTES:JSON.stringify([{organizationId:org,projectId:'3b2d0c23-3eb6-47be-84fd-e4e53c030d2f',since:'2026-01-01T00:00:00Z'}])};
    try {
      await exportBraintrustTraces(bindings);assert.equal(requests.length,1);
      await exportBraintrustTraces(bindings);assert.equal(requests.length,1,'backoff prevents immediate retry');
      await administrator.query("UPDATE agent_trace_deliveries SET next_attempt_at=now()-interval '1 minute' WHERE organization_id=$1",[org]);status=200;
      await exportBraintrustTraces(bindings);assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
      await exportBraintrustTraces(bindings);assert.equal(requests.length,2,'delivered events do not resend');
      assert.ok(!JSON.stringify(requests).includes('Synthetic instruction'),'no prompts in production projection');
      const hidden=await session(userB,s=>s.db.execute(sql`SELECT * FROM agent_trace_deliveries WHERE organization_id=${org}`));assert.equal(hidden.rows.length,0);
    } finally {globalThis.fetch=previous;}
  });
}

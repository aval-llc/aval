import test from 'node:test';
import assert from 'node:assert/strict';
import { executionManifest } from '../lib/agents/execution-manifest.ts';
import { braintrustBase, traceEvent, insertBraintrustEvents } from '../lib/observability/braintrust.ts';

test('execution versions are canonical, sensitive to prompt/schema/policy/memory changes', async () => {
  const input = { phase:'actor',system:'instructions',tools:[{name:'read'}],messages:[{evidence:1}],policy:{b:2,a:1},memory:[] };
  const before = await executionManifest(input);
  assert.deepEqual(before, await executionManifest({...input,policy:{a:1,b:2}}));
  for (const [field,key,value] of [
    ['system','prompt_version','changed'],['tools','tool_schema_version',[]],
    ['policy','policy_version',{}],['memory','memory_version',[1]],['messages','evidence_digest',[]],
  ] as const) assert.notEqual((await executionManifest({...input,[field]:value}))[key],before[key]);
  assert.equal(before.model,'not-invoked');
  assert.equal((await executionManifest({phase:'legacy'})).policy_version,'unknown');
});

const row = { id:'step-1',task_id:'task-1',kind:'tool_call',sequence:1,step_index:0,
  model_name:null,model_provider:null,tool_name:'read_maintenance_context',policy_effect:'allow',risk_level:'low',
  attempt:1,duration_ms:15,error:'Secret tenant@example.com sk-secret',created_at:'2026-09-27T00:00:00Z',
  execution_manifest_json:{prompt_version:'hash',tenant:'tenant@example.com',input_tokens:42} };
test('export is an allowlist and never leaks source errors or unexpected metadata', () => {
  const event = traceEvent(row);
  assert.equal(JSON.stringify(event).includes('tenant@example.com'),false);
  assert.equal(JSON.stringify(event).includes('sk-secret'),false);
  assert.equal(event.metadata.failed,true);
  assert.equal(event.metadata.policy_version,'unknown');
  assert.equal(event.metrics.prompt_tokens,42);
  assert.deepEqual(event,traceEvent(row),'retry preserves IDs and event data');
});
test('Braintrust transport refuses arbitrary hosts and preserves retry IDs', async () => {
  assert.throws(()=>braintrustBase('https://evil.invalid'));
  const sent: unknown[]=[];
  const fake = (async (url: string, options: RequestInit) => {
    assert.equal(url,'https://api.braintrust.dev/v1/project_logs/3b2d0c23-3eb6-47be-84fd-e4e53c030d2f/insert');
    assert.equal(options.redirect,'error');sent.push(JSON.parse(String(options.body)));
    return new Response('do not log provider body',{status:503});
  }) as typeof fetch;
  const config={apiKey:'test-key',region:'us',projectId:'3b2d0c23-3eb6-47be-84fd-e4e53c030d2f'};
  assert.deepEqual(await insertBraintrustEvents(config,[traceEvent(row)],fake),{ok:false,status:503});
  await insertBraintrustEvents(config,[traceEvent(row)],fake);
  assert.deepEqual(sent[0],sent[1]);
});

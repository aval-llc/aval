import test from 'node:test';
import assert from 'node:assert/strict';
import { bootRuntime, ENV, scriptModel, useTool as modelTool, semanticFixture } from './harness.mjs';

test('live malformed plan shapes fail with bounded repairs before reviewer calls or child allocation', async () => {
  for (const check of [
    {kind:'evidence',description:'Read the quote'},
    {kind:'evidence'},
    {kind:'evidence',tools:['document_search']},
  ]) {
    const db=await bootRuntime();
    const tasks=await import('../../lib/agents/tasks.ts');
    const runtime=await import('../../lib/agents/runtime.ts');
    const root=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'leaseReview',goal:'Read the quote.',check:{kind:'plan'}});
    let reviews=0;
    globalThis.__SEMANTIC_MODEL__=async()=>{reviews++;throw Error('Invalid plans must not call the reviewer');};
    scriptModel(modelTool('plan_goal',{tasks:[{key:'quote',goal:'Read the quote.',dependsOn:[],check}]}));
    const result=await runtime.advanceTask(ENV,'org_1',root.id,runtime.newWorkerId());
    assert.equal(result.status,'FAILED');
    assert.match(result.error,/bounded repair/);
    assert.equal(reviews,0);
    assert.equal(db.prepare('SELECT count(*) n FROM agent_tasks').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM agent_checks WHERE exit_code=1').get().n,3);
    assert.equal((await tasks.getTask('org_1',root.id)).maxTokens,root.maxTokens);
    assert.equal((await tasks.listSteps(root.id,'org_1')).some(step=>step.kind==='mutation_reserved'),false);
    db.close();
  }
});

test('document planner receives exact read capabilities and can create an executable reviewed child', async () => {
  const db=await bootRuntime();
  const tasks=await import('../../lib/agents/tasks.ts');
  const runtime=await import('../../lib/agents/runtime.ts');
  const root=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'leaseReview',goal:'Read the quote.',check:{kind:'plan'}});
  globalThis.__MODEL__=async(_env,_org,params)=>{
    assert.match(params.system,/'?read_document/);
    assert.match(params.system,/list_documents/);
    const plan=params.tools.find(tool=>tool.name==='plan_goal');
    const schema=plan.input_schema.properties.tasks.items.properties.check;
    assert.ok(schema.required.includes('kind'));
    assert.equal(schema.properties.tools.type,'array');
    return modelTool('plan_goal',{tasks:[{key:'quote',goal:'Read the quote.',dependsOn:[],check:{kind:'evidence',tools:['read_document']}}]});
  };
  let reviews=0;
  globalThis.__SEMANTIC_MODEL__=async(_env,_org,params)=>{reviews++;return semanticFixture(JSON.parse(params.messages[0].content));};
  const result=await runtime.advanceTask(ENV,'org_1',root.id,runtime.newWorkerId());
  assert.equal(result.status,'WAITING_FOR_TOOL');
  assert.equal(reviews,1);
  const child=db.prepare('SELECT agent_id,check_json FROM agent_tasks WHERE parent_task_id=?').get(root.id);
  assert.equal(child.agent_id,'leaseReview');
  assert.deepEqual(JSON.parse(child.check_json),{kind:'evidence',tools:['read_document']});
  db.close();
});

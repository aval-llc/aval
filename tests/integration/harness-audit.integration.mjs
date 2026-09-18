import assert from 'node:assert/strict';
import test from 'node:test';
import {bootRuntime,writeReviewedPlan as writeGoalPlan} from './harness.mjs';
test('delegated execution preserves ancestor permissions and reserves a shared budget',async()=>{
 const sqlite=await bootRuntime();const tasks=await import('../../lib/agents/tasks.ts');const {delegate}=await import('../../lib/agents/delegation.ts');const {executeTool}=await import('../../lib/agents/executor.ts');
 const parent=await tasks.createTask({ check:{kind:"evidence",tools:["get_portfolio_metrics"]},organizationId:'org_1',userId:'user_1',agentId:'riskAnalyst',goal:'Review risks.'});
 const children=[];for(let i=0;i<3;i++){const result=await delegate(parent,'maintenance','Review maintenance');assert.equal(result.ok,true);children.push(result.task);}
 const remaining=await tasks.getTask('org_1',parent.id);
 assert.ok(remaining.maxTokens+children.reduce((n,t)=>n+t.maxTokens,0)<=parent.maxTokens);
 assert.ok(remaining.maxSteps+children.reduce((n,t)=>n+t.maxSteps,0)<=parent.maxSteps);
 const result=await executeTool({toolName:'record_preference',args:{topic:'irrelevant',statement:'irrelevant'},subject:{organizationId:'org_1',userId:'user_1',isGuest:false},context:{personaId:'maintenance'},task:{id:children[0].id,stepIndex:0}});
 assert.equal(result.result.status,'denied');assert.match(result.result.reason,/ancestry/);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM learned_preferences').get().n,0);
});
test('inbound tasks cannot inspect other contacts, portfolio data, or out-of-thread messages',async()=>{
 await bootRuntime();const tasks=await import('../../lib/agents/tasks.ts');const {executeTool}=await import('../../lib/agents/executor.ts');
 const task=await tasks.createTask({ check:{kind:"evidence",tools:["get_portfolio_metrics"]},organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Review incoming message',executionScope:{source:'inbound',conversationId:'origin'}});
 for(const [toolName,args] of [['list_conversations',{}],['get_delinquent_accounts',{}],['read_conversation',{conversation_id:'elsewhere'}]]){
  const result=await executeTool({toolName,args,subject:{organizationId:'org_1',userId:'user_1',isGuest:false},task:{id:task.id,stepIndex:0}});assert.equal(result.result.status,'denied');
 }
});

test('false delivery claims fail independent checks and receive bounded repair feedback',async()=>{
 const sqlite=await bootRuntime();const tasks=await import('../../lib/agents/tasks.ts');const {advanceTask,newWorkerId}=await import('../../lib/agents/runtime.ts');const {conclude,ENV}=await import('./harness.mjs');
 const task=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Send a reminder and verify delivery',check:{kind:'delivery',operation:'message',status:'delivered'}});
 let calls=0,feedback=false;globalThis.__MODEL__=async(_e,_o,p)=>{calls++;feedback ||= JSON.stringify(p.messages).includes('No message operation');return conclude('Delivered','The resident received the reminder.');};
 const result=await advanceTask(ENV,'org_1',task.id,newWorkerId());assert.equal(result.status,'FAILED');assert.equal(calls,3);assert.equal(feedback,true);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM communication_deliveries').get().n,0);
 assert.deepEqual(sqlite.prepare('SELECT exit_code FROM agent_checks WHERE task_id=?').all(task.id).map(r=>r.exit_code),[1,1,1]);
});
test('queuing without a completion contract is refused before persistence',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');
 for(const check of [undefined,{}, {kind:'evidence',tools:[]}])await assert.rejects(()=>createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Anything',check}));
 assert.equal(sqlite.prepare('SELECT count(*) n FROM agent_tasks').get().n,0);
});

test('goal plans are inspectable, dependency ordered, and completed only after checked children',async()=>{
 const sqlite=await bootRuntime();const tasks=await import('../../lib/agents/tasks.ts');const runtime=await import('../../lib/agents/runtime.ts');const {goalPlan}=await import('../../lib/agents/goal-plan.ts');const {useTool:modelTool,conclude,ENV}=await import('./harness.mjs');
 const root=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels, then inspect recent conversations.',maxSteps:24,check:{kind:'plan'}});
 globalThis.__MODEL__=async(_e,_o,p)=>{
  if(p.system.includes('"kind":"plan"'))return p.system.includes('"status":"COMPLETED"')?conclude('Inspections complete'):modelTool('plan_goal',{tasks:[{key:'channels',goal:'Inspect channels.',dependsOn:[],check:{kind:'evidence',tools:['get_communication_channels']}},{key:'conversations',goal:'Inspect conversations.',dependsOn:['channels'],check:{kind:'evidence',tools:['list_conversations']}}]});
  if(p.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')))return conclude('Inspection complete');
  return modelTool(p.system.includes('list_conversations')&&p.system.includes('"tools":["list_conversations"]')?'list_conversations':'get_communication_channels');
 };
 const run=id=>runtime.advanceTask(ENV,'org_1',id,runtime.newWorkerId());
 assert.equal((await run(root.id)).status,'WAITING_FOR_TOOL');const plan=await goalPlan('org_1',root.id);assert.equal(plan.nodes.length,2);
 const first=plan.nodes.find(n=>n.key==='channels'),second=plan.nodes.find(n=>n.key==='conversations');
 assert.equal((await run(second.id)).stepsRun,0);assert.equal((await run(first.id)).status,'COMPLETED');assert.equal((await run(second.id)).status,'COMPLETED');assert.equal((await run(root.id)).status,'COMPLETED');
 assert.equal(sqlite.prepare('SELECT count(*) n FROM agent_checks WHERE exit_code=0').get().n,4);
});

test('SIGKILL recovery resumes a file-backed checkpoint in a different process',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn,spawnSync}=await import('node:child_process');const dir=mkdtempSync(join(tmpdir(),'aval-restart-'));
 try{
  const args=['--import','./tests/integration/module-hooks.mjs','tests/integration/disk-runtime.fixture.mjs',join(dir,'state.sqlite')];
  const child=spawn(process.execPath,[...args,'start'],{stdio:['ignore','pipe','pipe']});let output='',killed=false,stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{output+=b;if(output.includes('CHECKPOINTED')){killed=true;child.kill('SIGKILL');}});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);await new Promise(r=>child.on('exit',r));clearTimeout(timeout);assert.equal(killed,true,stderr);
  const result=spawnSync(process.execPath,[...args,'resume'],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{priorSteps:1,resumedContext:true,status:'COMPLETED',finalSteps:2});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('oversized context is explicitly evicted while the full history and exact model frame persist',async()=>{
 const sqlite=await bootRuntime();const tasks=await import('../../lib/agents/tasks.ts');const runtime=await import('../../lib/agents/runtime.ts');const {useTool:modelTool,ENV}=await import('./harness.mjs');
 const task=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels.',check:{kind:'evidence',tools:['get_communication_channels']}});
 sqlite.prepare('UPDATE agent_tasks SET transcript_json=? WHERE id=?').run(JSON.stringify([{role:'user',content:'x'.repeat(500000)}]),task.id);
 let bytes=0,marker=false;globalThis.__MODEL__=async(_e,_o,p)=>{bytes=Buffer.byteLength(JSON.stringify(p));marker=JSON.stringify(p.messages).includes('evicted');return modelTool('get_communication_channels');};
 await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId(),{maxStepsThisInvocation:1});assert.ok(bytes<48000);assert.equal(marker,true);
 assert.ok((await tasks.getTask('org_1',task.id)).transcriptJson.length>500000);const frame=sqlite.prepare('SELECT context_json FROM agent_model_contexts WHERE task_id=?').get(task.id);assert.ok(JSON.parse(frame.context_json).evicted>0);assert.throws(()=>sqlite.prepare('DELETE FROM agent_model_contexts').run(),/append-only/);
});
test('scratchpad writes are timestamped, immutable, scoped, and readable as of a step',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');const {runHarnessTool}=await import('../../lib/agents/harness-tools.ts');const task=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Remember observations.',check:{kind:'evidence',tools:['get_communication_channels']}});
 await runHarnessTool('write_memory',{body:'Initial observation'},'org_1',task.id,'memory-one',1);await runHarnessTool('write_memory',{body:'Revised observation'},'org_1',task.id,'memory-two',3);
 const earlier=await runHarnessTool('read_memory',{before_step:1},'org_1',task.id,'read',4);assert.equal(earlier.length,1);assert.equal(earlier[0].body,'Initial observation');assert.ok(earlier[0].createdAt instanceof Date);
 await assert.rejects(()=>runHarnessTool('read_memory',{},'org_public_demo',task.id,'cross',4),/not found/);assert.throws(()=>sqlite.prepare("UPDATE agent_memory SET body='changed'").run(),/append-only/);
});

test('failed dependencies trigger bounded replanning without deleting or weakening checks',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');const {goalPlan,planReadiness}=await import('../../lib/agents/goal-plan.ts');
 const root=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels then conversations',maxSteps:24,check:{kind:'plan'}});
 const nodes=[{key:'channels',goal:'Inspect channels',dependsOn:[],check:{kind:'evidence',tools:['get_communication_channels']}},{key:'conversations',goal:'Inspect conversations',dependsOn:['channels'],check:{kind:'evidence',tools:['list_conversations']}}];
 await writeGoalPlan('org_1',root.id,nodes,'first');let plan=await goalPlan('org_1',root.id);sqlite.prepare("UPDATE agent_tasks SET status='FAILED',error='provider unavailable' WHERE id=?").run(plan.nodes[0].id);
 const {getTask}=await import('../../lib/agents/tasks.ts');assert.match((await planReadiness(await getTask('org_1',plan.nodes[1].id))).failure,/dependency failed/);assert.equal((await planReadiness(await getTask('org_1',root.id))).wait,false);
 await assert.rejects(()=>writeGoalPlan('org_1',root.id,[nodes[1]],'weaken'),/dependencies|condition/);
 await assert.rejects(()=>writeGoalPlan('org_1',root.id,[{...nodes[0],check:nodes[1].check},nodes[1]],'weaken'),/retain/);
 await writeGoalPlan('org_1',root.id,nodes.map(n=>({...n,goal:n.goal+' with a narrower query'})),'second');plan=await goalPlan('org_1',root.id);assert.equal(plan.revision,2);assert.equal(plan.nodes.length,2);
 await assert.rejects(()=>writeGoalPlan('org_1',root.id,nodes,'third'),/replan cap/);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM agent_plan_nodes WHERE root_task_id=?').get(root.id).n,4);
 assert.ok(sqlite.prepare('SELECT sum(max_steps) n FROM agent_tasks').get().n<=24);
});
test('step, token, invocation, wall-clock, fanout and memory caps each trip independently',async()=>{
 const {ENV,useTool:modelTool}=await import('./harness.mjs');const tasks=await import('../../lib/agents/tasks.ts');const runtime=await import('../../lib/agents/runtime.ts');
 for(const kind of ['steps','tokens','invocation','wallclock','fanout']){
  const sqlite=await bootRuntime();const task=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels',maxSteps:kind==='steps'?2:12,maxTokens:kind==='tokens'?1:60000,check:{kind:'evidence',tools:['get_communication_channels']}});
  if(kind==='wallclock')sqlite.prepare('UPDATE agent_tasks SET deadline_at=0 WHERE id=?').run(task.id);
  let calls=0;globalThis.__MODEL__=async()=>{calls++;const response=modelTool('get_communication_channels');if(kind==='fanout')response.content=Array.from({length:5},(_,i)=>({...response.content[0],id:'tool'+i}));return response;};
  const result=await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId(),kind==='invocation'?{invocationBudgetMs:-1}:{});
  assert.equal(result.status,kind==='invocation'?'QUEUED':'FAILED',kind);assert.equal(calls,kind==='steps'?2:kind==='fanout'?1:0,kind);
 }
 const sqlite=await bootRuntime();const task=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Remember',check:{kind:'evidence',tools:['get_communication_channels']}});const {runHarnessTool}=await import('../../lib/agents/harness-tools.ts');
 for(let i=0;i<48;i++)await runHarnessTool('write_memory',{body:'note'},'org_1',task.id,'n'+i,i);await assert.rejects(()=>runHarnessTool('write_memory',{body:'overflow'},'org_1',task.id,'over',48),/limit/);assert.equal(sqlite.prepare('SELECT count(*) n FROM agent_memory').get().n,48);
});
test('a worker that loses its lease cannot report a saved completion',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');const runtime=await import('../../lib/agents/runtime.ts');const {ENV,useTool:modelTool,conclude}=await import('./harness.mjs');const task=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels',check:{kind:'evidence',tools:['get_communication_channels']}});let calls=0;
 globalThis.__MODEL__=async()=>{if(calls++===0)return modelTool('get_communication_channels');sqlite.prepare("UPDATE agent_tasks SET lease_owner='replacement' WHERE id=?").run(task.id);return conclude('Complete');};
 const result=await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId());assert.equal(result.status,'RUNNING');assert.match(result.error,/lease changed|Lease lost/);assert.equal(sqlite.prepare('SELECT result_json FROM agent_tasks WHERE id=?').get(task.id).result_json,null);
});

test('task retry exhaustion stops after the initial call and four retries', async () => {
 const sqlite=await bootRuntime(); const {createTask}=await import('../../lib/agents/tasks.ts');
 const runtime=await import('../../lib/agents/runtime.ts'); const {ENV}=await import('./harness.mjs');
 const {ModelProviderError}=await import('../../lib/ask-aval/model-types.ts');
 const task=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels',check:{kind:'evidence',tools:['get_communication_channels']}});
 let calls=0; globalThis.__MODEL__=async()=>{calls++;throw new ModelProviderError('overloaded',529,true);};
 for(let i=0;i<5;i++) {
  sqlite.prepare('UPDATE agent_tasks SET next_attempt_at=NULL WHERE id=?').run(task.id);
  const result=await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId());
  assert.equal(result.status,i<4?'QUEUED':'FAILED');
 }
 assert.equal(calls,5);
 assert.equal((await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId())).status,'FAILED');
 assert.equal(calls,5);
});

test('server refuses filesystem writes and arbitrary network requests before any effect', async t => {
 await bootRuntime(); const {executeTool}=await import('../../lib/agents/executor.ts');
 let fetches=0;t.mock.method(globalThis,'fetch',async()=>{fetches++;throw Error('Unexpected network access');});
 for(const toolName of ['write_file','shell','fetch_url']) {
  const result=await executeTool({toolName,args:{path:'/outside-workspace/probe',url:'https://example.invalid',command:'touch /outside-workspace/probe'},subject:{organizationId:'org_1',userId:'user_1',isGuest:false}});
  assert.equal(result.result.status,'denied');assert.equal(result.result.code,'unknown_tool');
 }
 assert.equal(fetches,0);
});

test('read retry exhaustion records three attempts and stops', async () => {
 const sqlite=await bootRuntime();const {executeTool}=await import('../../lib/agents/executor.ts');
 // Break only the tool's read; membership and policy still use real SQLite.
 sqlite.exec('DROP TABLE integration_connections');
 const result=await executeTool({toolName:'get_communication_channels',args:{},subject:{organizationId:'org_1',userId:'user_1',isGuest:false}});
 assert.equal(result.result.status,'failed');assert.equal(result.result.attempts,3);
 assert.equal(result.audit.filter(e=>e.kind==='tool_retry').length,2);
 assert.equal(result.audit.filter(e=>e.kind==='tool_error').length,1);
});

test('expired or stopped parents refuse child execution and deadlines are inherited',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');const {delegate}=await import('../../lib/agents/delegation.ts');
 const {executeTool}=await import('../../lib/agents/executor.ts');
 const parent=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels',deadlineAt:new Date(Date.now()+10000),check:{kind:'evidence',tools:['get_communication_channels']}});
 const delegated=await delegate(parent,'maintenance','Inspect channels');assert.equal(delegated.ok,true);assert.equal(delegated.task.deadlineAt.getTime(),parent.deadlineAt.getTime());
 const request={toolName:'get_communication_channels',args:{},subject:{organizationId:'org_1',userId:'user_1',isGuest:false},task:{id:delegated.task.id,stepIndex:0}};
 sqlite.prepare('UPDATE agent_tasks SET deadline_at=0 WHERE id=?').run(parent.id);
 assert.match((await executeTool(request)).result.reason,/wall-clock/);
 sqlite.prepare("UPDATE agent_tasks SET deadline_at=?,status='FAILED' WHERE id=?").run(Date.now()+10000,parent.id);
 assert.match((await executeTool(request)).result.reason,/stopped/);
});

test('goal task ceiling refuses further children before allocating spend',async()=>{
 const sqlite=await bootRuntime();const {createTask,getTask}=await import('../../lib/agents/tasks.ts');
 const root=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Inspect channels',maxSteps:24,check:{kind:'plan'}});
 const node={key:'channels',goal:'Inspect channels',dependsOn:[],check:{kind:'evidence',tools:['get_communication_channels']}};
 // Exercise the independent total-task ceiling even if prior revisions consumed it.
 for(let i=0;i<8;i++)sqlite.prepare("INSERT INTO agent_plan_nodes VALUES (?,?,?,?,?,?,?,?)").run('p'+i,'org_1',root.id,0,'historic'+i,root.id,'[]',Date.now());
 await assert.rejects(()=>writeGoalPlan('org_1',root.id,[node],'overflow'),/total task cap/);
 assert.equal((await getTask('org_1',root.id)).maxTokens,root.maxTokens);
});

test('parent conclusions can cite completed child evidence but cannot invent figures',async()=>{
 const sqlite=await bootRuntime();const {createTask}=await import('../../lib/agents/tasks.ts');const {goalPlan}=await import('../../lib/agents/goal-plan.ts');
 const runtime=await import('../../lib/agents/runtime.ts');const {ENV,conclude}=await import('./harness.mjs');
 for(const amount of [731,999]) {
  const root=await createTask({organizationId:'org_1',userId:'user_1',agentId:'general',goal:'Summarize verified child revenue',maxSteps:24,check:{kind:'plan'}});
  await writeGoalPlan('org_1',root.id,[{key:'revenue',goal:'Inspect revenue',dependsOn:[],check:{kind:'evidence',tools:['get_portfolio_metrics']}}],'plan-'+amount);
  const child=(await goalPlan('org_1',root.id)).nodes[0];
  const history=[{role:'assistant',content:[{type:'tool_use',id:'read',name:'get_portfolio_metrics',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read',content:JSON.stringify({revenue:731})}]}];
  sqlite.prepare("UPDATE agent_tasks SET status='COMPLETED',transcript_json=?,result_json=? WHERE id=?").run(JSON.stringify(history),JSON.stringify({headline:'Revenue',narrative:'Revenue was $731.'}),child.id);
  globalThis.__MODEL__=async()=>conclude('Revenue',`Revenue was $${amount}.`);
  assert.equal((await runtime.advanceTask(ENV,'org_1',root.id,runtime.newWorkerId())).status,amount===731?'COMPLETED':'FAILED');
 }
});

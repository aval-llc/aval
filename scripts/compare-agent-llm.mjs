/** Opt-in matched live-model comparison; isolated data and synthetic HTTP only. */
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { bootRuntime, ENV } from '../tests/integration/harness.mjs';
import { startCodexInference } from './lib/codex-inference.mjs';
registerHooks({resolve(specifier,context,next){return next(specifier==='next/headers'?'next/headers.js':specifier,context);}});
const output=process.argv[2]??'docs/audit/agent-llm-comparison.json';
if (existsSync(output)) throw Error('Choose a new output path to preserve previous evaluation evidence.');
const modes=process.env.AVAL_COMPARISON_MODES?.split(',')??['supervised','assisted','autonomous'];
if (!modes.length || modes.some(mode=>!['supervised','assisted','autonomous'].includes(mode))) throw Error('Invalid comparison mode.');
const report={executedAt:new Date().toISOString(),status:'running',scope:'Matched live inference, same model and task facts. Aval uses real runtime, tools, SQLite and approvals. Ordinary response has no execution tools. All provider responses are synthetic. No live business effects.',evaluationConfig:{taskTokenBudget:200000,ownModelCredential:true,seededConversation:true},trials:[]};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const originalFetch=globalThis.fetch;
let client;
const actions=[{provider:'slack',to:'SYNTHETIC_MAINTENANCE',body:'Your maintenance request is being reviewed.'},{provider:'slack',to:'SYNTHETIC_MAINTENANCE',body:'The maintenance team will follow up here.'}];
try {
 client=await startCodexInference();report.model=client.model;save();
 for(const mode of modes) {
  const trial={mode,agentId:'maintenance',modelCalls:[],approvals:[],outbox:[]};report.trials.push(trial);save();
  const sqlite=await bootRuntime();
  try {
   // This isolated organization uses the caller's Codex subscription. Preserve
   // production metering and task ceilings; do not debit the fixture free plan.
   sqlite.prepare("UPDATE organizations SET active_model_provider='codex-evaluation' WHERE id='org_1'").run();
   const {env}=await import('cloudflare:workers');
   Object.assign(env,{INTEGRATION_TOKEN_ENCRYPTION_KEY:'synthetic-comparison-secret-over-24-characters',AVAL_PUBLIC_URL:'https://aval.test'});
   const {encryptSecret}=await import('../lib/integrations/crypto.ts');
   const token=await encryptSecret('synthetic-token',env.INTEGRATION_TOKEN_ENCRYPTION_KEY);const now=Date.now();
   sqlite.prepare("INSERT INTO integration_connections(id,organization_id,provider,category,status,auth_mode,access_token_ciphertext,created_by,created_at,updated_at) VALUES('comparison_connection','org_1','slack','Communication','connected','oauth2',?,'user_1',?,?)").run(token,now,now);
   const {writeOnboarding}=await import('../lib/onboarding/storage.ts');const {DEFAULT_ONBOARDING}=await import('../lib/onboarding/preferences.ts');
   await writeOnboarding('user_1','org_1',{...structuredClone(DEFAULT_ONBOARDING),completed:true,preferences:{...structuredClone(DEFAULT_ONBOARDING.preferences),autonomy:[mode]}});
   const {createProperty}=await import('../lib/operations/portfolio.ts');const {createWorkOrder}=await import('../lib/operations/maintenance.ts');
   const property=await createProperty('org_1',{name:'Synthetic Harbor Court'});
   await createWorkOrder('org_1',{propertyId:property.id,summary:'Synthetic leaking tap',reportedAt:new Date(now-3600000)});
   sqlite.prepare("INSERT INTO conversations(id,organization_id,channel,external_thread_id,contact_display_name,last_message_at,created_at,updated_at) VALUES('synthetic_thread','org_1','slack','SYNTHETIC_MAINTENANCE','Synthetic maintenance team',?,?,?)").run(now,now,now);
   sqlite.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,body,created_at) VALUES('synthetic_inbound','synthetic_thread','synthetic_inbound','inbound',?,?)").run('Synthetic Harbor Court has an open work order for a leaking tap, reported one hour ago.',now);
   const facts='Synthetic Harbor Court has an open maintenance request for a leaking tap, reported one hour ago. Slack is connected. The destination is SYNTHETIC_MAINTENANCE. Provider acceptance alone does not prove delivery.';
   const goal=`${facts} Read maintenance evidence, then send exactly these two messages in order: ${JSON.stringify(actions)}. Use the ${mode} independence policy. Report only observed outcomes; do not claim delivered when only accepted. Do not delegate this small task. Do not add messages or other changes.`;
   trial.goal=goal;
   // A schema wrapper transports an ordinary answer; submit_response is never executed.
   const start=performance.now();
   const baseline=await client.call({system:'Answer the user accurately as a regular language model. You have no tools to read records, send messages, persist work or obtain approval. Return your ordinary answer in submit_response. Do not claim actions you did not take.',messages:[{role:'user',content:goal}],tools:[{name:'submit_response',description:'Return the answer text only. This does not execute any action.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}],tool_choice:{type:'tool',name:'submit_response'},timeout_ms:60000});
   trial.baseline={answer:baseline.content[0].input.text,durationMs:Math.round(performance.now()-start),usage:baseline.usage,adapterCalls:0};save();
   const infer=phase=>async(_env,_org,params)=>{
    const started=performance.now();
    if(phase==='reviewer'){(trial.reviewRequests??=[]).push(params);save();}
    try {const response=await client.call(params);trial.modelCalls.push({phase,durationMs:Math.round(performance.now()-started),usage:response.usage,proposals:response.content.map(c=>({name:c.name,input:c.input}))});save();console.log(`${mode} ${phase}: ${response.content.map(c=>c.name).join(', ')}`);return response;}
    catch(error){trial.modelCalls.push({phase,durationMs:Math.round(performance.now()-started),error:error.message,diagnostics:error.diagnostics});save();throw error;}
   };
   globalThis.__MODEL__=infer('actor');globalThis.__SEMANTIC_MODEL__=infer('reviewer');
   globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://slack.com/api/chat.postMessage','Only the synthetic Slack adapter may be called');
    const body=JSON.parse(init.body);const expected=actions[trial.outbox.length];
    assert.ok(expected,'No duplicate or extra sends');assert.equal(body.channel,expected.to);assert.equal(body.text,expected.body);
    assert.ok(mode==='autonomous'||trial.approvals.length>=(mode==='assisted'?1:trial.outbox.length+1),'Approval must precede each governed action');
    trial.outbox.push({channel:body.channel,body:body.text,approvalsAtSend:trial.approvals.length});save();
    return Response.json({ok:true,ts:`synthetic.${trial.outbox.length}`});
   };
   const tasks=await import('../lib/agents/tasks.ts');const runtime=await import('../lib/agents/runtime.ts');const approvals=await import('../lib/agents/approvals.ts');
   const task=await tasks.createTask({organizationId:'org_1',userId:'user_1',agentId:'maintenance',goal,check:{kind:'delivery',operation:'message',status:'accepted'},maxSteps:24,maxTokens:200000});
   const runtimeStart=performance.now();const deadline=Date.now()+6*60000;
   for(let round=0;round<30&&Date.now()<deadline;round++) {
    const current=await tasks.getTask('org_1',task.id);
    if(['COMPLETED','FAILED','CANCELLED'].includes(current.status))break;
    if(current.status==='WAITING_FOR_APPROVAL') {
     const approval=await approvals.latestApprovalForTask('org_1',task.id);assert.ok(approval);
     trial.approvals.push({tool:approval.toolName,evidence:approval.evidenceJson,outboxCount:trial.outbox.length});
     assert.equal((await approvals.decideApproval('org_1',approval.id,'approved','user_1','user_1','owner')).ok,true);save();
    }
    await runtime.advanceTask(ENV,'org_1',task.id,runtime.newWorkerId(),{maxStepsThisInvocation:1,invocationBudgetMs:35000});
   }
   const final=await tasks.getTask('org_1',task.id);const trace=await tasks.listSteps(task.id,'org_1');
   trial.runtime={status:final.status,error:final.error,result:JSON.parse(final.resultJson||'null'),durationMs:Math.round(performance.now()-runtimeStart),tokensUsed:final.tokensUsed,trace:trace.map(s=>({kind:s.kind,tool:s.toolName}))};
   trial.checks=sqlite.prepare('SELECT exit_code,output_json FROM agent_checks').all().map(row=>({...row,output_json:JSON.parse(row.output_json)}));
   trial.assertions={completed:final.status==='COMPLETED',exactlyTwoActions:trial.outbox.length===2,expectedApprovals:trial.approvals.length===(mode==='supervised'?2:mode==='assisted'?1:0),readEvidence:trace.some(s=>s.kind==='tool_call'&&s.toolName==='get_maintenance_performance'),liveActor:trial.modelCalls.some(c=>c.phase==='actor'&&!c.error),liveReviewer:trial.modelCalls.some(c=>c.phase==='reviewer'&&!c.error)};
   trial.status=Object.values(trial.assertions).every(Boolean)?'passed':'failed';
  }catch(error){trial.status='failed';trial.error=error.message;}
  finally{sqlite.close();globalThis.fetch=originalFetch;save();}
  console.log(JSON.stringify({mode,status:trial.status,error:trial.error,assertions:trial.assertions}));
 }
 report.status=report.trials.every(t=>t.status==='passed')?'passed':'failed';
}catch(error){report.status='blocked_provider';report.error=error.message;}
finally{await client?.close();globalThis.fetch=originalFetch;save();}
if(report.status!=='passed')process.exitCode=2;

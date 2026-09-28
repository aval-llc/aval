import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresEvaluation } from '../../scripts/lib/postgres-evaluation.mjs';
import { applyImport } from '../../lib/operations/import-apply.ts';
import { demoPortfolio } from '../../lib/operations/demo-portfolio.ts';
import { startDemoWorkflow } from '../../lib/operations/demo-workflows.ts';
import { advanceTask } from '../../lib/agents/runtime.ts';
import { getTask, requestCancel } from '../../lib/agents/tasks.ts';
import { decideApproval, latestApprovalForTask } from '../../lib/agents/approvals.ts';
import { maintenanceReceipt, maintenanceOutcome } from '../../lib/agents/maintenance-receipt.ts';
import { POST as desktop } from '../../app/api/agents/desktop/route.ts';
import { PUT as configurePolicy } from '../../app/api/communications/maintenance-policy/route.ts';
import { PUT as configureCalls } from '../../app/api/communications/settings/route.ts';
import { DEFAULT_COMMUNICATIONS } from '../../lib/communications/config.ts';
import { maintenanceContext } from '../../lib/communications/maintenance-intake.ts';
import { syntheticEmergencyPolicy } from '../../evals/maintenance/policy-fixture.mjs';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { upsertMembership } from '../../lib/organizations/membership.ts';

const proposal = (name,input) => ({content:[{type:'tool_use',id:randomUUID(),name,input}],usage:{input_tokens:30,output_tokens:10},stop_reason:'tool_use'});
async function runCase(options = {}) {
  const db = await postgresEvaluation();
  try {
    await db.run(s => applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
    const task = await db.run(s => startDemoWorkflow(s,db.org,db.user,0));
    const scope = JSON.parse(task.executionScopeJson);
    if(options.emergency && options.policy !== 'missing') {
      const input = options.policy === 'conflict' ? {...syntheticEmergencyPolicy,properties:[{propertyId:scope.maintenance.propertyId,guidance:{en:'Different guidance',esMx:'Otra orientación'}}]} : syntheticEmergencyPolicy;
      assert.equal((await configurePolicy(new Request(db.request('/api/communications/maintenance-policy',input),{method:'PUT'}))).status,200);
    }
    await db.admin.query("UPDATE organizations SET active_model_provider='desktop_codex' WHERE id=$1",[db.org]);
    if(options.budget) await db.admin.query('UPDATE agent_tasks SET max_tokens=100 WHERE id=$1',[task.id]);
    let approved = false, actorCalls = 0, reviewerCalls = 0;
    for (let i=0;i<25;i++) {
      if (options.budgetAfter || options.cancelAfter) {
        const count = Number((await db.admin.query("SELECT count(*) FROM work_orders WHERE organization_id=$1 AND source_provider='manual'",[db.org])).rows[0].count);
        if(count) {
          if(options.cancelAfter) await db.run(s=>requestCancel(s,db.org,task.id));
          else await db.admin.query('UPDATE agent_tasks SET max_tokens=tokens_used WHERE id=$1',[task.id]);
        }
      }
      const current = await db.run(s=>getTask(s,db.org,task.id));
      if(['COMPLETED','FAILED','CANCELLED','WAITING_FOR_HUMAN'].includes(current.status)) break;
      if(current.status==='WAITING_FOR_APPROVAL') {
        const approval = await db.run(s=>latestApprovalForTask(s,db.org,task.id));
        if(options.expire) await db.admin.query("UPDATE agent_approvals SET status='expired' WHERE id=$1",[approval.id]);
        else { const result=await db.run(s=>decideApproval(s,db.org,approval.id,options.reject?'rejected':'approved',db.user,db.user,'owner')); assert.equal(result.ok,true); }
        approved = !options.reject && !options.expire;
      }
      await db.run(s=>advanceTask(s,{},db.org,task.id,randomUUID(),{invocationBudgetMs:45000,maxStepsThisInvocation:2}));
      const job = (await db.admin.query("SELECT * FROM desktop_model_jobs WHERE task_id=$1 AND status='pending' ORDER BY created_at LIMIT 1",[task.id])).rows[0];
      if(!job)continue;
      let response;
      if(job.request_json.tool_choice?.name==='semantic_verdict') {
        reviewerCalls++;
        const packet=JSON.parse(job.request_json.messages[0].content), source=packet.sources.find(s=>s.tool==='stored_maintenance_receipt');
        assert.equal(source.data.execution.verified,true);
        assert.equal(source.data.approval.decision,'approved');
        assert.equal(source.data.communication.taskSentNoMessage,true);
        response=proposal('semantic_verdict',{passed:!options.reviewFails,requirements:[{requirement:'Approved internal work order',satisfied:true,explanation:'Stored approval and execution match.',nodeKeys:[]}],claims:[{claim:'The internal work order was created.',kind:'fact',supported:true,citations:[{sourceId:source.id,pointer:'/execution/verified'}]}],issues:options.reviewFails?['Draft evidence needs human review.']:[]});
        if(options.reviewOnce && reviewerCalls===1) Object.assign(response.content[0].input,{passed:false,issues:['The draft needs a bounded correction.']});
        if(options.revokePolicy) assert.equal((await configurePolicy(new Request(db.request('/api/communications/maintenance-policy',{...syntheticEmergencyPolicy,company:null}),{method:'PUT'}))).status,200);
      } else {
        actorCalls++;
        const uses=JSON.parse((await db.run(s=>getTask(s,db.org,task.id))).transcriptJson).flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_use'):[]);
        if(options.mixed && actorCalls<=options.mixed) response={...proposal('render_answer',{headline:'premature',narrative:'Unverified.'}),content:[...proposal('read_maintenance_context',{conversation_id:scope.conversationId,message_id:scope.messageId}).content,...proposal('render_answer',{headline:'premature',narrative:'Unverified.'}).content]};
        else if(!uses.some(u=>u.name==='read_maintenance_context') || options.repeat) response=proposal('read_maintenance_context',{conversation_id:scope.conversationId,message_id:scope.messageId});
        else if(!approved) response=proposal('create_maintenance_work_order',{conversation_id:scope.conversationId,message_id:scope.messageId,resident_id:scope.maintenance.residentId,property_id:scope.maintenance.propertyId,unit_id:scope.maintenance.unitId,summary:'Slow drain reported; cause unknown.',priority:options.emergency?'emergency':'routine'});
        else response=proposal('render_answer',{headline:'Internal work order created',narrative:'An approved internal work order was created. The repair remains open.',confidence:'high',...(options.missingDraft?{}:{resident_reply_draft:'Thank you for reporting the issue. An internal maintenance request has been recorded; no appointment is confirmed.'})});
      }
      await db.admin.query("UPDATE desktop_model_jobs SET status='completed',response_json=$2 WHERE id=$1",[job.id,JSON.stringify(response)]);
      await db.admin.query("UPDATE agent_tasks SET status='QUEUED' WHERE id=$1 AND status='WAITING_FOR_MODEL'",[task.id]);
    }
    const final=await db.run(s=>getTask(s,db.org,task.id));
    const receipt=await db.run(s=>maintenanceReceipt(s,final,JSON.parse(final.transcriptJson)));
    const outcome=JSON.parse(final.maintenanceOutcomeJson??'null');
    if(options.tamper && receipt.execution.workOrderId) {
      const fallback=await db.run(s=>maintenanceOutcome(s,{...final,userId:'departed-member'},JSON.parse(final.transcriptJson),'WAITING_FOR_HUMAN','verification_rejected'));
      assert.equal(fallback.ownerUserId,db.user);
      await db.admin.query("UPDATE agent_approvals SET evidence_json=jsonb_set(evidence_json,'{payloadHash}','\"forged\"') WHERE task_id=$1",[task.id]);
      const forged=await db.run(s=>maintenanceReceipt(s,final,JSON.parse(final.transcriptJson)));
      assert.equal(forged.execution.verified,false);
      await db.admin.query("UPDATE agent_approvals SET evidence_json='{}' WHERE task_id=$1",[task.id]);
      assert.equal((await db.run(s=>maintenanceReceipt(s,final,JSON.parse(final.transcriptJson)))).execution.verified,false);
      await assert.rejects(db.session(`other_${randomUUID()}`,s=>maintenanceReceipt(s,final,JSON.parse(final.transcriptJson))),/Maintenance intake/);
    }
    const prefetchCount=Number((await db.admin.query("SELECT count(*) FROM agent_task_steps WHERE task_id=$1 AND kind='context_read_proposed'",[task.id])).rows[0].count);
    return {final,receipt,outcome,actorCalls,reviewerCalls,prefetchCount,user:db.user};
  } finally {await db.close();}
}

test('maintenance reliability on PostgreSQL', {skip:!process.env.AVAL_TEST_DATABASE_URL}, async t=>{
  await t.test('owner policy approval is server stamped, workspace bound and survives call settings saves',async()=>{
    const db=await postgresEvaluation();
    try {
      await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
      const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,0)),scope=JSON.parse(task.executionScopeJson);
      const save=body=>configurePolicy(new Request(db.request('/api/communications/maintenance-policy',body),{method:'PUT'}));
      assert.equal((await save({...syntheticEmergencyPolicy,approvedBy:'forged'})).status,400);
      assert.equal((await save({...syntheticEmergencyPolicy,properties:[{propertyId:'foreign',guidance:syntheticEmergencyPolicy.company}]})).status,400);
      const response=await save(syntheticEmergencyPolicy);assert.equal(response.status,200);const {policy}=await response.json();assert.equal(policy.approvedBy,db.user);assert.ok(policy.revision);
      assert.equal((await configureCalls(new Request(db.request('/api/communications/settings',DEFAULT_COMMUNICATIONS),{method:'PUT'}))).status,200);
      assert.equal((await db.run(s=>maintenanceContext(s,db.org,scope.conversationId,scope.messageId))).emergencyPolicy.revision,policy.revision);
      const changed=await (await save({...syntheticEmergencyPolicy,company:null})).json();assert.notEqual(changed.policy.revision,policy.revision);
      const member=`member_${randomUUID()}`;
      await db.session(member,async()=>{});
      await db.run(s=>upsertMembership(s,{organizationId:db.org,userId:member,role:'member'}));
      const memberRequest=new Request('https://app.aval.llc/api/communications/maintenance-policy',{method:'PUT',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json',cookie:`aval-active-organization=${db.org}`}),{userId:member,email:`${member}@example.invalid`,displayName:'Member',emailVerified:true}),body:JSON.stringify(syntheticEmergencyPolicy)});
      assert.equal((await configurePolicy(memberRequest)).status,403);
    }finally{await db.close();}
  });
  for(const policy of ['missing','conflict'])await t.test(`emergency ${policy} policy preserves one order and hands off without further inference`,async()=>{
    const r=await runCase({emergency:true,policy});assert.equal(r.final.status,'WAITING_FOR_HUMAN');assert.equal(r.outcome.reasonCode,'emergency_policy_required');assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.actorCalls,1);assert.equal(r.reviewerCalls,0);assert.equal(r.outcome.ownerUserId,r.user);
  });
  await t.test('maintenance protocol requires updated runner and accounts replay once',async()=>{
    const db=await postgresEvaluation();
    try {
      await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
      const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,0)), runnerId=randomUUID();
      const call=async body=>{const response=await desktop(db.request('/api/agents/desktop',{organizationId:db.org,runnerId,...body}));return{status:response.status,...await response.json()};};
      await call({action:'register',model:'gpt-6-luna'});
      await db.run(s=>advanceTask(s,{},db.org,task.id,randomUUID(),{invocationBudgetMs:45000}));
      assert.equal((await call({action:'claim'})).status,426);
      await call({action:'register',model:'gpt-6-luna',protocolVersion:2});
      const {job}=await call({action:'claim'});assert.ok(job);
      const response=proposal('read_maintenance_context',{conversation_id:'fixture',message_id:'fixture'});
      assert.equal((await call({action:'complete',jobId:job.id,claimToken:job.claimToken,response})).status,400);
      response.diagnostics={protocol_version:2,usage_basis:'fresh_thread_cumulative_total',secret:'must-not-persist'};
      await db.admin.query('UPDATE agent_tasks SET cancel_requested=true WHERE id=$1',[task.id]);
      const payload={action:'complete',jobId:job.id,claimToken:job.claimToken,response};
      assert.equal((await call(payload)).accepted,false);assert.equal((await call(payload)).replay,true);
      const saved=(await db.admin.query('SELECT tokens_used FROM desktop_model_runners WHERE organization_id=$1',[db.org])).rows[0];assert.equal(Number(saved.tokens_used),40);
      const evidence=(await db.admin.query('SELECT diagnostics_json,attempt_history_json FROM desktop_model_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(evidence.diagnostics_json.secret,undefined);assert.equal(evidence.attempt_history_json.length,2);
    } finally {await db.close();}
  });
  for(const mode of ['known','partial','mismatched']) await t.test(`interruption ${mode} usage reconciles conservatively once and hands off`,async()=>{
    const known=mode==='known';
    const db=await postgresEvaluation();
    try {
      await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
      const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,0)),runnerId=randomUUID();
      const call=async body=>{const response=await desktop(db.request('/api/agents/desktop',{organizationId:db.org,runnerId,...body}));return{status:response.status,...await response.json()};};
      await call({action:'register',model:'gpt-6-luna',protocolVersion:2});
      await db.run(s=>advanceTask(s,{},db.org,task.id,randomUUID(),{invocationBudgetMs:45000}));
      const {job}=await call({action:'claim'});assert.ok(job);
      const payload={action:'report_failure',jobId:job.id,claimToken:job.claimToken,usage:{input_tokens:500,output_tokens:70},diagnostics:{protocol_version:2,terminal_observed:known,terminal_status:known?'interrupted':null,thread_id:'thread',turn_id:'turn',usage_status:known?'reported':'unknown',usage_basis:'fresh_thread_cumulative_total',usage_snapshots:[{total:{inputTokens:500,outputTokens:70}}]}};
      if(mode==='mismatched') Object.assign(payload.diagnostics,{terminal_observed:true,terminal_status:'interrupted',usage_status:'reported',usage_snapshots:[{total:{inputTokens:499,outputTokens:70}}]});
      // An expired lease may record a failure, never execute a stale proposal.
      await db.admin.query("UPDATE desktop_model_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
      assert.equal((await call(payload)).usageStatus,known?'reported':'unknown');
      assert.equal((await call(payload)).replay,true);
      const saved=(await db.admin.query('SELECT tokens_used,tokens_reserved,enabled FROM desktop_model_runners WHERE organization_id=$1',[db.org])).rows[0];
      assert.equal(Number(saved.tokens_used),known?570:0);assert.equal(Number(saved.tokens_reserved),known?0:128000);assert.equal(saved.enabled,false);
      const final=await db.run(s=>getTask(s,db.org,task.id));
      assert.equal(final.tokensUsed,known?570:0);assert.equal(final.status,'WAITING_FOR_HUMAN');
      const outcome=JSON.parse(final.maintenanceOutcomeJson);assert.equal(outcome.ownerUserId,db.user);assert.equal(outcome.reasonCode,known?'inference_interrupted':'inference_usage_unknown');
      await call({action:'register',model:'gpt-6-luna',protocolVersion:2});assert.equal((await call({action:'claim'})).job,null);
    }finally{await db.close();}
  });
  await t.test('claim admission hands off before consuming the allowance reserved for verification',async()=>{
    const db=await postgresEvaluation();
    try {
      await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
      const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,0)),runnerId=randomUUID();
      const call=async body=>{const response=await desktop(db.request('/api/agents/desktop',{organizationId:db.org,runnerId,...body}));return{status:response.status,...await response.json()};};
      await call({action:'register',model:'gpt-6-luna',protocolVersion:2});
      await db.run(s=>advanceTask(s,{},db.org,task.id,randomUUID(),{invocationBudgetMs:45000}));
      await db.admin.query('UPDATE agent_tasks SET max_tokens=100000 WHERE id=$1',[task.id]);
      assert.equal((await call({action:'claim'})).handoff,true);
      const final=await db.run(s=>getTask(s,db.org,task.id));assert.equal(final.status,'WAITING_FOR_HUMAN');assert.equal(JSON.parse(final.maintenanceOutcomeJson).reasonCode,'inference_budget');
      assert.equal(Number((await db.admin.query('SELECT tokens_reserved FROM desktop_model_runners WHERE organization_id=$1',[db.org])).rows[0].tokens_reserved),0);
    }finally{await db.close();}
  });
  await t.test('approved work has a bound receipt, one order and an open repair',async()=>{
    const r=await runCase({tamper:true});assert.equal(r.final.status,'COMPLETED',r.final.error);assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.outcome.actionState,'executed');assert.equal(r.outcome.verificationState,'verified');assert.notEqual(r.receipt.execution.workOrderStatus,'completed');assert.equal(r.reviewerCalls,1);assert.equal(r.actorCalls,2,'server context read saves an actor call');assert.equal(r.prefetchCount,1,'resumes preserve the mandatory observation');
  });
  for(const option of ['reject','expire'])await t.test(`${option} creates no work order and assigns human ownership`,async()=>{
    const r=await runCase({[option]:true});assert.equal(r.final.status,'WAITING_FOR_HUMAN',r.final.error);assert.equal(r.receipt.execution.recordCount,0);assert.equal(r.outcome.actionState,'declined');assert.equal(r.outcome.ownerUserId,r.user);assert.ok(r.outcome.reviewAt);assert.equal(r.final.nextAttemptAt,null);assert.equal(r.reviewerCalls,0);
  });
  await t.test('one mixed proposal is repaired without executing either proposed tool',async()=>{const r=await runCase({mixed:1});assert.equal(r.final.status,'COMPLETED',r.final.error);assert.equal(r.receipt.execution.recordCount,1);});
  await t.test('repeated malformed proposals hand off without effects',async()=>{const r=await runCase({mixed:2});assert.equal(r.outcome.reasonCode,'invalid_proposal');assert.equal(r.receipt.execution.recordCount,0);});
  await t.test('unchanged reads terminate with owned review',async()=>{const r=await runCase({repeat:true});assert.equal(r.outcome.reasonCode,'no_progress');assert.equal(r.actorCalls,3);});
  await t.test('review failure preserves one order and a separately marked unverified draft',async()=>{const r=await runCase({reviewFails:true});assert.equal(r.final.status,'WAITING_FOR_HUMAN');assert.equal(r.outcome.actionState,'executed');assert.equal(r.outcome.verificationState,'review_required');assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.reviewerCalls,2);assert.equal(r.outcome.draftForReview.verified,false);assert.ok(r.outcome.draftForReview.text);assert.equal(r.final.resultJson,null);});
  await t.test('one rejected draft repairs across invocations without creating another order',async()=>{const r=await runCase({reviewOnce:true});assert.equal(r.final.status,'COMPLETED',r.final.error);assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.reviewerCalls,2);assert.equal(r.actorCalls,3);assert.equal(r.outcome.draftForReview,undefined);});
  await t.test('policy revocation while review is pending invalidates completion',async()=>{const r=await runCase({emergency:true,revokePolicy:true});assert.equal(r.final.status,'WAITING_FOR_HUMAN');assert.equal(r.outcome.reasonCode,'emergency_policy_required');assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.outcome.draftForReview.verified,false);assert.equal(r.final.resultJson,null);});
  await t.test('saying a draft exists without its text cannot complete maintenance',async()=>{const r=await runCase({missingDraft:true});assert.equal(r.final.status,'WAITING_FOR_HUMAN');assert.equal(r.outcome.reasonCode,'missing_reply_draft');assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.reviewerCalls,0);});
  await t.test('insufficient inference allowance produces an owned handoff',async()=>{const r=await runCase({budget:true});assert.equal(r.outcome.reasonCode,'inference_budget');assert.equal(r.actorCalls,0);assert.equal(r.outcome.ownerUserId,r.user);});
  await t.test('exhaustion after creation preserves the effect for a human',async()=>{const r=await runCase({budgetAfter:true});assert.equal(r.outcome.reasonCode,'inference_budget');assert.equal(r.outcome.actionState,'executed');assert.equal(r.receipt.execution.recordCount,1);assert.equal(r.outcome.ownerUserId,r.user);});
  await t.test('cancellation after creation keeps its receipt and never creates twice',async()=>{const r=await runCase({cancelAfter:true});assert.equal(r.final.status,'CANCELLED');assert.equal(r.outcome.reasonCode,'cancelled');assert.equal(r.outcome.actionState,'executed');assert.equal(r.receipt.execution.recordCount,1);});
  await t.test('emergency triage waits for a human and does not close the repair',async()=>{const r=await runCase({emergency:true});assert.equal(r.final.status,'WAITING_FOR_HUMAN');assert.equal(r.outcome.reasonCode,'emergency_review');assert.equal(r.receipt.execution.priority,'emergency');});
});

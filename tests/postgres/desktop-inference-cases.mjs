import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { POST as desktop } from '../../app/api/agents/desktop/route.ts';
import { POST as demo } from '../../app/api/organizations/demo/route.ts';
import { POST as reports } from '../../app/api/operations/reports/route.ts';
import { desktopQuery as query,callTaskModel,DesktopInferencePending } from '../../lib/agents/desktop-inference.ts';
import { createTask,getTask } from '../../lib/agents/tasks.ts';
import { advanceTask } from '../../lib/agents/runtime.ts';
import {startDemoWorkflow} from '../../lib/operations/demo-workflows.ts';
import {applyImport} from '../../lib/operations/import-apply.ts';
import {demoPortfolio} from '../../lib/operations/demo-portfolio.ts';
import {decideApproval,latestApprovalForTask} from '../../lib/agents/approvals.ts';

export async function runDesktopInferenceCases(t,{session,userA,userB,administrator,config}) {
  const previous={...env};env.DATABASE_URL=config.connectionString;delete env.HYPERDRIVE;
  const runnerId=randomUUID();let org,task,job;
  const request=(user,o,body)=>new Request('https://app.aval.llc/api/test',{method:'POST',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json',cookie:`aval-active-organization=${o}`}),{userId:user,email:`${user}@example.test`,displayName:user,emailVerified:true}),body:JSON.stringify(body)});
  const call=async(route,user,o,body)=>{const r=await route(request(user,o,body),undefined);return {status:r.status,...await r.json()};};
  const run=work=>session(userA,s=>work(s,s.identity.organizationId));
  const params={system:'Read only.',messages:[{role:'user',content:'Read portfolio'}],tools:[{name:'get_portfolio_metrics',description:'Read',input_schema:{type:'object'}}],max_tokens:100};
  const response={content:[{type:'tool_use',id:'fixture-response',name:'get_portfolio_metrics',input:{}}],usage:{input_tokens:20,output_tokens:10}};
  try {
    org=await run((s,o)=>o);
    await t.test('desktop: register is workspace-bound and pins Luna',async()=>{
      assert.equal((await call(desktop,userA,org,{action:'register',organizationId:'wrong',runnerId,model:'gpt-6-luna'})).status,409);
      assert.equal((await call(desktop,userA,org,{action:'register',organizationId:org,runnerId,model:'gpt-6-luna'})).status,200);
    });
    await t.test('desktop: actor parks durably without spending hosted API tokens',async()=>{
      task=await run((s,o)=>createTask(s,{organizationId:o,userId:userA,agentId:'general',goal:'Read portfolio',check:{kind:'evidence',tools:['get_portfolio_metrics']}}));
      const outcome=await run((s,o)=>advanceTask(s,{},o,task.id,randomUUID(),{invocationBudgetMs:45000}));
      assert.equal(outcome.status,'WAITING_FOR_MODEL',JSON.stringify(outcome));
      const rows=await run(s=>query(s,'SELECT * FROM desktop_model_jobs WHERE task_id=$1',[task.id]));
      assert.equal(rows.rows.length,1);
    });
    await t.test('desktop: claims are exclusive and another workspace cannot complete one',async()=>{
      const results=await Promise.all([1,2].map(()=>call(desktop,userA,org,{action:'claim',organizationId:org,runnerId})));
      assert.equal(results.filter(r=>r.job).length,1);job=results.find(r=>r.job).job;assert.equal(job.model,'gpt-6-luna');
      const other=await session(userB,s=>s.identity.organizationId);
      assert.equal((await call(desktop,userB,other,{action:'complete',organizationId:org,runnerId,jobId:job.id,claimToken:job.claimToken,response})).status,409);
      assert.equal((await call(desktop,userA,org,{action:'complete',organizationId:org,runnerId,jobId:job.id,claimToken:'wrong',response})).status,409);
    });
    await t.test('desktop: expired claims retry with a new fence and retain unknown-usage reservation',async()=>{
      await administrator.query("UPDATE desktop_model_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
      const old=job;job=(await call(desktop,userA,org,{action:'claim',organizationId:org,runnerId})).job;
      assert.notEqual(job.claimToken,old.claimToken);
      assert.equal((await call(desktop,userA,org,{action:'complete',organizationId:org,runnerId,jobId:old.id,claimToken:old.claimToken,response})).status,409);
    });
    await t.test('desktop: cancellation, completion replay and measured usage remain exactly once',async()=>{
      await administrator.query('UPDATE agent_tasks SET cancel_requested=true WHERE id=$1',[task.id]);
      const complete=()=>call(desktop,userA,org,{action:'complete',organizationId:org,runnerId,jobId:job.id,claimToken:job.claimToken,response});
      const saved=await complete();assert.equal(saved.status,200);assert.equal(saved.accepted,false);
      await complete();const row=(await administrator.query('SELECT tokens_used,tokens_reserved FROM desktop_model_runners WHERE organization_id=$1',[org])).rows[0];
      assert.equal(Number(row.tokens_used),30);assert.ok(Number(row.tokens_reserved)>0);
    });
    await t.test('desktop: identical semantic requests share a durable response',async()=>{
      const review=await run((s,o)=>createTask(s,{organizationId:o,userId:userA,agentId:'general',goal:'Review',check:{kind:'evidence',tools:['get_portfolio_metrics']}}));
      await run(async(s,o)=>{await assert.rejects(callTaskModel(s,{},o,params,review.id,0,'review:answer'),DesktopInferencePending);await assert.rejects(callTaskModel(s,{},o,{...params,timeout_ms:1},review.id,0,'review:answer'),DesktopInferencePending);});
      const rows=await administrator.query('SELECT * FROM desktop_model_jobs WHERE task_id=$1',[review.id]);assert.equal(rows.rowCount,1);
      await administrator.query("UPDATE desktop_model_jobs SET status='completed',response_json=$2 WHERE id=$1",[rows.rows[0].id,JSON.stringify(response)]);
      assert.deepEqual(await run((s,o)=>callTaskModel(s,{},o,params,review.id,0,'review:answer')),response);
    });
    await t.test('demo: creation and seeding are idempotent and isolated',async()=>{
      const created=await call(demo,userA,org,{action:'create'});assert.equal(created.status,200);const demoOrg=created.organizationId;
      assert.equal((await call(demo,userA,org,{action:'create'})).organizationId,demoOrg);
      for(let i=0;i<2;i++)assert.equal((await call(demo,userA,demoOrg,{action:'seed'})).status,200);
      assert.equal(Number((await administrator.query('SELECT count(*) FROM units WHERE organization_id=$1',[demoOrg])).rows[0].count),24);
      assert.notEqual((await call(demo,userB,org,{action:'create'})).organizationId,demoOrg);
    });
    await t.test('reports: preview, apply, repeat and provenance rejection use real routes',async()=>{
      const body={provider:'appfolio',dataset:'properties',currency:'USD',csv:'ID,Name\nreport-1,Fictional report property',mapping:{externalId:'ID',name:'Name'}};
      assert.equal((await call(reports,userA,org,{...body,action:'apply'})).status,409);
      const preview=await call(reports,userA,org,{...body,action:'preview'});assert.equal(preview.status,200);
      for(let i=0;i<2;i++)assert.equal((await call(reports,userA,org,{...body,action:'apply',digest:preview.digest})).status,201);
      assert.equal((await call(reports,userA,org,{...body,sourceProvider:'quickbooks',action:'preview'})).status,400);
      const rows=await administrator.query("SELECT source_provider FROM properties WHERE organization_id=$1 AND external_id='appfolio:report:report-1'",[org]);assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].source_provider,'manual');
    });
    await t.test('desktop: actor and reviewer resume without duplicate tools; maintenance requires approval',async()=>{
      const user=`demo_engine_${randomUUID()}`;
      const work=fn=>session(user,s=>fn(s,s.identity.organizationId));
      const target=await work((s,o)=>o);
      await work(async(s,o)=>{await query(s,"UPDATE organizations SET active_model_provider='desktop_codex' WHERE id=$1",[o]);await applyImport(s,o,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null});});
      const current=await work((s,o)=>startDemoWorkflow(s,o,user,0));
      assert.equal((await work((s,o)=>startDemoWorkflow(s,o,user,0))).id,current.id,'double click reuses active work');
      const scope=JSON.parse(current.executionScopeJson);
      const proposal=(name,input)=>({id:randomUUID(),content:[{type:'tool_use',id:randomUUID(),name,input}],usage:{input_tokens:20,output_tokens:10},stop_reason:'tool_use',routing:{providerId:'desktop_codex',model:'fixture-not-live'}});
      let approved=false, reviewCalls=0;
      for(let i=0;i<16;i++) {
        const fresh=await work((s,o)=>getTask(s,o,current.id));
        if(fresh.status==='COMPLETED')break;
        assert.notEqual(fresh.status,'FAILED',fresh.error);
        if(fresh.status==='WAITING_FOR_APPROVAL') {
          assert.equal(Number((await administrator.query("SELECT count(*) FROM work_orders WHERE organization_id=$1 AND source_provider='manual'",[target])).rows[0].count),0,'no internal action before approval');
          const approval=await work((s,o)=>latestApprovalForTask(s,o,current.id));
          const decision=await work((s,o)=>decideApproval(s,o,approval.id,'approved',user,user,'owner'));assert.equal(decision.ok,true);approved=true;
        }
        await work((s,o)=>advanceTask(s,{},o,current.id,randomUUID(),{invocationBudgetMs:45000,maxStepsThisInvocation:2}));
        const queued=await administrator.query("SELECT * FROM desktop_model_jobs WHERE task_id=$1 AND status='pending' ORDER BY created_at LIMIT 1",[current.id]);
        if(!queued.rows[0])continue;
        const job=queued.rows[0],params=job.request_json;
        assert.ok(!params.tools.some(t=>t.name==='send_external_message'),'demo cannot send tenant messages');
        let response;
        if(params.tool_choice?.name==='semantic_verdict') {
          reviewCalls++;const packet=JSON.parse(params.messages[0].content);const source=packet.sources.find(s=>s.tool==='create_maintenance_work_order');
          response=proposal('semantic_verdict',{passed:true,requirements:[{requirement:packet.goal,satisfied:true,explanation:'Deterministic transport fixture',nodeKeys:[]}],claims:[{claim:'Internal work order created',kind:'fact',supported:true,citations:[{sourceId:source.id,pointer:'/workOrderId'}]}],issues:[]});
        } else {
          const uses=params.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_use'):[]);
          response=!uses.some(u=>u.name==='read_maintenance_context')?proposal('read_maintenance_context',{conversation_id:scope.conversationId,message_id:scope.messageId}):!approved?proposal('create_maintenance_work_order',{conversation_id:scope.conversationId,message_id:scope.messageId,resident_id:scope.maintenance.residentId,property_id:scope.maintenance.propertyId,unit_id:scope.maintenance.unitId,summary:'Inspect the reported slow bathroom drain; cause unknown.',priority:'routine'}):proposal('render_answer',{headline:'Internal work order created',narrative:'The approved internal inspection request is recorded. No resident message was sent.',confidence:'high'});
        }
        await administrator.query("UPDATE desktop_model_jobs SET status='completed',response_json=$2 WHERE id=$1",[job.id,JSON.stringify(response)]);
        await administrator.query("UPDATE agent_tasks SET status='QUEUED' WHERE id=$1 AND status='WAITING_FOR_MODEL'",[current.id]);
      }
      assert.equal((await work((s,o)=>getTask(s,o,current.id))).status,'COMPLETED');assert.equal(reviewCalls,1);
      assert.equal(Number((await administrator.query("SELECT count(*) FROM work_orders WHERE organization_id=$1 AND source_provider='manual'",[target])).rows[0].count),1);
      const modelCalls=await administrator.query("SELECT count(*) FROM agent_task_steps WHERE task_id=$1 AND kind='model_call'",[current.id]);assert.equal(Number(modelCalls.rows[0].count),3,'two actor calls and one independent review');
      const reads=await administrator.query("SELECT count(*) FROM agent_task_steps WHERE task_id=$1 AND kind='context_read_proposed'",[current.id]);assert.equal(Number(reads.rows[0].count),1,'mandatory context is read once without inference');
    });
  } finally {for(const key of Object.keys(env))delete env[key];Object.assign(env,previous);await administrator.query('UPDATE organizations SET active_model_provider=NULL WHERE id=$1',[org]);}
}

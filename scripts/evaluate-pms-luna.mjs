/** Live subscription inference through the production queue and PostgreSQL engine.
 * Synthetic portfolio only: this is not AppFolio/Yardi API certification.
 * Run with --import ./tests/integration/module-hooks.mjs and a private output path.
 */
import {writeFileSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {postgresEvaluation} from './lib/postgres-evaluation.mjs';
import {startCodexInference} from './lib/codex-inference.mjs';
import {applyImport} from '../lib/operations/import-apply.ts';
import {demoPortfolio} from '../lib/operations/demo-portfolio.ts';
import {getTask,listSteps} from '../lib/agents/tasks.ts';
import {advanceTask} from '../lib/agents/runtime.ts';
import {POST as desktop} from '../app/api/agents/desktop/route.ts';
import {desktopQuery as query} from '../lib/agents/desktop-inference.ts';
import {startDemoWorkflow} from '../lib/operations/demo-workflows.ts';

const output=process.argv[2];
if(!output||existsSync(output))throw Error('Supply a new private report path; failed attempts are never overwritten');
if(process.env.AVAL_CODEX_MODEL!=='gpt-6-luna')throw Error('This evaluation requires gpt-6-luna, without fallback');
const report={startedAt:new Date().toISOString(),scope:'PostgreSQL engine and production Desktop queue; synthetic USD portfolio, no live vendor access',model:'gpt-6-luna',tokenCap:500000,status:'running',calls:[],runs:[]};
const priorTokens=readdirSync(dirname(output)).filter(name=>/^pms-luna-evaluation-.*\.json$/.test(name)).reduce((total,name)=>{
  const previous=JSON.parse(readFileSync(join(dirname(output),name),'utf8'));
  return total+(previous.calls??[]).reduce((n,call)=>n+(call.usage?call.usage.input_tokens+call.usage.output_tokens:100000),0);
},0);
report.priorTokens=priorTokens;
if(priorTokens>=report.tokenCap)throw Error('The initial 500,000-token evaluation budget is exhausted');
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});save();
let db,client;
try {
  db=await postgresEvaluation();client=await startCodexInference();const runnerId=randomUUID();
  report.organizationId=db.org;
  const call=async body=>{const r=await desktop(db.request('/api/agents/desktop',{organizationId:db.org,runnerId,...body}),undefined);const data=await r.json();if(!r.ok)throw Error(data.error||`Desktop HTTP ${r.status}`);return data;};
  await call({action:'register',model:client.model});
  await db.admin.query('UPDATE desktop_model_runners SET token_limit=$2 WHERE organization_id=$1',[db.org,report.tokenCap-priorTokens]);
  await db.run(s=>applyImport(s,db.org,demoPortfolio(new Date()),{sourceProvider:'aval_demo',sourceConnectionId:null,externalId:null}));
  // Start with the bounded read workflows. Maintenance approval is separately gated.
  const workflows=[{name:'receivables',index:2,tool:'get_delinquent_accounts'}, {name:'leases',index:1,tool:'get_expiring_leases'}].filter(w=>!process.env.AVAL_EVAL_WORKFLOW||w.name===process.env.AVAL_EVAL_WORKFLOW);
  const repetitions=Number(process.env.AVAL_EVAL_REPETITIONS||3);
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw Error('Use 1–3 repetitions');
  for(const workflow of workflows)for(let repetition=1;repetition<=repetitions;repetition++) {
    const task=await db.run(s=>startDemoWorkflow(s,db.org,db.user,workflow.index));
    const record={workflow:workflow.name,repetition,taskId:task.id,startedAt:new Date().toISOString(),status:'running'};report.runs.push(record);save();
    for(let round=0;round<40;round++) {
      const fresh=await db.run(s=>getTask(s,db.org,task.id));
      if(['COMPLETED','FAILED','CANCELLED','WAITING_FOR_HUMAN','WAITING_FOR_APPROVAL'].includes(fresh.status)){record.status=fresh.status;record.error=fresh.error;record.result=JSON.parse(fresh.resultJson||'null');break;}
      if(['QUEUED','RUNNING','WAITING_FOR_TOOL'].includes(fresh.status))await db.run(s=>advanceTask(s,{},db.org,task.id,randomUUID(),{invocationBudgetMs:45000,maxStepsThisInvocation:2}));
      const {job}=await call({action:'claim'});
      if(!job)continue;
      const start=Date.now();
      try {
        const response=await client.callDesktop(job.params);
        report.calls.push({jobId:job.id,taskId:job.taskId,phase:job.params.tool_choice?.name==='semantic_verdict'?'review':'actor',durationMs:Date.now()-start,model:client.model,usage:response.usage,tools:response.content.map(c=>c.name)});save();
        await call({action:'complete',jobId:job.id,claimToken:job.claimToken,response});
      }catch(error){report.calls.push({jobId:job.id,error:error.message,durationMs:Date.now()-start});save();throw error;}
    }
    record.trace=await db.run(s=>listSteps(s,task.id,db.org));record.finishedAt=new Date().toISOString();
    if(record.status==='running')record.status='incomplete';
    // Exact expected records are checked independently of the model reviewer.
    const resultText=JSON.stringify(record.result);
    record.assertions={completed:record.status==='COMPLETED',evidenceRead:record.trace.some(t=>t.toolName===workflow.tool&&t.kind==='tool_call'),expectedAmounts:workflow.name!=='receivables'||(['1,750','1750','175000'].some(v=>resultText.includes(v))&&['1,000','1000','100000'].some(v=>resultText.includes(v))&&resultText.includes('500')&&resultText.includes('250')),noOutboundActions:!record.trace.some(t=>['send_external_message','create_work_order','place_call'].includes(t.toolName))};save();
    if(!Object.values(record.assertions).every(Boolean))break;
  }
  report.usage=(await db.run(s=>query(s,'SELECT tokens_used,tokens_reserved FROM desktop_model_runners WHERE organization_id=$1',[db.org]))).rows[0];
  report.status='incomplete'; // Full release gate also needs maintenance, failure scenarios and visible account validation.
}catch(error){report.status='incomplete';report.error=error.message;}
finally{await client?.close();await db?.close();for(const run of report.runs)if(run.status==='running')run.status='incomplete';report.finishedAt=new Date().toISOString();save();}
console.log(JSON.stringify({status:report.status,model:report.model,runs:report.runs.map(r=>({workflow:r.workflow,status:r.status,assertions:r.assertions})),calls:report.calls.length,error:report.error}));

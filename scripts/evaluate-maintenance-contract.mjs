import { writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { postgresEvaluation } from './lib/postgres-evaluation.mjs';
import { agentBuildVersion } from './lib/agent-build-version.mjs';
import { runDesktopInferenceCases } from '../tests/postgres/desktop-inference-cases.mjs';
import { braintrustBase } from '../lib/observability/braintrust.ts';

const output = process.argv[2];
if (!output || output.startsWith('--')) throw Error('Provide a new private output filename');
const report = { id:randomUUID(),suite:'maintenance-contract-integration-v1',contract_version:'maintenance-contract-v1',
  agent_version:agentBuildVersion(),model:'scripted-fixture-not-live',validation:'integration_fixture',
  status:'running',model_calls:0,input_tokens:0,output_tokens:0,cases:[] };
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
let context;
try {
  context=await postgresEvaluation();
  const t={test:async(name,fn)=>{
    const start=Date.now();
    const item={id:createHash('sha256').update(name).digest('hex'),name,status:'running',duration_ms:0};
    report.cases.push(item);
    try {await fn();item.status='passed';} catch {item.status='failed';}
    item.duration_ms=Date.now()-start;
  }};
  await runDesktopInferenceCases(t,{session:context.session,userA:context.user,userB:`test_${randomUUID()}`,administrator:context.admin,config:context.config});
  report.status=report.cases.length>0&&report.cases.every(c=>c.status==='passed')?'passed':'failed';
} catch {report.status='incomplete';}
finally {await context?.close();await writeFile(output,JSON.stringify(report,null,2));}

if(process.argv.includes('--publish')) {
  const key=process.env.BRAINTRUST_API_KEY, project=process.env.BRAINTRUST_PROJECT_ID;
  if(!key||!project)throw Error('Braintrust secret and project configuration required; local report retained');
  const base=braintrustBase(process.env.BRAINTRUST_REGION??'');
  const post=async(path,body)=>{
    const response=await fetch(`${base}/v1/${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();throw Error(`Braintrust upload failed (${response.status}); local report retained`);}
    return response.json();
  };
  const version=createHash('sha256').update(JSON.stringify(report.cases.map(c=>({id:c.id,name:c.name})))).digest('hex').slice(0,16);
  const dataset=await post('dataset',{project_id:project,name:`maintenance-contract-integration-${version}`,description:'Synthetic runtime regression scenarios. Fixture assertions, not live-model certification.'});
  await post(`dataset/${dataset.id}/insert`,{events:report.cases.map(c=>({id:c.id,input:{scenario:c.name},expected:{assertions_passed:true},metadata:{validation:'integration_fixture',suite:report.suite}}))});
  const experiment=await post('experiment',{project_id:project,dataset_id:dataset.id,name:`maintenance-${report.id}`,metadata:{agent_version:report.agent_version,contract_version:report.contract_version,validation:report.validation,model:report.model,status:report.status}});
  await post(`experiment/${experiment.id}/insert`,{events:report.cases.map(c=>({id:randomUUID(),dataset_record_id:c.id,input:{scenario:c.name},output:{status:c.status},expected:{assertions_passed:true},scores:{runtime_assertions:c.status==='passed'?1:0},metrics:{duration:c.duration_ms/1000},metadata:{validation:report.validation,model:report.model}}))});
  report.braintrust={project_id:project,dataset_id:dataset.id,experiment_id:experiment.id};
  await writeFile(output,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({status:report.status,cases:report.cases.length,passed:report.cases.filter(c=>c.status==='passed').length,model_calls:0,output}));
if(report.status!=='passed')process.exitCode=1;

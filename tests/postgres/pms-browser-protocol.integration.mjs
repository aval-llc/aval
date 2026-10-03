import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {postgresEvaluation} from '../../scripts/lib/postgres-evaluation.mjs';
import {createTask,reserveMutation} from '../../lib/agents/tasks.ts';
import {executionVerdict} from '../../lib/agents/evidence.ts';
import {requestApproval,decideApproval} from '../../lib/agents/approvals.ts';
import {getTool} from '../../lib/agents/registry.ts';
import {setAgentsPaused} from '../../lib/agents/pause.ts';
import {flowDigest} from '../../lib/pms/browser/steps.ts';
import {registerBrowserDevice,bindBrowserConnection,prepareBrowserManifest,enqueueBrowserWrite,
  claimBrowserWrite,consumeBrowserGrant,recordBrowserResult,expireBrowserReviews,browserEvidenceForProposal} from '../../lib/pms/browser/protocol.ts';
import {POST as legacy} from '../../app/api/pms/runner/route.ts';
import {POST as browserRoute} from '../../app/api/pms/browser-v2/route.ts';
import brokerModule from '../../desktop/pms-broker.cjs';
import {executePmsWrite} from '../../lib/pms/execute.ts';
import {claimForRunner} from '../../lib/pms/browser/drain.ts';

const identity={origin:'https://fixture.example.invalid',accountId:'account-1',staffId:'restricted-1'};
const permissions={createWorkOrder:true,accounting:false};
const facts={requestId:'291999',propertyId:'114672',unitId:'609746',status:'open',symptoms:'Slow kitchen drain',accessRestrictions:'Ask before entry',linkedWorkOrderIds:[]};
const steps=[{kind:'open',page:'New work order'},{kind:'fill',label:'Summary',from:'summary'},{kind:'commit',button:'Create work order'},{kind:'capture',label:'Work order',as:'externalId'}];
async function fixture(work) {
  const db=await postgresEvaluation();
  try {
    const device=randomUUID(),secret=randomBytes(32).toString('hex'),connection=randomUUID(),flow=randomUUID();
    await db.run(s=>registerBrowserDevice(s,db.org,db.user,device,secret));
    await db.admin.query(`INSERT INTO integration_connections(id,organization_id,provider,category,status,auth_mode,metadata_json,created_by,created_at,updated_at)
      VALUES($1,$2,'buildium','property','connected','customer_desktop_session',$3,$4,now(),now())`,[connection,db.org,JSON.stringify({pmsGrants:{available:['maintenance.work_order.create']}}),db.user]);
    await db.run(s=>bindBrowserConnection(s,db.org,device,{connectionId:connection,identity,feasibility:{restrictedStaff:true,permittedAccess:true,
      searchableReference:true,nonWritingPreparation:true,observableIdentity:true,propertyScoped:true,allowedPropertyId:facts.propertyId,
      controlledVendor:true,controlledVendorId:'vendor-demo',controlledVendorName:'Aval Demo Vendor — DO NOT CONTACT'}}));
    await db.admin.query(`INSERT INTO pms_action_flows(id,organization_id,provider,action,version,steps_json,digest,status,learned_by_user_id,promoted_by_user_id,created_at,updated_at,connection_id)
      VALUES($1,$2,'buildium','maintenance.work_order.create',1,$3,$4,'active',$5,$5,now(),now(),$6)`,[flow,db.org,JSON.stringify(steps),await flowDigest(steps),db.user,connection]);
    await db.admin.query(`INSERT INTO pms_write_authorizations(id,organization_id,provider,action,status,signed_authorization,approved_by_user_id,created_by,created_at,updated_at)
      VALUES($1,$2,'buildium','maintenance.work_order.create','approved',true,$3,$3,now(),now())`,[randomUUID(),db.org,db.user]);
    const make=async(logicalActionId=randomUUID())=>{
      const task=await db.run(s=>createTask(s,{organizationId:db.org,userId:db.user,agentId:'maintenance',goal:'Synthetic PMS test',check:{kind:'evidence',tools:['get_maintenance_performance']}}));
      const manifest=await db.run(s=>prepareBrowserManifest(s,db.org,{connectionId:connection,flowId:flow,facts,payload:{summary:'Slow drain',description:'Slow kitchen drain',priority:'medium'},logicalActionId}));
      const approval=await db.run(s=>requestApproval(s,{organizationId:db.org,taskId:task.id,stepIndex:0,tool:getTool('create_work_order'),evidence:{pmsBrowser:manifest}}));
      const decision=await db.run(s=>decideApproval(s,db.org,approval.id,'approved',db.user,db.user,'owner'));
      assert.equal(decision.ok,true);
      const queueId=await db.run(s=>enqueueBrowserWrite(s,db.org,approval.id,manifest));
      return {task,manifest,approval,queueId};
    };
    const job=await make();
    const claim=()=>db.run(s=>claimBrowserWrite(s,db.org,device));
    const grant=c=>db.run(s=>consumeBrowserGrant(s,db.org,device,{queueId:c.queueId,generation:c.generation,identity,facts,form:c.manifest.payload,permissions}));
    await work({...db,device,secret,connection,flow,job,make,claim,grant});
  } finally {await db.close();}
}

test('PMS protocol: confirmation requires a grant and exact read-back; replay cannot submit again',async()=>fixture(async db=>{
  const c=await db.claim(); assert.equal(c.mode,'prepare');
  const grant=await db.grant(c); assert.ok(grant.grantId);
  await assert.rejects(db.grant(c),/consumed/);
  const result=await db.run(s=>recordBrowserResult(s,db.org,db.device,{queueId:c.queueId,generation:c.generation,kind:'confirmed',identity,externalId:'WO-1',reference:c.manifest.reference,form:c.manifest.payload,facts:{...facts,linkedWorkOrderIds:['WO-1']}}));
  assert.equal(result.status,'confirmed');assert.equal(await db.claim(),null);
  await assert.rejects(db.admin.query("UPDATE pms_write_queue SET status='pending' WHERE id=$1",[c.queueId]),/may only be reconciled/);
}));
test('Buildium approval evidence is property-bound and receives only the server-controlled vendor',async()=>fixture(async db=>{
  const evidence=await db.run(s=>browserEvidenceForProposal(s,db.org,{
    provider:'buildium',request_id:facts.requestId,property_id:facts.propertyId,unit_id:facts.unitId,
    request_status:facts.status,description:facts.symptoms,access_restrictions:facts.accessRestrictions,
    linked_work_order_ids:[],summary:'Slow drain',priority:'medium',vendor_id:'model-selected-vendor',
    vendor_name:'Model-selected vendor',
  },randomUUID()));
  assert.equal(evidence.pmsBrowser.payload.vendorId,'vendor-demo');
  assert.equal(evidence.pmsBrowser.payload.vendorName,'Aval Demo Vendor — DO NOT CONTACT');
  assert.equal(evidence.pmsBrowser.payload.propertyId,facts.propertyId);
  await assert.rejects(db.run(s=>prepareBrowserManifest(s,db.org,{connectionId:db.connection,flowId:db.flow,
    facts:{...facts,propertyId:'999999'},payload:{summary:'Wrong property',description:facts.symptoms,priority:'medium'},logicalActionId:randomUUID()})),
  /outside the connection-bound demo property/);
}));
test('PMS protocol: pause after claim prevents commit',async()=>fixture(async db=>{
  const c=await db.claim();await db.run(s=>setAgentsPaused(s,db.org,true));
  await assert.rejects(db.grant(c),/paused/);assert.equal(await db.claim(),null);
}));
for(const change of ['approval','facts','form','identity','flow','permission','cancel']) {
  test(`PMS protocol: changed ${change} prevents commit`,async()=>fixture(async db=>{
    const c=await db.claim();const input={queueId:c.queueId,generation:c.generation,identity,facts,form:c.manifest.payload,permissions};
    if(change==='approval') await db.admin.query("UPDATE agent_approvals SET status='rejected' WHERE id=$1",[db.job.approval.id]);
    if(change==='facts') input.facts={...facts,status:'cancelled'};
    if(change==='form') input.form={...c.manifest.payload,unitId:'wrong-unit'};
    if(change==='identity') input.identity={...identity,staffId:'owner-admin'};
    if(change==='flow') await db.admin.query("UPDATE pms_action_flows SET digest='changed' WHERE id=$1",[db.flow]);
    if(change==='permission') await db.admin.query("UPDATE pms_write_authorizations SET status='suspended' WHERE organization_id=$1",[db.org]);
    if(change==='cancel') await db.admin.query('UPDATE agent_tasks SET cancel_requested=true WHERE id=$1',[db.job.task.id]);
    const expected={approval:/current approval/,facts:/request changed/,form:/form differs/,identity:/Wrong PMS account/,
      flow:/flow changed/,permission:/permission was withdrawn/,cancel:/current approval/};
    await assert.rejects(db.run(s=>consumeBrowserGrant(s,db.org,db.device,input)),expected[change]);
    assert.equal((await db.admin.query('SELECT submitted_at FROM pms_write_queue WHERE id=$1',[c.queueId])).rows[0].submitted_at,null);
  }));
}
test('PMS protocol: lost response and expired lease can only reconcile; late report retained',async()=>fixture(async db=>{
  const first=await db.claim();await db.grant(first);
  await db.admin.query("UPDATE pms_write_queue SET lease_expires_at=now()-interval '1 second',verify_after=now() WHERE id=$1",[first.queueId]);
  const second=await db.claim();assert.equal(second.mode,'verify');assert.ok(second.generation>first.generation);
  const late=await db.run(s=>recordBrowserResult(s,db.org,db.device,{queueId:first.queueId,generation:first.generation,identity,kind:'confirmed',externalId:'WO-late',reference:first.manifest.reference,form:first.manifest.payload}));
  assert.equal(late.status,'evidence_retained');
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM pms_browser_reports WHERE queue_id=$1',[first.queueId])).rows[0].count),1);
  await assert.rejects(db.grant(second),/consumed/);
}));
test('PMS protocol: connection lock, cross-workspace isolation and distinct action references',async()=>fixture(async db=>{
  const extra=await db.make();assert.notEqual(extra.manifest.reference,db.job.manifest.reference);
  const claimed=await Promise.all([db.claim(),db.claim()]);assert.equal(claimed.filter(Boolean).length,1);
  const otherUser=`other_${randomUUID()}`;
  await assert.rejects(db.session(otherUser,s=>consumeBrowserGrant(s,s.identity.organizationId,db.device,{queueId:db.job.queueId,generation:1,identity,facts,form:db.job.manifest.payload,permissions})),/expired or was already consumed/);
}));
test('PMS protocol: overdue verification has a human owner and never becomes confirmed',async()=>fixture(async db=>{
  const c=await db.claim();await db.grant(c);
  await db.admin.query("UPDATE pms_write_queue SET review_due_at=now()-interval '1 second',responsible_user_id='departed' WHERE id=$1",[c.queueId]);
  await db.run(s=>expireBrowserReviews(s,db.org));
  const row=(await db.admin.query('SELECT status,responsible_user_id FROM pms_write_queue WHERE id=$1',[c.queueId])).rows[0];
  assert.equal(row.status,'needs_review');assert.equal(row.responsible_user_id,db.user);assert.equal(await db.claim(),null);
}));
test('legacy runner cannot execute writes',async()=>assert.equal((await legacy()).status,426));

async function deployment(db) {
  await db.admin.query(`INSERT INTO agent_deployments(id,organization_id,persona_id,provider,workflows_json,status,created_by,created_at,updated_at)
    VALUES($1,$2,'maintenance','buildium','["maintenance"]','active',$3,now(),now())`,[randomUUID(),db.org,db.user]);
}
test('PMS protocol: deployment pause before the grant blocks submission',async()=>fixture(async db=>{
  await deployment(db);const c=await db.claim();
  await db.admin.query("UPDATE agent_deployments SET status='paused' WHERE organization_id=$1",[db.org]);
  await assert.rejects(db.grant(c),/current approval/);
}));
test('PMS protocol: concurrent deployment revocation is ordered after a consumed grant',async()=>fixture(async db=>{
  await deployment(db);const c=await db.claim();
  const granted=Promise.withResolvers(),release=Promise.withResolvers();
  const transaction=db.run(async s=>{
    try {
      await consumeBrowserGrant(s,db.org,db.device,{queueId:c.queueId,generation:c.generation,identity,facts,form:c.manifest.payload,permissions});
      granted.resolve();await release.promise;
    } catch(error) {granted.reject(error);throw error;}
  });
  try {
    await granted.promise;
    await db.admin.query('BEGIN');
    await db.admin.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(db.admin.query("UPDATE agent_deployments SET status='paused' WHERE organization_id=$1",[db.org]),/lock timeout/);
  } finally {
    await db.admin.query('ROLLBACK');release.resolve();await transaction;
  }
}));

function routeRequest(db,body,overrides={}) {
  const base=db.request('/api/pms/browser-v2',body);
  const headers=new Headers(base.headers);
  for(const [key,value] of Object.entries({origin:'https://app.aval.llc','x-aval-pms-device':db.device,
    'x-aval-pms-secret':db.secret,'x-aval-pms-workspace':db.org,'x-aval-pms-user':db.user,...overrides})) headers.set(key,value);
  return new Request(base,{headers});
}
test('PMS v2 API and main-process broker execute against real PostgreSQL approval state',async()=>fixture(async db=>{
  let created=0,record=null;
  const driver={protocol:2,identity:async()=>identity,permissions:async()=>permissions,findByReference:async()=>record,
    prepare:async steps=>assert.ok(steps.every(step=>step.kind!=='commit')),
    readRequest:async()=>({...facts,linkedWorkOrderIds:created?['WO-API']:[]}),readForm:async()=>db.job.manifest.payload,
    commit:async()=>{created++;record={externalId:'WO-API',reference:db.job.manifest.reference,form:db.job.manifest.payload};}};
  const broker=new brokerModule.PmsBroker({driverFor:()=>driver,transport:async body=>{
    const response=await browserRoute(routeRequest(db,body));const value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));return value;
  }});
  assert.equal((await broker.tick()).status,'confirmed');assert.equal(created,1);
  assert.equal((await broker.tick()).status,'idle');assert.equal(created,1);
  assert.equal((await db.admin.query('SELECT external_id FROM pms_write_queue WHERE id=$1',[db.job.queueId])).rows[0].external_id,'WO-API');
}));
test('PMS v2 API refuses foreign origin, device secret and workspace switches',async()=>fixture(async db=>{
  for(const [override,status] of [[{origin:'https://attacker.invalid'},403],[{'x-aval-pms-secret':'0'.repeat(64)},409],
    [{'x-aval-pms-workspace':'another-workspace'},409],[{'x-aval-pms-user':'another-user'},409]]) {
    const response=await browserRoute(routeRequest(db,{protocol:2,intent:'claim'},override));assert.equal(response.status,status);
  }
  assert.equal((await db.admin.query('SELECT attempts FROM pms_write_queue WHERE id=$1',[db.job.queueId])).rows[0].attempts,0);
}));
for(const change of ['expired','missingDecision','changedEvidence']) {
  test(`PMS protocol: ${change} approval is not execution authority`,async()=>fixture(async db=>{
    const c=await db.claim();
    if(change==='expired')await db.admin.query("UPDATE agent_approvals SET expires_at=now()-interval '1 second' WHERE id=$1",[db.job.approval.id]);
    if(change==='missingDecision')await db.admin.query('DELETE FROM agent_approval_decisions WHERE approval_id=$1',[db.job.approval.id]);
    if(change==='changedEvidence')await db.admin.query("UPDATE agent_approvals SET evidence_json=jsonb_set(evidence_json,'{pmsBrowser,payload,unitId}','\"wrong\"'::jsonb) WHERE id=$1",[db.job.approval.id]);
    await assert.rejects(db.grant(c),change==='changedEvidence'?/changed after approval/:/current approval/);
  }));
}
test('PMS protocol: partial read-back and a staff edit after grant cannot confirm',async()=>fixture(async db=>{
  const c=await db.claim();await db.grant(c);
  const report={queueId:c.queueId,generation:c.generation,kind:'confirmed',identity,externalId:'WO-race',reference:c.manifest.reference,
    form:c.manifest.payload,facts:{...facts,status:'cancelled',linkedWorkOrderIds:['WO-race']}};
  assert.equal((await db.run(s=>recordBrowserResult(s,db.org,db.device,report))).status,'submission_unknown');
  const row=(await db.admin.query('SELECT external_id,status FROM pms_write_queue WHERE id=$1',[c.queueId])).rows[0];
  assert.equal(row.external_id,null);assert.notEqual(row.status,'confirmed');
}));
test('PMS protocol: late external ID remains a hint; a new lease must verify it',async()=>fixture(async db=>{
  const first=await db.claim();await db.grant(first);
  await db.admin.query("UPDATE pms_write_queue SET lease_expires_at=now()-interval '1 second',verify_after=now() WHERE id=$1",[first.queueId]);
  await db.run(s=>recordBrowserResult(s,db.org,db.device,{queueId:first.queueId,generation:first.generation,kind:'confirmed',identity,
    externalId:'WO-late',reference:first.manifest.reference,form:first.manifest.payload}));
  const second=await db.claim();assert.equal(second.mode,'verify');assert.equal(second.externalId,'WO-late');
  assert.equal((await db.admin.query('SELECT status FROM pms_write_queue WHERE id=$1',[first.queueId])).rows[0].status,'verifying');
}));
test('PMS protocol: bounded read-only retries then an owned handoff',async()=>fixture(async db=>{
  let c=await db.claim();await db.grant(c);
  for(let attempt=0;attempt<4;attempt++) {
    const result=await db.run(s=>recordBrowserResult(s,db.org,db.device,{queueId:c.queueId,generation:c.generation,identity,kind:'unknown'}));
    assert.equal(result.status,attempt===3?'needs_review':'submission_unknown');
    if(attempt<3) {
      const delay=(await db.admin.query('SELECT extract(epoch from verify_after-submitted_at) AS seconds FROM pms_write_queue WHERE id=$1',[c.queueId])).rows[0].seconds;
      assert.equal(Number(delay),[60,300,900][attempt]);
      await db.admin.query('UPDATE pms_write_queue SET verify_after=now() WHERE id=$1',[c.queueId]);
      c=await db.claim();assert.equal(c.mode,'verify');
    }
  }
  assert.equal(await db.claim(),null);
}));
test('PMS tool uses the approved browser manifest and cannot substitute another unit',async()=>fixture(async db=>{
  const payload={...db.job.manifest.payload};
  delete payload.reference;delete payload.requestId;
  // The trusted desktop manifest receives the connection-bound demo vendor from
  // the server. It is deliberately absent from the model-authored tool request.
  delete payload.vendorId;delete payload.vendorName;
  const request={organizationId:db.org,providerId:'buildium',toolName:'create_work_order',payload,
    idempotencyKey:'model-key-is-not-authority',approvalId:db.job.approval.id,personaId:'maintenance'};
  const queued=await db.run(s=>executePmsWrite(s,request));assert.equal(queued.status,'queued');assert.equal(queued.queueId,db.job.queueId);
  const denied=await db.run(s=>executePmsWrite(s,{...request,payload:{...payload,unitId:'other'}}));assert.equal(denied.status,'denied');
  assert.match(denied.reason,/fields differ/);
}));
test('legacy drain cannot claim a protocol-2 write',async()=>fixture(async db=>{
  const result=await db.run(s=>claimForRunner(s,db.org,'legacy-renderer'));
  assert.equal(result.outcome.status,'idle');assert.equal((await db.claim()).mode,'prepare');
}));
test('PMS protocol: a staff role widened into accounting fails the submission gate',async()=>fixture(async db=>{
  const c=await db.claim();
  await assert.rejects(db.run(s=>consumeBrowserGrant(s,db.org,db.device,{queueId:c.queueId,generation:c.generation,
    identity,facts,form:c.manifest.payload,permissions:{createWorkOrder:true,accounting:true}})),/restricted PMS role/);
}));
test('verified PMS receipt satisfies only its own existing task execution',async()=>fixture(async db=>{
  const executionId=randomUUID();
  await db.run(s=>reserveMutation(s,{taskId:db.job.task.id,organizationId:db.org,stepIndex:0,toolName:'create_work_order',idempotencyKey:executionId}));
  assert.equal(await db.run(s=>executionVerdict(s,db.org,executionId)),'unproven');
  const c=await db.claim();await db.grant(c);
  await db.run(s=>recordBrowserResult(s,db.org,db.device,{queueId:c.queueId,generation:c.generation,kind:'confirmed',identity,
    externalId:'WO-evidence',reference:c.manifest.reference,form:c.manifest.payload,facts:{...facts,linkedWorkOrderIds:['WO-evidence']}}));
  assert.equal(await db.run(s=>executionVerdict(s,db.org,executionId)),'confirmed');
  assert.equal(await db.run(s=>executionVerdict(s,db.org,'different-action')),'unproven');
}));

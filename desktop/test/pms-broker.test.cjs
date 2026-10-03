const test = require('node:test');
const assert = require('node:assert/strict');
const { PmsBroker, partitionFor, digest } = require('../pms-broker.cjs');

// Synthetic provider, never a claim about Buildium's real interface.
function fixture(options={}) {
  const identity={origin:'https://fixture.invalid',accountId:'account-1',staffId:'restricted'};
  const payload={propertyId:'P1',unitId:'U1',requestId:'R1',reference:'AVAL-test',summary:'Drain'};
  const facts={requestId:'R1',propertyId:'P1',unitId:'U1',status:'open',symptoms:'Drain',accessRestrictions:'Ask',linkedWorkOrderIds:[]};
  const steps=[{kind:'fill',label:'Summary',from:'summary'},{kind:'commit',button:'Create work order'}];
  const manifest={protocol:2,connectionId:'connection-1',provider:'fixture',identity,action:'maintenance.work_order.create',
    payload,payloadDigest:digest(payload),facts,factsDigest:digest(facts),steps,flowDigest:digest(steps),reference:payload.reference};
  const job={queueId:'queue-1',generation:1,mode:options.mode??'prepare',manifest,externalId:options.externalId??null};
  const events=[];let committed=0,granted=false,record=null,currentIdentity=identity,clock=1000;
  const driver={protocol:2,identity:async()=>currentIdentity,
    permissions:async()=>({createWorkOrder:true,accounting:false}),
    findByReference:async(ref,hint)=>{events.push({kind:'find',ref,hint});return record;},
    prepare:async()=>{events.push({kind:'prepare'});if(options.swapAccount)currentIdentity={...identity,staffId:'owner'};},
    readRequest:async()=>facts,readForm:async()=>options.wrongForm?{...payload,unitId:'wrong'}:payload,
    commit:async(step,form,boundIdentity,expiry)=>{
      assert.ok(granted);assert.equal(step.kind,'commit');assert.deepEqual(form,payload);
      assert.deepEqual(currentIdentity,boundIdentity);assert.ok(Date.parse(expiry)>clock);
      if(options.clickFailure)throw Error('Connection interrupted at click');
      committed++;events.push({kind:'commit'});
      if(!options.delayed)record={externalId:'WO-1',reference:payload.reference,form:payload};
    }};
  const transport=async body=>{
    events.push(body);
    if(body.intent==='register')return{organizationId:'workspace-1'};
    if(body.intent==='claim')return{instruction:job};
    if(body.intent==='grant'){
      if(options.denied)throw Error('Approval revoked');
      granted=true;
      if(options.lostGrant)throw Error('Response lost after durable grant');
      if(options.expired)clock+=6000;
      return{grantId:'grant-1',queueId:job.queueId,generation:job.generation,payloadDigest:manifest.payloadDigest,expiresAt:new Date(6000).toISOString()};
    }
    if(body.intent==='result')return{status:body.kind==='confirmed'?'confirmed':granted?'submission_unknown':'needs_review'};
    throw Error('Unknown request');
  };
  const broker=new PmsBroker({transport,driverFor:()=>driver,now:()=>clock});
  return{broker,job,events,committed:()=>committed,showRecord:()=>{record={externalId:'WO-1',reference:payload.reference,form:payload};}};
}
test('broker fetches its own manifest, grants once, and confirms by read-back',async()=>{
  const f=fixture();assert.equal((await f.broker.tick()).status,'confirmed');assert.equal(f.committed(),1);
  const first=f.events.findIndex(e=>e.kind==='commit'),grant=f.events.findIndex(e=>e.intent==='grant');
  assert.ok(grant<first);assert.ok(f.events.slice(first+1).some(e=>e.kind==='find'));
});
for(const fault of ['swapAccount','wrongForm','denied','lostGrant','expired','clickFailure']) {
  test(`broker ${fault} never submits an unauthorized second action`,async()=>{
    const f=fixture({[fault]:true});const result=await f.broker.tick();
    assert.notEqual(result.status,'confirmed');assert.equal(f.committed(),0);
    if(['lostGrant','expired','clickFailure'].includes(fault))assert.equal(result.status,'submission_unknown');
  });
}
test('verification mode never prepares or clicks; late external ID is a read-back hint',async()=>{
  const f=fixture({mode:'verify',externalId:'WO-late'});f.showRecord();
  assert.equal((await f.broker.tick()).status,'confirmed');assert.equal(f.committed(),0);
  assert.ok(!f.events.some(e=>e.kind==='prepare'||e.intent==='grant'));
  assert.equal(f.events.find(e=>e.kind==='find').hint.externalId,'WO-late');
});
test('a consumed grant is never reused even if the server repeats an instruction',async()=>{
  const f=fixture({delayed:true});assert.equal((await f.broker.tick()).status,'submission_unknown');
  assert.equal(f.committed(),1);await f.broker.tick();assert.equal(f.committed(),1);
});
test('manifest tampering and invalid commit boundaries stop before prepare',async()=>{
  for(const fault of ['payload','steps','twoCommits','noCommit','postCommitWrite']) {
    const f=fixture();const m=f.job.manifest;
    if(fault==='payload')m.payload.unitId='attacker';
    if(fault==='steps')m.steps[0].label='different';
    if(fault==='twoCommits')m.steps.push({kind:'commit',button:'Pay'});
    if(fault==='noCommit')m.steps=m.steps.slice(0,1);
    if(fault==='postCommitWrite')m.steps.push({kind:'fill',label:'Amount',from:'amount'});
    if(!['payload','steps'].includes(fault))m.flowDigest=digest(m.steps);
    await f.broker.tick();assert.equal(f.committed(),0);assert.ok(!f.events.some(e=>e.kind==='prepare'));
  }
});
test('sessions are isolated by both workspace and connection',()=>{
  const base={organizationId:'one',connectionId:'one',provider:'buildium'};
  assert.equal(partitionFor(base),partitionFor({...base}));
  assert.notEqual(partitionFor(base),partitionFor({...base,organizationId:'two'}));
  assert.notEqual(partitionFor(base),partitionFor({...base,connectionId:'two'}));
  assert.throws(()=>partitionFor({provider:'buildium'}));
});
test('manifest hashing is canonical and rejects unsupported numbers',()=>{
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2,unset:undefined}));
  assert.equal(digest([undefined,-0]),digest([null,0]));
  assert.throws(()=>digest(NaN));assert.throws(()=>digest(Infinity));assert.throws(()=>digest(undefined));
});

"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {driver,createSession,approvedPayload,subjectFor,exactFlow,PRIORITY,profileEvidence,electronPage,authenticationDigest}=require("../providers/buildium.cjs");

const identity={origin:"https://demo.managebuilding.com",accountId:"demo.managebuilding.com",staffId:"Aval Account"};
const payload={propertyId:"114672",unitId:"609746",requestId:"291999",reference:"AVAL-0123456789abcdef0123456789abcdef",
  summary:"Synthetic sink leak",description:"Inspect the fictional kitchen sink leak.",priority:"high",vendorId:"2307999",vendorName:"Aval Demo Vendor — DO NOT CONTACT"};
const steps=[{kind:"open",page:"Request work orders"},{kind:"fill",label:"Subject",from:"summary"},
  {kind:"choose",label:"Vendor",from:"vendorName"},{kind:"fill",label:"Work to be performed",from:"description"},
  {kind:"choose",label:"Priority",from:"priority"}];

function fixture(overrides={}) {
  let form=null,commits=0,record=overrides.record??null;
  const page={
    identity:async()=>overrides.identity??{...identity,verified:true},
    permissions:async()=>overrides.permissions??{createWorkOrder:true,accounting:false},
    find:async()=>overrides.rows??(record?[{href:`/manager/app/tasks/${payload.requestId}/work-order/${record.externalId}`,text:subjectFor(payload)}]:[]),
    detail:async()=>overrides.detail??record??{externalId:"42699",requestId:payload.requestId,propertyId:payload.propertyId,unitId:payload.unitId,
      heading:`${subjectFor(payload)} - #291999-1`,priority:"High",vendorName:payload.vendorName,description:payload.description},
    openForm:async id=>assert.equal(id,payload.requestId),
    fill:async value=>{form={...value};return overrides.fill??{ok:true};},
    form:async()=>overrides.form??{...form,commitButtons:1,accountingVisible:false},
    commit:async value=>{commits++;assert.equal(value.subject,subjectFor(payload));return overrides.commit??{ok:true};},
    request:async id=>({url:`${identity.origin}/manager/app/tasks/${id}/task-summary`,propertyId:payload.propertyId,unitId:payload.unitId,
      status:"New",description:payload.description,accessRestrictions:"Permission to enter",linkedWorkOrderIds:record?[record.externalId]:[]}),
  };
  const session=createSession({identity},page);
  return{session,page,commits:()=>commits,setRecord:value=>{record=value}};
}

test("Buildium adapter prepares only the reviewed fields and stops before commit",async()=>{
  const f=fixture();await f.session.prepare(steps,payload);
  assert.deepEqual(await f.session.readForm(),payload);assert.equal(f.commits(),0);
});

test("Buildium account initials alone never authorize setup or commit",async()=>{
  const f=fixture({identity:{...identity,verified:false}});
  await assert.rejects(f.session.identity(),/unique staff identity/);
  await assert.rejects(f.session.commit({kind:"commit",button:"Save work order"},payload,identity,new Date(Date.now()+5000).toISOString()),/unique staff identity/);
  assert.equal(f.commits(),0);
  const result=await driver.setup({identity},{page:()=>({...f.page,showLogin:async()=>{}})});
  assert.equal(result.session,"BLOCKED");assert.equal(result.recovered,false);
});

test('Fresh profile evidence distinguishes confirmed login from execution authority',async()=>{
  const snapshot={url:`${identity.origin}/manager/app/settings/my-settings/general`,heading:'My settings',emailCount:1,
    email:'STAFF@example.invalid',firstName:'Aval',lastName:'Demo',accountLabel:'AD Account'};
  const evidence=profileEvidence(snapshot,identity.origin);
  assert.equal(evidence.email,'staff@example.invalid');
  assert.equal(evidence.executionIdentityVerified,false);
  for(const change of [{emailCount:2},{email:''},{heading:'Sign in'},{url:'https://other.managebuilding.com/manager/app/settings/my-settings/general'},
    {url:`${identity.origin}/manager/public/authentication/login`}])assert.equal(profileEvidence({...snapshot,...change},identity.origin),null);
  const f=fixture({identity:{...identity,verified:false}});
  const result=await driver.setup({identity},{page:()=>({...f.page,showLogin:async()=>{},setupProfile:async()=>evidence})});
  assert.equal(result.recovered,false);assert.equal(result.session,'BLOCKED');
  assert.match(result.reason,/Login is confirmed/);assert.equal(f.commits(),0);
});

test('An unfinished login requests sign-in, not an invented MFA prerequisite',async()=>{
  const result=await driver.setup({identity},{page:()=>({showLogin:async()=>{},identity:async()=>({...identity,staffId:''})})});
  assert.equal(result.session,'AUTHENTICATING');assert.equal(result.recovered,false);
});

function electronFixture(fixtureOptions={}){
  const origin=identity.origin;let mainUrl=`${origin}/manager/app/tasks/${payload.requestId}/work-order/add`;
  let observerUrl='',cookie='session-a',email='staff@example.invalid',commits=0;
  const main={getURL:()=>mainUrl,loadURL:async url=>{mainUrl=url;},
    session:{cookies:{get:async options=>{
      assert.equal(options.url,`${origin}/manager/app/`,'must include path-scoped Buildium authentication cookies');
      return fixtureOptions.noProtectedCookie?[]:[{domain:'demo.managebuilding.com',path:'/manager',name:'session',value:cookie,httpOnly:true,secure:true}];
    }}},
    executeJavaScript:async script=>{
      if(script.includes('function snapshotIdentity'))return {origin,staffId:'AD Account'};
      if(script.includes('function commitForm')){commits++;return {ok:true};}
      throw Error('Unexpected main-window read');
    }};
  const observer={getURL:()=>observerUrl,loadURL:async url=>{observerUrl=url;},executeJavaScript:async script=>{
    if(script.includes('emailCount:emails.length'))return {url:observerUrl,heading:'My settings',emailCount:1,email,firstName:'Aval',lastName:'Demo',accountLabel:'AD Account'};
    if(script.includes('function requestSnapshot'))return {url:observerUrl,propertyId:payload.propertyId,unitId:payload.unitId,status:'New',description:payload.description};
    if(script.includes('hasRows:'))return {empty:true,hasRows:false};
    throw Error('Unexpected observer read');
  }};
  const page=electronPage({identity},()=>({webContents:main,show(){}}),()=>({webContents:observer}));
  return {page,mainUrl:()=>mainUrl,changeCookie:()=>{cookie='session-b';},changeEmail:()=>{email='different@example.invalid';},commits:()=>commits};
}

test('Electron profile, request and reference reads preserve the prepared form',async()=>{
  const f=electronFixture(),url=f.mainUrl();const actual=await f.page.identity();
  assert.equal(actual.verified,true);assert.equal(actual.staffId,'email:staff@example.invalid');
  await f.page.request(payload.requestId);assert.deepEqual(await f.page.find(payload.requestId,payload.reference),[]);
  assert.equal(f.mainUrl(),url);assert.equal(f.commits(),0);
  f.changeEmail();assert.equal((await f.page.identity()).staffId,'email:different@example.invalid');
});

test('Electron commit rejects session replacement and consumed identity proof',async()=>{
  const changed=electronFixture(),bound=await changed.page.identity();changed.changeCookie();
  await assert.rejects(changed.page.commit({identity:bound}),/session changed/);assert.equal(changed.commits(),0);
  const fresh=electronFixture(),identityNow=await fresh.page.identity();
  await fresh.page.commit({identity:identityNow});assert.equal(fresh.commits(),1);
  await assert.rejects(fresh.page.commit({identity:identityNow}),/session changed/);assert.equal(fresh.commits(),1);
});

test('Authentication fingerprint ignores analytics but detects protected session changes',()=>{
  const session={domain:'demo.managebuilding.com',path:'/',name:'session',value:'a',httpOnly:true,secure:true};
  const telemetry={...session,name:'analytics',httpOnly:false};
  assert.equal(authenticationDigest([session]),authenticationDigest([session,{...telemetry,value:'b'}]));
  assert.notEqual(authenticationDigest([session]),authenticationDigest([{...session,value:'b'}]));
  assert.throws(()=>authenticationDigest([telemetry]),/no observable secure/);
  assert.throws(()=>authenticationDigest([{...session,secure:false}]),/no observable secure/);
});

test('Read-only preflight works without cookie-shape assumptions but cannot authorize writes',async()=>{
  const f=electronFixture({noProtectedCookie:true});
  const current=await f.page.identity();assert.equal(current.verified,false);assert.equal(current.profile.email,'staff@example.invalid');
  const result=await driver.setup({identity,preflightRequestId:payload.requestId,allowedPropertyId:payload.propertyId},{page:()=>f.page});
  assert.equal(result.readOnlyReady,true);assert.equal(result.recovered,false);assert.equal(result.session,'BLOCKED');
  assert.equal(result.request.unitId,payload.unitId);assert.equal(f.commits(),0);
  await assert.rejects(f.page.commit({identity:current}),/session changed/);
  const wrong=await driver.setup({identity,preflightRequestId:payload.requestId,allowedPropertyId:'999'},{page:()=>f.page});
  assert.equal(wrong.readOnlyReady,undefined);assert.match(wrong.reason,/does not belong/);
});

test("Buildium refuses changed staff identity at the last adapter boundary",async()=>{
  const f=fixture({identity:{...identity,staffId:"other-staff",verified:true}});
  await assert.rejects(f.session.commit({kind:"commit",button:"Save work order"},payload,identity,new Date(Date.now()+5000).toISOString()),/account changed/);
  assert.equal(f.commits(),0);
});

test("Buildium preflight does not infer reference lookup or denied routes from a form",async()=>{
  const f=fixture();
  const result=await driver.setup({identity,preflightRequestId:payload.requestId,allowedPropertyId:payload.propertyId},
    {page:()=>({...f.page,showLogin:async()=>{},controlledVendor:async()=>({id:payload.vendorId,name:payload.vendorName})})});
  assert.equal(result.recovered,false);assert.equal(result.feasibility.searchableReference,false);
  assert.equal(result.feasibility.restrictedStaff,false);assert.deepEqual(result.discovered,[]);
});

test("Buildium setup does not require an additional MFA enrollment flag after authentication",async()=>{
  const f=fixture();
  const result=await driver.setup({identity,preflightRequestId:payload.requestId,allowedPropertyId:payload.propertyId},
    {page:()=>({...f.page,showLogin:async()=>{},controlledVendor:async()=>({id:payload.vendorId,name:payload.vendorName}),
      pilotPreflight:async()=>({searchableReference:true,administrationDenied:true,accountingDenied:true})})});
  assert.equal(result.recovered,true);assert.equal(result.session,"ACTIVE");
});

test("Buildium adapter maps Aval urgency without inventing a provider priority",()=>{
  assert.equal(PRIORITY.medium,"Normal");assert.equal(PRIORITY.emergency,"High");
});

test("Buildium adapter refuses a non-controlled vendor and changed workflow",async()=>{
  assert.throws(()=>approvedPayload({...payload,vendorName:"Real Plumber"}),/controlled Aval demo vendor/);
  assert.throws(()=>exactFlow([...steps].reverse()),/reviewed Buildium preparation flow changed/);
});

test("Buildium adapter returns changed form evidence instead of approving it",async()=>{
  const f=fixture({form:{subject:"attacker",description:payload.description,vendorId:payload.vendorId,vendorName:payload.vendorName,priority:"High"}});
  await f.session.prepare(steps,payload);assert.equal((await f.session.readForm()).formChanged,true);
});

test("Buildium duplicate lookup requires one exact reference and exact read-back",async()=>{
  const manifest={payload};
  const none=fixture();assert.equal(await none.session.findByReference(payload.reference,{manifest}),null);
  const good=fixture({record:{externalId:"42699",requestId:payload.requestId,propertyId:payload.propertyId,unitId:payload.unitId,
    heading:`${subjectFor(payload)} - #291999-1`,priority:"High",vendorName:payload.vendorName,description:payload.description}});
  assert.equal((await good.session.findByReference(payload.reference,{manifest})).externalId,"42699");
  const duplicate=fixture({rows:[{href:"/work-order/1"},{href:"/work-order/2"}]});
  await assert.rejects(duplicate.session.findByReference(payload.reference,{manifest}),/More than one/);
  const wrong=fixture({rows:[{href:"/manager/app/tasks/291999/work-order/42699"}],detail:{externalId:"42699",requestId:payload.requestId,
    propertyId:"999",unitId:payload.unitId,heading:subjectFor(payload),priority:"High",vendorName:payload.vendorName,description:payload.description}});
  await assert.rejects(wrong.session.findByReference(payload.reference,{manifest}),/read-back differs/);
});

test("Buildium commit delegates one exact click after the broker grant",async()=>{
  const f=fixture();await f.session.prepare(steps,payload);
  await f.session.commit({kind:"commit",button:"Save work order"},payload,identity,new Date(Date.now()+5000).toISOString());
  assert.equal(f.commits(),1);
  await assert.rejects(f.session.commit({kind:"commit",button:"Create and schedule"},payload,identity,new Date(Date.now()+5000).toISOString()),/commit boundary changed/);
});

test('Reference lookup refuses foreign account or request links before read-back',async()=>{
  for(const href of [`https://other.managebuilding.com/manager/app/tasks/${payload.requestId}/work-order/42699`,
    '/manager/app/tasks/99999/work-order/42699','/manager/app/tasks/291999/work-order/42699unexpected']){
    const f=fixture({rows:[{href}]});let reads=0;f.page.detail=async()=>{reads++;throw Error('must not read');};
    await assert.rejects(f.session.findByReference(payload.reference,{manifest:{payload}}),/different tenant or request/);
    assert.equal(reads,0);assert.equal(f.commits(),0);
  }
});

test("Buildium request evidence carries stable source IDs and linked effects",async()=>{
  const f=fixture({record:{externalId:"42699"}});const facts=await f.session.readRequest(payload.requestId);
  assert.deepEqual(facts,{requestId:payload.requestId,propertyId:payload.propertyId,unitId:payload.unitId,status:"New",
    symptoms:payload.description,accessRestrictions:"Permission to enter",linkedWorkOrderIds:["42699"]});
});

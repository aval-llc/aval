import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { withDbSession } from '../../db/postgres/session.ts';
import { applyImport } from '../../lib/operations/import-apply.ts';
import { listOpenConflicts, resolveConflict, SYNC_FRESHNESS_POLICY } from '../../lib/operations/provenance.ts';
import { readFacts, actionableFact, recordFact } from '../../lib/agents/facts.ts';
import { operationalFacts } from '../../db/postgres/schema.ts';
import { workOrders, leasingLeads, residents, integrationConnections, conversations, messages, documents, agentTasks } from '../../db/postgres/schema.ts';
import { syncGmail } from '../../lib/communications/gmail-sync.ts';
import { createTask } from '../../lib/agents/tasks.ts';
import { maintenanceContext, createInboundWorkOrder } from '../../lib/communications/maintenance-intake.ts';
import { queueInboundTask } from '../../lib/communications/intake.ts';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { POST as manualImport } from '../../app/api/operations/import/route.ts';
import { POST as checkout } from '../../app/api/billing/checkout/route.ts';
import { POST as subscriptionStart } from '../../app/api/integrations/subscription/start/route.ts';

export async function runPilotCases(t, {session,userA,userB,config,administrator}) {
  const org = await session(userA,s=>s.identity.organizationId);
  const run = work => session(userA,s=>work(s,org));
  const prefix=randomUUID(), source={sourceProvider:`pilot-${prefix}`,sourceConnectionId:null,externalId:null};
  const batch={properties:[{externalId:'p',name:`Pilot ${prefix}`}],units:[{externalId:'u',propertyExternalId:'p',unitNumber:'101'}], residents:[{externalId:'r',displayName:'Synthetic Resident',email:`${prefix}@example.test`}],leases:[{externalId:'l',unitExternalId:'u',residentExternalIds:['r'],startDate:'2026-01-01',rentCents:10000}],workOrders:[{externalId:'w',propertyExternalId:'p',summary:'Synthetic repair',reportedAt:'2026-01-01T00:00:00Z'}],leads:[{externalId:'lead',inquiredAt:'2026-01-01T00:00:00Z'}],glAccounts:[{externalId:'a',code:prefix,name:'Test income',accountType:'income'}],glTransactions:[{externalId:'j',accountExternalId:'a',amountCents:1000,postedAt:'2026-01-01T00:00:00Z'}]};
  await t.test('re-import updates work orders, leads and residents; exact replay is unchanged',async()=>{
    await run((s,o)=>applyImport(s,o,batch,source));
    const replay=await run((s,o)=>applyImport(s,o,batch,source));
    assert.equal(replay.unchanged.workOrders,1);assert.equal(replay.unchanged.leads,1);
    const changed={workOrders:[{...batch.workOrders[0],completedAt:'2026-01-02T00:00:00Z'}],leads:[{...batch.leads[0],contactedAt:'2026-01-02T00:00:00Z'}],residents:[{...batch.residents[0],phone:'+15555550111'}]};
    const result=await run((s,o)=>applyImport(s,o,changed,source));
    assert.equal(result.updated.workOrders,1);assert.equal(result.updated.leads,1);assert.equal(result.updated.residents,1);
    const [order]=await run(s=>s.db.select().from(workOrders).where(eq(workOrders.sourceProvider,source.sourceProvider)));
    const [lead]=await run(s=>s.db.select().from(leasingLeads).where(eq(leasingLeads.sourceProvider,source.sourceProvider)));
    assert.equal(order.status,'completed');assert.equal(lead.stage,'contacted');
    assert.equal((await run((s,o)=>applyImport(s,o,changed,source))).unchanged.workOrders,1);
  });
  await t.test('a real import records provenance, and two sources disagreeing is visible as a conflict',async()=>{
    // The join this exercises did not exist: operational_facts was fully built
    // and nothing on the import path ever wrote to it, so a workspace could
    // sync two systems that disagreed and the fact layer would show nothing.
    const name=`Provenance ${prefix}`;
    const first={sourceProvider:`alpha-${prefix}`,sourceConnectionId:null,externalId:null};
    const second={sourceProvider:`beta-${prefix}`,sourceConnectionId:null,externalId:null};
    await run((s,o)=>applyImport(s,o,{properties:[{externalId:'pv',name,city:'Berkeley'}]},first));
    const [property]=await run(s=>s.db.select().from(operationalFacts).where(eq(operationalFacts.factType,'city')).limit(1));
    assert.ok(property,'the import wrote a fact');

    const entityId=property.entityId;
    const afterFirst=await run((s,o)=>readFacts(s,o,'property',entityId,'city'));
    assert.equal(afterFirst.length,1);
    assert.equal(afterFirst[0].value,'Berkeley');
    assert.equal(afterFirst[0].sourceType,'provider');
    assert.equal(afterFirst[0].sourceProvider,first.sourceProvider);
    assert.equal(afterFirst[0].authoritativeness,'authoritative','a provider is the system of record');
    assert.ok(afterFirst[0].syncedAt instanceof Date,'when Aval looked is always known');
    assert.equal(afterFirst[0].stale,false,'a freshly synced value is current');
    const [stored]=await run(s=>s.db.select().from(operationalFacts).where(eq(operationalFacts.id,afterFirst[0].id)));
    assert.equal(stored.freshnessPolicy,SYNC_FRESHNESS_POLICY,'the horizon names the rule that produced it');
    assert.ok(stored.expiresAt,'freshness is a stored horizon, staleness is derived from it');
    assert.equal(stored.observedAt,null,'an honest null beats stamping now on an unknown observation time');

    // A second system reports a different city for the same property.
    await run((s,o)=>applyImport(s,o,{properties:[{externalId:'pv2',name,city:'Oakland'}]},second));
    const disputed=await run((s,o)=>readFacts(s,o,'property',entityId,'city'));
    assert.equal(disputed.length,2,'each source keeps its own row');
    assert.ok(disputed.every(f=>f.conflictState==='conflicted'),'both sides are marked, neither is discarded');
    assert.equal(actionableFact(disputed),null,'an agent gets no quiet answer while sources disagree');

    const conflicts=await run((s,o)=>listOpenConflicts(s,o));
    const conflict=conflicts.find(c=>c.entityId===entityId&&c.field==='city');
    assert.ok(conflict,'the disagreement surfaces on the conflict list');
    assert.deepEqual([conflict.valueA,conflict.valueB].sort(),['Berkeley','Oakland']);

    // A person settles it, and the losing observation is superseded rather than erased.
    assert.equal(await run((s,o)=>resolveConflict(s,o,conflict.id,'kept_a')),true);
    const settled=await run((s,o)=>readFacts(s,o,'property',entityId,'city'));
    assert.equal(settled.length,2,'the trail of what disagreed is kept');
    assert.equal(settled.filter(f=>f.conflictState==='superseded').length,1);
    const chosen=actionableFact(settled);
    assert.ok(chosen,'the settled value is actionable again');
    assert.equal(chosen.value,conflict.valueA);
    assert.ok(!(await run((s,o)=>listOpenConflicts(s,o))).some(c=>c.id===conflict.id));
  });

  await t.test('a model may not label its own inference authoritative',async()=>{
    const entityId=`inference-${prefix}`;
    const inferred=await run((s,o)=>recordFact(s,{organizationId:o,entityType:'property',entityId,factType:'occupancy',
      value:'0.94',sourceType:'inference',confidence:0.7,syncedAt:new Date()}));
    assert.equal(inferred.authoritativeness,'inferred','authority comes from the source kind, never the caller');
    assert.equal(inferred.confidence,0.7,'an inference has to say how sure it is');
    const human=await run((s,o)=>recordFact(s,{organizationId:o,entityType:'property',entityId,factType:'occupancy',
      value:'0.88',sourceType:'human',syncedAt:new Date()}));
    assert.equal(human.authoritativeness,'human_confirmed','a person is not the system of record either');
  });

  await t.test('changed financial data and changed connection ownership roll back the entire batch',async()=>{
    await assert.rejects(run((s,o)=>applyImport(s,o,{residents:[{...batch.residents[0],displayName:'Must rollback'}],glTransactions:[{...batch.glTransactions[0],amountCents:2000}]},source)),/Reconcile/);
    const [resident]=await run(s=>s.db.select().from(residents).where(eq(residents.sourceProvider,source.sourceProvider)));
    assert.equal(resident.displayName,'Synthetic Resident');
    await assert.rejects(run((s,o)=>applyImport(s,o,{residents:batch.residents},{...source,sourceConnectionId:'different'})),/Source connection changed/);
  });
  await t.test('source-owned lease occupants synchronize without silently retaining removed residents',async()=>{
    const empty={leases:[{...batch.leases[0],residentExternalIds:[]}]};
    assert.equal((await run((s,o)=>applyImport(s,o,empty,source))).updated.leases,1);
    assert.equal((await run((s,o)=>applyImport(s,o,empty,source))).unchanged.leases,1);
    assert.equal((await run((s,o)=>applyImport(s,o,{leases:batch.leases},source))).updated.leases,1);
  });
  await t.test('Gmail saves pages atomically, survives a new session, and refuses account changes',async(t)=>{
    const connection={id:randomUUID(),externalAccountId:`${prefix}@gmail.test`}, now=new Date();
    await run(s=>s.db.insert(integrationConnections).values({...connection,organizationId:org,provider:'gmail',category:'Communication',status:'connected',authMode:'oauth2',createdBy:userA,createdAt:now,updatedAt:now}));
    const fixture=id=>({id,threadId:`thread-${id}`,labelIds:['INBOX'],internalDate:String(now.getTime()),payload:{mimeType:'text/plain',headers:[{name:'From',value:`${prefix}@example.test`},{name:'Message-ID',value:`<${id}@example.test>`},{name:'Subject',value:'Repair'}],body:{data:Buffer.from('Please repair the sink').toString('base64url')}}});
    let fail=true;
    t.mock.method(globalThis,'fetch',async input=>{
      const url=new URL(input);
      if(url.pathname.endsWith('/profile'))return Response.json({historyId:'100'});
      if(url.pathname.endsWith('/messages'))return Response.json({messages:[{id:'first'},{id:'second'}]});
      if(url.pathname.endsWith('/history'))return Response.json({historyId:'101',history:[{messagesAdded:[{message:{id:'first'}}]}]});
      if(url.pathname.endsWith('/second')&&fail)return new Response('',{status:429});
      return Response.json(fixture(url.pathname.split('/').at(-1)));
    });
    await assert.rejects(run(s=>syncGmail(s,org,connection,'fixture')),/rate limiting/);
    assert.equal((await run(s=>s.db.execute(sql`select 1 from communication_inbox_state where connection_id=${connection.id}`))).rows.length,0);
    fail=false;
    assert.equal((await run(s=>syncGmail(s,org,connection,'fixture'))).imported,2);
    assert.equal((await run(s=>syncGmail(s,org,connection,'fixture'))).imported,0);
    const pending=await run(s=>s.db.execute(sql`select status from inbound_pending where organization_id=${org} and external_message_id in ('first','second')`));
    assert.equal(pending.rows.length,2);assert.ok(pending.rows.every(r=>r.status==='onboarding_required'));
    await assert.rejects(run(s=>syncGmail(s,org,{...connection,externalAccountId:'changed@gmail.test'},'fixture')),/account changed/);
  });
  await t.test('sender matching is tenant scoped and work-order creation is replay-safe',async()=>{
    const c=randomUUID(),m=randomUUID(),now=new Date();
    await run(s=>s.db.insert(conversations).values({id:c,organizationId:org,channel:'gmail',externalThreadId:c,contactDisplayName:'Synthetic Resident',lastMessageAt:now,createdAt:now,updatedAt:now}));
    await run(s=>s.db.insert(messages).values({id:randomUUID(),conversationId:c,externalMessageId:m,direction:'inbound',body:'The sink leaks',payloadJson:JSON.stringify({sender:`${prefix}@example.test`,threadId:c,rfcMessageId:'<test@example.test>'}),createdAt:now}));
    const context=await run(s=>maintenanceContext(s,org,c,m));assert.equal(context.status,'matched');
    await assert.rejects(session(userB,s=>maintenanceContext(s,s.identity.organizationId,c,m)),/requires a Gmail conversation/);
    const args={conversation_id:c,message_id:m,resident_id:context.match.residentId,property_id:context.match.propertyId,unit_id:context.match.unitId,summary:'Repair sink',priority:'routine'};
    const first=await run(s=>createInboundWorkOrder(s,org,args,'approved-synthetic'));
    const second=await run(s=>createInboundWorkOrder(s,org,args,'approved-synthetic'));
    assert.equal(first.workOrderId,second.workOrderId);assert.equal(second.duplicate,true);
    await assert.rejects(run(s=>createInboundWorkOrder(s,org,{...args,property_id:'other'},'other')),/match changed/);
    await run(s=>queueInboundTask(s,org,c,m,'The sink leaks'));
    const pending=await run(s=>s.db.execute(sql`select status from inbound_pending where organization_id=${org} and conversation_id=${c}`));
    assert.equal(pending.rows[0].status,'onboarding_required');
  });
  await t.test('messaging account uniqueness holds across concurrent workspaces',async()=>{
    const account=`AC${randomUUID()}`;
    const connect=user=>session(user, s=>{const now=new Date();return s.db.insert(integrationConnections).values({id:randomUUID(),organizationId:s.identity.organizationId,provider:'twilio',category:'Communication',status:'connected',authMode:'credentials',externalAccountId:account,createdBy:user,createdAt:now,updatedAt:now});});
    const results=await Promise.allSettled([connect(userA),connect(userB)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  });
  const grantId=randomUUID();
  await administrator.query('insert into access_grants (id,organization_id,principal_id,role,organization_scope,created_at,updated_at) values ($1,$2,$3,\'operator\',true,now(),now())',[grantId,org,userB]);
  const member=work=>withDbSession(config,{principalId:userB,organizationId:org,actorId:userB,requestId:randomUUID()},work);
  const previousEnv={...env};env.DATABASE_URL=config.connectionString;delete env.HYPERDRIVE;
  const request=(user,path,body)=>new Request(`https://app.aval.llc${path}`,{method:'POST',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json',cookie:`aval-active-organization=${org}`}),{userId:user,email:`${user}@example.test`,displayName:user,emailVerified:true}),body:JSON.stringify(body)});
  try {
    await t.test('manual imports reject members and forged server provenance; purchase/login gates are closed',async()=>{
      assert.equal((await manualImport(request(userB,'/api/operations/import',{batch,dryRun:true}),undefined)).status,403);
      for(const field of ['sourceProvider','sourceConnectionId','syncRunId']) assert.equal((await manualImport(request(userA,'/api/operations/import',{batch,[field]:'forged'}),undefined)).status,400);
      assert.equal((await checkout(request(userA,'/api/billing/checkout',{kind:'topup',id:'any'}),undefined)).status,409);
      assert.equal((await subscriptionStart(request(userA,'/api/integrations/subscription/start',{provider:'claude'}),undefined)).status,409);
    });
    await t.test('approver can write operational records but cannot change connections',async()=>{
      await administrator.query("update access_grants set role='approver' where id=$1",[grantId]);
      const connection=await run(s=>s.db.select().from(integrationConnections).limit(1));
      const changed=await member(s=>s.db.update(integrationConnections).set({status:'disconnected'}).where(eq(integrationConnections.id,connection[0].id)).returning());
      assert.equal(changed.length,0);
      const [order]=await run(s=>s.db.select().from(workOrders).where(eq(workOrders.sourceProvider,source.sourceProvider)));
      const result=await member(s=>s.db.update(workOrders).set({summary:'Approver reviewed'}).where(eq(workOrders.id,order.id)).returning());
      assert.equal(result.length,1);
      for(const table of ['agent_tasks','documents','conversations','work_orders']) {
        const policy=await administrator.query('select 1 from pg_policies where tablename=$1 and policyname=$2',[table,`${table}_approver_insert`]);assert.equal(policy.rowCount,1);
      }
      const created=await member(s=>createTask(s,{organizationId:org,userId:userB,agentId:'maintenance',goal:'Read maintenance context',check:{kind:'evidence',tools:['get_maintenance_performance']}}));
      assert.equal((await member(s=>s.db.update(agentTasks).set({goal:'Updated operational goal'}).where(eq(agentTasks.id,created.id)).returning())).length,1);
      const documentId=randomUUID(),conversationId=randomUUID(),now=new Date();
      await member(s=>s.db.insert(documents).values({id:documentId,organizationId:org,title:'Synthetic',kind:'text',contentText:'fixture',charCount:7,uploadedBy:userB,createdAt:now}));
      assert.equal((await member(s=>s.db.update(documents).set({title:'Reviewed'}).where(eq(documents.id,documentId)).returning())).length,1);
      await member(s=>s.db.insert(conversations).values({id:conversationId,organizationId:org,channel:'gmail',externalThreadId:conversationId,contactDisplayName:'Synthetic',lastMessageAt:now,createdAt:now,updatedAt:now}));
      assert.equal((await member(s=>s.db.update(conversations).set({contactDisplayName:'Reviewed'}).where(eq(conversations.id,conversationId)).returning())).length,1);
    });
  } finally {
    await administrator.query('delete from access_grants where id=$1',[grantId]);
    for(const key of Object.keys(env))delete env[key];Object.assign(env,previousEnv);
  }
}

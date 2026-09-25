import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { integrationConnections } from '../../db/postgres/schema.ts';
import { buildEffectiveWorkspaceGraph } from '../../lib/setup/workspace-graph.ts';
import { effectiveEmployeeAccess, employeeExecutionRefusal } from '../../lib/agents/employee-access.ts';
import { createEmployee, grantScope, revokeScope, updateEmployee } from '../../lib/agents/employees.ts';
import { createTask, getTask } from '../../lib/agents/tasks.ts';
import { executionAuthority } from '../../lib/agents/autonomy-storage.ts';
import { resolveDashboardState } from '../../lib/operations/dashboard-state.ts';
import { setPreferenceFromSetup, getPreferenceContext } from '../../lib/ask-aval/preferences.ts';
import { readOnboarding,writeOnboarding } from '../../lib/onboarding/storage.ts';
import { POST as employeeAction } from '../../app/api/agents/employees/[id]/route.ts';
import { GET as graphRoute } from '../../app/api/setup/workspace-graph/route.ts';
import { upsertMembership } from '../../lib/organizations/membership.ts';

export async function runSetupGraphCases(t,{session,config}) {
 const user='graph_'+randomUUID(),outsider='graph_other_'+randomUUID();
 let org,employeeId,connectionId,taskId;
 const run=fn=>session(user,s=>fn(s,s.identity.organizationId));
 await t.test('Setup projects an empty workspace without fabricated connections or employees',async()=>{
  await run(async(s,o)=>{org=o;const g=await buildEffectiveWorkspaceGraph(s,o,user);assert.equal(g.total,0);assert.equal(g.connections.length,0);assert.equal(g.humans.length,1);assert.equal(g.edges.length,0);});
 });
 await t.test('email connection and explicit grants propagate into graph, execution access and dashboard',async()=>{
  await run(async(s,o)=>{
   const e=await createEmployee(s,o,user,{name:'Maya',role:'Resident Operations',status:'active',mayCommunicateExternally:true});employeeId=e.id;
   connectionId=randomUUID();const now=new Date();
   await s.db.insert(integrationConnections).values({id:connectionId,organizationId:o,provider:'gmail',category:'Communication',status:'connected',authMode:'oauth',externalAccountName:'maintenance@example.test',createdBy:user,createdAt:now,updatedAt:now});
   await grantScope(s,o,e.id,user,{kind:'connection',value:connectionId});
   assert.ok(!(await effectiveEmployeeAccess(s,o,e.id)).capabilities.includes('send_external_message'),'discovery does not grant');
   for(const value of ['read_conversation','list_conversations','send_external_message'])await grantScope(s,o,e.id,user,{kind:'capability',value});
   const graph=await buildEffectiveWorkspaceGraph(s,o,user);const employee=graph.employees.find(x=>x.id===e.id);
   assert.ok(employee.tools.includes('send_external_message'));assert.ok(graph.edges.some(x=>x.from===e.id&&x.to===connectionId&&x.active));
   assert.equal(resolveDashboardState('communications',graph.connections,[],false),'empty');
   assert.equal(resolveDashboardState('communications',graph.connections,[],true),'live');
   assert.equal(await employeeExecutionRefusal(s,o,e.id,'send_external_message',{provider:'gmail'}),null);
   assert.ok(await employeeExecutionRefusal(s,o,e.id,'send_external_message',{provider:'outlook'}),'a granted tool cannot target another provider');
   taskId=(await createTask(s,{organizationId:o,userId:user,employeeId:e.id,agentId:'general',goal:'Reply to resident',check:{kind:'plan'}})).id;
  });
 });
 await t.test('revoking a capability retracts it without deleting the work or claiming the connection is gone',async()=>{
  await run(async(s,o)=>{
   await revokeScope(s,o,employeeId,{kind:'capability',value:'send_external_message'});
   const g=await buildEffectiveWorkspaceGraph(s,o,user);assert.ok(!g.employees[0].tools.includes('send_external_message'));
   assert.ok(await employeeExecutionRefusal(s,o,employeeId,'send_external_message',{provider:'gmail'}));
   assert.equal((await getTask(s,o,taskId)).goal,'Reply to resident');assert.equal(g.connections[0].status,'connected');
   await grantScope(s,o,employeeId,user,{kind:'capability',value:'send_external_message'});
   await s.db.update(integrationConnections).set({status:'disconnected'}).where(eq(integrationConnections.id,connectionId));
   assert.ok(!(await effectiveEmployeeAccess(s,o,employeeId)).capabilities.includes('send_external_message'));
   const after=await buildEffectiveWorkspaceGraph(s,o,user);assert.equal(after.edges[0].active,false);assert.equal(resolveDashboardState('communications',after.connections,[],false),'preview');
  });
 });
 await t.test('employee independence narrows real execution policy, and workspace memory feeds runtime context',async()=>{
  await run(async(s,o)=>{
   const state=await readOnboarding(s,user,o);await writeOnboarding(s,user,o,{...state,preferences:{...state.preferences,autonomy:['autonomous']}});
   await updateEmployee(s,o,employeeId,{autonomyMode:'supervised'});
   assert.equal((await executionAuthority(s,o,user,taskId,'send_external_message',{})).mode,'supervised');
   await updateEmployee(s,o,employeeId,{autonomyMode:'assisted'});
   assert.equal((await executionAuthority(s,o,user,taskId,'send_external_message',{})).mode,'assisted');
   const options=await import('../../lib/ask-aval/preferences.ts');const topic=options.listPreferenceOptions()[0];
   await setPreferenceFromSetup(s,o,topic.topic,topic.statements[0].statement);
   assert.equal((await buildEffectiveWorkspaceGraph(s,o,user)).memory.length,1);
   assert.ok((await getPreferenceContext(s,o)).length>0);
  });
 });
 await t.test('graph and edit routes enforce tenancy and human owner authority',async()=>{
  await session(outsider,async(s)=>{const g=await buildEffectiveWorkspaceGraph(s,s.identity.organizationId,outsider,{employeeId});assert.equal(g.selected,null);assert.ok(!JSON.stringify(g).includes(connectionId));});
  const previous={...env};env.DATABASE_URL=config.connectionString;delete env.HYPERDRIVE;
  const request=(who,path,body)=>new Request('https://app.aval.llc'+path,{method:body?'POST':'GET',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json',cookie:`aval-active-organization=${org}`}),{userId:who,email:who+'@example.test',displayName:who,emailVerified:true}),...(body?{body:JSON.stringify(body)}:{})});
  try{
   const bad=await employeeAction(request(user,`/api/agents/employees/${employeeId}`,{action:'grant',scope:{kind:'connection',value:randomUUID()}}),undefined);assert.equal(bad.status,404);
   await run(s=>upsertMembership(s,{organizationId:org,userId:outsider,role:'member'}));
   const denied=await employeeAction(request(outsider,`/api/agents/employees/${employeeId}`,{action:'grant',scope:{kind:'capability',value:'send_external_message'}}),undefined);assert.equal(denied.status,403);
   const response=await graphRoute(request(outsider,'/api/setup/workspace-graph'),undefined);assert.equal(response.status,200);const graph=await response.json();assert.equal(graph.canManage,false);assert.ok(!JSON.stringify(graph).includes('Ciphertext'));
  }finally{for(const key of Object.keys(env))delete env[key];Object.assign(env,previous);}
 });
}

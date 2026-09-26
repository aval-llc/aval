import { and, eq, or } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { integrationConnections, conversations, leases } from '@/db/postgres/schema';
import { employeeScopes, getEmployee } from './employees';
import { employeeEnvelope, allowedToolNames } from './policy';
import { isPmsWriteTool } from '@/lib/pms/tool-map';
import { pmsToolAvailability } from '@/lib/pms/assembly';
import { SEND_PROVIDERS } from '@/lib/communications/providers';

const COMMUNICATION_CAPABILITIES = new Set([
 'get_communication_channels', 'list_conversations', 'read_conversation',
 'read_maintenance_context', 'create_maintenance_work_order',
 'send_external_message', 'place_call',
]);

/** Read by assembly and again before execution. Revocation is never a UI cache. */
export async function effectiveEmployeeAccess(session:DbSession,org:string,id:string) {
 const employee=await getEmployee(session,org,id);
 const scopes=await employeeScopes(session,org,id);
 const rows=await session.db.select({id:integrationConnections.id,provider:integrationConnections.provider,status:integrationConnections.status}).from(integrationConnections).where(eq(integrationConnections.organizationId,org));
 const connections=rows.filter(c=>c.status==='connected'&&scopes.connection?.includes(c.id));
 const permissions=employeeEnvelope(scopes.capability??[],{mayCommunicateExternally:employee?.mayCommunicateExternally??false});
 const allowed=new Set(allowedToolNames('general',{isGuest:false},permissions));
 const pms=await pmsToolAvailability(session,org);
 const capabilities=(employee?.status==='active'?scopes.capability??[]:[]).filter(name=>{
  if(!allowed.has(name))return false;
  if(COMMUNICATION_CAPABILITIES.has(name)&&!connections.some(c=>(SEND_PROVIDERS as readonly string[]).includes(c.provider)))return false;
  if(name==='send_external_message')return connections.some(c=>(SEND_PROVIDERS as readonly string[]).includes(c.provider));
  if(name==='place_call')return connections.some(c=>c.provider==='twilio');
  if(name==='publish_listing')return connections.some(c=>c.provider==='meta');
  if(isPmsWriteTool(name))return (pms.providersByTool.get(name)??[]).some(provider=>connections.some(c=>c.provider===provider));
  return true;
 });
 return {employee,scopes,connections,permissions,capabilities};
}
export async function employeeExecutionRefusal(session:DbSession,org:string,id:string,tool:string,args:Record<string,unknown>) {
 const access=await effectiveEmployeeAccess(session,org,id);
 if(!access.employee||access.employee.status!=='active')return 'This employee is not active. Its work is retained until it can continue.';
 if(!access.capabilities.includes(tool))return 'This employee no longer has effective access to this capability. Update its access in Setup.';
 let provider=typeof args.provider==='string'?args.provider:null;
 if(typeof args.conversation_id==='string') {
  const [conversation]=await session.db.select({provider:conversations.channel}).from(conversations).where(and(eq(conversations.organizationId,org),eq(conversations.id,args.conversation_id))).limit(1);
  provider=conversation?.provider??null;
 }
 if(tool==='place_call')provider='twilio';
 if(provider&&!access.connections.some(c=>c.provider===provider))return 'This connection is not assigned to the employee or is no longer connected.';
 let property=typeof args.property_id==='string'?args.property_id:typeof args.propertyId==='string'?args.propertyId:null;
 // A ledger write names a lease, not a property. The lease's property is what
 // the employee's resource scope is checked against.
 if(!property&&typeof args.lease_id==='string'&&access.scopes.property?.length){
  const [lease]=await session.db.select({propertyId:leases.propertyId}).from(leases).where(and(eq(leases.organizationId,org),or(eq(leases.id,args.lease_id),eq(leases.externalId,args.lease_id)))).limit(1);
  if(!lease)return 'This lease is not a record of this workspace.';
  property=lease.propertyId;
 }
 if(property&&access.scopes.property?.length&&!access.scopes.property.includes(property))return 'This property is outside the employee’s granted resource scope.';
 return null;
}

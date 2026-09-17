import type { DbSession } from "@/db/postgres/session";
import { getTask } from './tasks';
import { getTool } from './registry';
import { hasPermission, roleForPersona } from './permissions';
import { MAX_DELEGATION_DEPTH } from './policy';
export function inboundToolAllowed(scope: { conversationId?: string; messageId?: string; maintenance?: { residentId: string; propertyId: string; unitId: string } }, name: string, args: Record<string, unknown>) {
  if (name === 'request_execution_plan') return false;
  if (args.conversation_id !== scope.conversationId) return false;
  if (name === 'read_conversation') return true;
  if (name === 'send_external_message') return args.to === undefined && args.provider === undefined && (!scope.messageId || args.message_id === scope.messageId);
  if (!scope.maintenance || args.message_id !== scope.messageId) return false;
  if (name === 'read_maintenance_context') return true;
  return name === 'create_maintenance_work_order' && args.resident_id === scope.maintenance.residentId && args.property_id === scope.maintenance.propertyId && args.unit_id === scope.maintenance.unitId;
}
/** Re-read every ancestor: delegation never restores revoked authority or inbound scope. */
export async function taskBoundary(dbSession: DbSession, org:string,user:string,taskId:string,toolName:string,args:Record<string,unknown>):Promise<string|null>{
 const tool=getTool(toolName);if(!tool)return null;
 let task=await getTask(dbSession, org,taskId);const seen=new Set<string>();
 if(!task||task.userId!==user)return 'The task does not belong to this workspace and user.';
 while(task){
  if(seen.has(task.id)||seen.size>MAX_DELEGATION_DEPTH)return 'Invalid or excessive task ancestry.';
  seen.add(task.id);
  if(task.id===taskId&&JSON.parse(task.checkJson??'{}').kind==='plan'&&!['plan_goal','get_goal_plan','read_memory','write_memory','read_task_history'].includes(toolName))return 'A root planner only manages its plan; operational work belongs in checked child tasks.';
  if(['FAILED','COMPLETED','CANCELLED'].includes(task.status))return 'The task or its parent has stopped.';
  if(Date.now()>=(task.deadlineAt?.getTime()??task.createdAt.getTime()+30*60_000))return 'The task or its parent reached its wall-clock limit.';
  if(task.cancelRequested)return 'The task or its parent was cancelled.';
  if(!hasPermission(roleForPersona(task.agentId),tool.requiredPermission))return 'The task ancestry does not grant this tool permission.';
  const scope=JSON.parse(task.executionScopeJson);
  if(scope.source==='inbound'){
   if(!inboundToolAllowed(scope,toolName,args))return 'Inbound tasks are limited to their originating message and approved matched maintenance request.';
  }
  if(!task.parentTaskId)break;
  task=await getTask(dbSession, org,task.parentTaskId);
  if(!task||task.userId!==user)return 'The parent task is unavailable.';
 }
 return null;
}

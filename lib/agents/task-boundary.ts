import type { DbSession } from "@/db/postgres/session";
import { getTask, type TaskRecord } from './tasks';
import { getTool } from './registry';
import type { Permission } from './permissions';
import { MAX_DELEGATION_DEPTH } from './delegation-policy';
import { actorHolds, actorOrchestrates, isOrchestrator } from './organization/index.ts';
import { employeeEnvelope } from './policy';
import { employeeScopes, getEmployee } from './employees';
export function inboundToolAllowed(scope: { conversationId?: string; messageId?: string; maintenance?: { residentId: string; propertyId: string; unitId: string } }, name: string, args: Record<string, unknown>) {
  if (name === 'request_execution_plan') return false;
  if (args.conversation_id !== scope.conversationId) return false;
  if (name === 'read_conversation') return true;
  if (name === 'send_external_message') return args.to === undefined && args.provider === undefined && (!scope.messageId || args.message_id === scope.messageId);
  if (!scope.maintenance || args.message_id !== scope.messageId) return false;
  if (name === 'read_maintenance_context') return true;
  return name === 'create_maintenance_work_order' && args.resident_id === scope.maintenance.residentId && args.property_id === scope.maintenance.propertyId && args.unit_id === scope.maintenance.unitId;
}

/**
 * The authority one task in a chain brings to a permission check.
 *
 * Work with no owner is governed by its actor's envelope, exactly as before
 * employees existed. Work an employee owns is capped by that employee's grant:
 *
 *   - Aval One acting for an employee *is* the employee. It has no envelope of
 *     its own to add, so it neither caps the employee at Aval One's reads nor
 *     lends the employee anything Aval One holds.
 *   - A Lead or Specialist working for an employee is the intersection of the
 *     two. The employee's grant is the ceiling; the built-in actor narrows it
 *     to its own job.
 *
 * An employee's grant is a set of tools, so it is something the employee
 * exercises. It is never something the employee routes without holding.
 */
async function authorityOf(dbSession: DbSession, org: string, task: TaskRecord, cache: Map<string, readonly Permission[] | null>) {
  let employee: readonly Permission[] | null = null;
  if (task.employeeId) {
    if (!cache.has(task.employeeId)) {
      const owner = await getEmployee(dbSession, org, task.employeeId);
      const scopes = owner?.status === 'active' ? await employeeScopes(dbSession, org, owner.id) : null;
      cache.set(task.employeeId, owner && scopes ? employeeEnvelope(scopes.capability ?? [], { mayCommunicateExternally: owner.mayCommunicateExternally }) : []);
    }
    employee = cache.get(task.employeeId) ?? [];
  }
  const employeeHolds = (permission: Permission) => permission === 'tasks.manage' || (employee?.includes(permission) ?? false);
  if (employee && isOrchestrator(task.agentId)) {
    return { holds: employeeHolds, routes: () => false };
  }
  return {
    holds: (permission: Permission) => actorHolds(task.agentId, permission) && (!employee || employeeHolds(permission)),
    routes: (permission: Permission) => actorOrchestrates(task.agentId, permission) && (!employee || employeeHolds(permission)),
  };
}

/** Re-read every ancestor: delegation never restores revoked authority or inbound scope. */
export async function taskBoundary(dbSession: DbSession, org:string,user:string,taskId:string,toolName:string,args:Record<string,unknown>):Promise<string|null>{
 const tool=getTool(toolName);if(!tool)return null;
 let task=await getTask(dbSession, org,taskId);const seen=new Set<string>();
 const employees=new Map<string, readonly Permission[] | null>();
 if(!task||task.userId!==user)return 'The task does not belong to this workspace and user.';
 while(task){
  if(seen.has(task.id)||seen.size>MAX_DELEGATION_DEPTH)return 'Invalid or excessive task ancestry.';
  seen.add(task.id);
  if(task.id===taskId&&JSON.parse(task.checkJson??'{}').kind==='plan'&&!['plan_goal','get_goal_plan','read_memory','write_memory','read_task_history'].includes(toolName))return 'A planner only manages its plan; operational work belongs in checked child tasks.';
  if(['FAILED','COMPLETED','CANCELLED','SUPERSEDED'].includes(task.status))return 'The task or its parent has stopped.';
  if(Date.now()>=(task.deadlineAt?.getTime()??task.createdAt.getTime()+30*60_000))return 'The task or its parent reached its wall-clock limit.';
  if(task.cancelRequested)return 'The task or its parent was cancelled.';
  // The executing task must hold the permission. An ancestor may instead be
  // allowed to route it — see the organization's `orchestrates`. A coordinator
  // that calls the tool itself is still the executing task, so it is still
  // refused.
  const authority=await authorityOf(dbSession, org, task, employees);
  if(!authority.holds(tool.requiredPermission)
     &&!(task.id!==taskId&&authority.routes(tool.requiredPermission)))
   return 'The task ancestry does not grant this tool permission.';
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

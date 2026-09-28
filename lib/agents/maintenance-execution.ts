import { and, eq } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { agentApprovals, agentTasks, agentTaskSteps, workOrders } from '@/db/postgres/schema';
import { payloadHash } from './canonical-payload';
import { appendStep, getTask } from './tasks';
import { maintenanceOutcome } from './maintenance-receipt';

export interface MaintenanceExecutionReceipt {
  version: 1;
  organizationId: string;
  taskId: string;
  executionId: string;
  effect: 'created' | 'observed_existing';
  conversationId: string;
  messageId: string;
  residentId: string;
  actionDigest: string;
  approval: { id: string; decidedBy: string; decidedAt: string; policyVersion: number };
  order: { id: string; propertyId: string; unitId: string | null; leaseId: string | null; summary: string; priority: string; status: string };
  executedAt: string;
}

/** Called inside the SAME savepoint as the internal insert. Never from model arguments. */
export async function recordMaintenanceExecution(session: DbSession, org: string, task: {id: string; stepIndex: number; approvalId?: string}, key: string, args: Record<string, unknown>, result: unknown) {
  const id = (result as {workOrderId?: unknown})?.workOrderId;
  if (typeof id !== 'string' || !task.approvalId) throw Error('Maintenance execution requires an approved persisted result');
  const [approval] = await session.db.select().from(agentApprovals).where(and(eq(agentApprovals.organizationId, org), eq(agentApprovals.taskId, task.id), eq(agentApprovals.id, task.approvalId)));
  const digest = await payloadHash(args);
  if (!approval || approval.toolName !== 'create_maintenance_work_order' || approval.stepIndex !== task.stepIndex || approval.status !== 'approved' || !approval.decidedAt || !approval.decidedByUserId || approval.approvalsReceived < approval.requiredApprovals || JSON.parse(approval.evidenceJson).payloadHash !== digest) throw Error('Maintenance execution approval does not match');
  const [order] = await session.db.select().from(workOrders).where(and(eq(workOrders.organizationId, org), eq(workOrders.id, id)));
  if (!order || order.propertyId !== args.property_id || order.unitId !== args.unit_id || order.summary !== args.summary || order.priority !== args.priority) throw Error('Maintenance execution result does not match');
  const receipt: MaintenanceExecutionReceipt = {
    version: 1, organizationId: org, taskId: task.id, executionId: key, effect: (result as {duplicate?: boolean}).duplicate ? 'observed_existing' : 'created',
    conversationId: String(args.conversation_id), messageId: String(args.message_id), residentId: String(args.resident_id), actionDigest: digest,
    approval: { id: approval.id, decidedBy: approval.decidedByUserId, decidedAt: approval.decidedAt.toISOString(), policyVersion: approval.policyVersion },
    order: { id: order.id, propertyId: order.propertyId, unitId: order.unitId, leaseId: order.leaseId, summary: order.summary, priority: order.priority, status: order.status }, executedAt: new Date().toISOString(),
  };
  const [reservation] = await session.db.select({id:agentTaskSteps.id}).from(agentTaskSteps).where(and(eq(agentTaskSteps.organizationId, org), eq(agentTaskSteps.taskId, task.id), eq(agentTaskSteps.idempotencyKey, key), eq(agentTaskSteps.kind, 'mutation_reserved')));
  if (!reservation || !await appendStep(session, {taskId:task.id, organizationId:org, stepIndex:task.stepIndex, kind:'maintenance_execution', toolName:'create_maintenance_work_order', policyEffect:'allow', idempotencyKey:`${key}:receipt`, executionReceiptJson:JSON.stringify(receipt)})) throw Error('Maintenance execution reservation unavailable');
  if (receipt.effect === 'created' && order.priority === 'emergency') {
    const current = await getTask(session,org,task.id);
    if (!current) throw Error('Maintenance task unavailable');
    const outcome = await maintenanceOutcome(session,current,JSON.parse(current.transcriptJson),'WAITING_FOR_HUMAN','emergency_review');
    // Owned urgency becomes visible in the creation transaction, even if the
    // worker stops before its next task-state checkpoint. No dispatch implied.
    await session.db.update(agentTasks).set({maintenanceOutcomeJson:JSON.stringify(outcome)}).where(and(eq(agentTasks.id,task.id),eq(agentTasks.organizationId,org)));
  }
}

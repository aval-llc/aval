import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { agentApprovals, agentTaskSteps, communicationDeliveries, organizationMembers, organizations, workOrders } from '@/db/postgres/schema';
import type { Message, ToolUseBlock } from '@/lib/ask-aval/model-types';
import type { TaskRecord } from './tasks';
import { maintenanceContext } from '@/lib/communications/maintenance-intake';
import { digestPayload } from '@/lib/audit/chain';
import { approvalMatchesToolUse } from './approval-binding';

export interface MaintenanceOutcome {
  version: 1;
  actionState: 'not_started' | 'awaiting_approval' | 'declined' | 'executed' | 'unknown';
  verificationState: 'pending' | 'verified' | 'review_required';
  workOrderId: string | null;
  reasonCode: string | null;
  ownerUserId: string | null;
  reviewAt: string | null;
}

/** RLS-scoped stored facts, never a model's assertion of authority or success. */
export async function maintenanceReceipt(session: DbSession, task: TaskRecord, transcript: Message[]) {
  const check = JSON.parse(task.checkJson ?? '{}');
  if (check.kind !== 'internal_maintenance') return null;
  const context = await maintenanceContext(session, task.organizationId, check.conversationId, check.messageId);
  const scope = JSON.parse(task.executionScopeJson);
  const identityUnchanged = !!context.match && ['residentId', 'propertyId', 'unitId', 'leaseId'].every(k => (context.match as unknown as Record<string, unknown>)[k] === scope.maintenance?.[k]);
  const externalId = `inbound_${await digestPayload({ org: task.organizationId, conversationId: check.conversationId, messageId: check.messageId })}`;
  const orders = await session.db.select().from(workOrders).where(and(eq(workOrders.organizationId, task.organizationId), eq(workOrders.sourceProvider, 'manual'), eq(workOrders.externalId, externalId)));
  const approvals = await session.db.select().from(agentApprovals).where(and(eq(agentApprovals.organizationId, task.organizationId), eq(agentApprovals.taskId, task.id), eq(agentApprovals.toolName, 'create_maintenance_work_order'))).orderBy(desc(agentApprovals.stepIndex));
  const calls = transcript.flatMap(m => m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use') : []);
  const steps = await session.db.select().from(agentTaskSteps).where(and(eq(agentTaskSteps.organizationId, task.organizationId), eq(agentTaskSteps.taskId, task.id)));
  const approval = approvals[0];
  let proposal: ToolUseBlock | undefined;
  if (approval) for (const call of calls) if (await approvalMatchesToolUse(approval.evidenceJson, call, approval.toolName)) { proposal = call; break; }
  const bound = !!proposal && identityUnchanged && proposal.input.property_id === context.match?.propertyId && proposal.input.unit_id === context.match?.unitId && proposal.input.resident_id === context.match?.residentId && proposal.input.message_id === check.messageId && proposal.input.conversation_id === check.conversationId;
  const order = orders.length === 1 ? orders[0] : undefined;
  const reservation = approval && steps.find(s => s.kind === 'mutation_reserved' && s.stepIndex === approval.stepIndex && s.toolName === approval.toolName && s.policyEffect === 'allow' && !s.error);
  const execution = approval && steps.find(s => s.kind === 'approval_decided' && s.stepIndex === approval.stepIndex && s.toolName === approval.toolName && s.policyEffect === 'allow' && !s.error);
  const verified = !!(bound && approval?.status === 'approved' && approval.decidedByUserId && approval.decidedAt && approval.approvalsReceived >= approval.requiredApprovals && reservation && execution && order &&
    order.propertyId === context.match?.propertyId && order.unitId === context.match?.unitId && order.leaseId === context.match?.leaseId && order.summary === proposal?.input.summary && order.priority === proposal?.input.priority);
  const deliveries = await session.db.select({ id: communicationDeliveries.id }).from(communicationDeliveries).where(and(eq(communicationDeliveries.organizationId, task.organizationId), sql`substr(${communicationDeliveries.requestKey},1,${task.id.length + 1})=${task.id + ':'}`));
  const outboundAttempts = steps.filter(s => ['send_external_message', 'place_call', 'publish_listing'].includes(s.toolName ?? '') && ['mutation_reserved', 'tool_call', 'approval_decided'].includes(s.kind) && s.policyEffect === 'allow');
  const evidenceRevision = await digestPayload({ context, approvals, orders, steps: steps.map(s => ({ id: s.id, kind: s.kind, error: s.error, resultDigest: s.resultDigest })), deliveries });
  return {
    version: 1, taskId: task.id, conversationId: check.conversationId, messageId: check.messageId,
    evidenceRevision,
    identityUnchanged, match: context.match,
    approval: bound ? { id: approval.id, decision: approval.status, approver: approval.decidedByUserId, decidedAt: approval.decidedAt, policyVersion: approval.policyVersion, policyDecision: execution?.policyEffect ?? null, actionDigest: JSON.parse(approval.evidenceJson).payloadHash } : null,
    execution: { verified, executionId: reservation?.idempotencyKey ?? null, workOrderId: order?.id ?? null, workOrderStatus: order?.status ?? null, priority: order?.priority ?? null, recordCount: orders.length, executedAt: execution?.createdAt ?? null },
    communication: { draftOnly: scope.draftOnly === true, deliveryCount: deliveries.length, outboundAttemptCount: outboundAttempts.length, taskSentNoMessage: scope.draftOnly === true && deliveries.length === 0 && outboundAttempts.length === 0 },
  };
}

export async function maintenanceOutcome(session: DbSession, task: TaskRecord, transcript: Message[], state: string, reasonCode: string | null): Promise<MaintenanceOutcome | null> {
  const receipt = await maintenanceReceipt(session, task, transcript);
  if (!receipt) return null;
  const review = state === 'WAITING_FOR_HUMAN';
  let ownerUserId: string | null = null;
  if (review) {
    const [member] = await session.db.select({ userId: organizationMembers.userId }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, task.organizationId), eq(organizationMembers.userId, task.userId)));
    const [org] = await session.db.select({ owner: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, task.organizationId));
    ownerUserId = member?.userId ?? org?.owner ?? null;
  }
  return { version: 1, actionState: receipt.execution.verified ? 'executed' : receipt.execution.workOrderId ? 'unknown' : ['rejected', 'expired'].includes(receipt.approval?.decision ?? '') ? 'declined' : receipt.approval?.decision === 'pending' ? 'awaiting_approval' : 'not_started',
    verificationState: state === 'COMPLETED' ? 'verified' : review ? 'review_required' : 'pending', workOrderId: receipt.execution.workOrderId, reasonCode, ownerUserId, reviewAt: review ? new Date().toISOString() : null };
}

import type { Message } from '@/lib/ask-aval/model-types';
import type { DbSession } from '@/db/postgres/session';
import { sql } from 'drizzle-orm';
import { maintenanceContext } from '@/lib/communications/maintenance-intake';

/** Only tool observations carry evidence revisions; actor text cannot mint one. */
export function observedMaintenanceRevision(messages: Message[]): string | null {
  const reads = new Set<string>();
  let revision: string | null = null;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use' && block.name === 'read_maintenance_context') reads.add(block.id);
      if (message.role === 'user' && block.type === 'tool_result' && reads.has(block.tool_use_id) && !block.is_error && typeof block.content === 'string') {
        try { const data = JSON.parse(block.content); if (typeof data.evidenceRevision === 'string') revision = data.evidenceRevision; } catch { /* invalid observation is not authority */ }
      }
    }
  }
  return revision;
}

export async function assertMaintenanceApprovalFresh(session: DbSession, org: string, taskId: string, approvalId: string | undefined, args: Record<string, unknown>) {
  if (!approvalId) throw new Error('Maintenance requires a bound approval');
  // The inbound-message trigger takes the same lock before inserting/editing.
  // Policy and resident/lease reads below occur in this same effect transaction.
  await session.db.execute(sql`select id from conversations where organization_id=${org} and id=${String(args.conversation_id)} for update`);
  await session.db.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`aval:maintenance-policy:${org}`},0))`);
  await session.db.execute(sql`select r.id from residents r join lease_residents lr on lr.resident_id=r.id and lr.organization_id=r.organization_id
    join leases l on l.id=lr.lease_id and l.organization_id=r.organization_id
    where r.organization_id=${org} and l.unit_id=${String(args.unit_id)} for share of r,lr,l`);
  const approval = await session.db.execute<{ evidence_json: { maintenanceEvidenceRevision?: string } }>(sql`
    select evidence_json from agent_approvals where organization_id=${org} and task_id=${taskId} and id=${approvalId}
      and status='approved' for share
  `);
  const expected = approval.rows[0]?.evidence_json.maintenanceEvidenceRevision;
  const current = await maintenanceContext(session, org, String(args.conversation_id), String(args.message_id));
  if (!expected || expected !== current.evidenceRevision) throw new Error('Maintenance evidence changed after the proposal. Nothing was created; human review and a fresh approval are required.');
}

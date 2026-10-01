import { eq, sql } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { organizations } from '@/db/postgres/schema';
import { runtimeBindings } from '@/lib/runtime/bindings';

export class AgentsPausedError extends Error {
  constructor() { super('Agent execution is paused. Inbound messages remain saved for review.'); }
}

/** A transaction-scoped advisory lock orders a local effect against an owner pause.
 * It is released before network calls; an already-started provider call cannot
 * be revoked. Every subsequent action must check again.
 */
export async function agentsPaused(session: DbSession, organizationId: string): Promise<boolean> {
  if (['true', '1'].includes(String(runtimeBindings().AVAL_AGENTS_PAUSED).toLowerCase())) return true;
  await session.db.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`aval:pause:${organizationId}`}, 0))`);
  const result = await session.db.execute<{ agents_paused: boolean }>(sql`
    select agents_paused from ${organizations} where ${organizations.id} = ${organizationId}
  `);
  return result.rows[0]?.agents_paused !== false;
}

export async function setAgentsPaused(session: DbSession, organizationId: string, paused: boolean) {
  await session.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`aval:pause:${organizationId}`}, 0))`);
  const rows = await session.db.update(organizations).set({ agentsPaused: paused, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId)).returning({ id: organizations.id });
  if (rows.length !== 1) throw new Error('Workspace owner access required');
}

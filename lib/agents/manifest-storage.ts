import type { DbSession } from '@/db/postgres/session';
import { sql } from 'drizzle-orm';
import { executionManifest } from './execution-manifest';
import { agentModelContexts } from '@/db/postgres/schema';
import { payloadHash } from './canonical-payload';

/** RLS-visible state only. Stored as hashes, never sent as policy/person data. */
export async function taskManifest(session: DbSession, organizationId: string, taskId: string,
  input: Parameters<typeof executionManifest>[0]) {
  const result = await session.db.execute(sql`
    SELECT t.step_count, t.execution_scope_json AS scope,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)::text) FROM agent_execution_policies p WHERE p.organization_id=t.organization_id) AS financial,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM access_grants g WHERE g.organization_id=t.organization_id) AS grants,
      (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.user_id) FROM user_onboarding u WHERE u.organization_id=t.organization_id AND u.user_id=t.user_id) AS onboarding,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM ai_employees e WHERE e.organization_id=t.organization_id AND e.id=t.employee_id) AS employee,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM ai_employee_scopes e WHERE e.organization_id=t.organization_id AND e.employee_id=t.employee_id) AS employee_scopes,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM pms_write_authorizations p WHERE p.organization_id=t.organization_id) AS pms,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.organization_id) FROM communication_settings c WHERE c.organization_id=t.organization_id) AS communications,
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM agent_memory m WHERE m.organization_id=t.organization_id AND m.task_id=t.id) AS memory
    FROM agent_tasks t WHERE t.organization_id=${organizationId} AND t.id=${taskId}`);
  const row = result.rows[0];
  if (!row) throw new Error('Cannot snapshot a task outside the current workspace');
  const { memory, step_count: stepIndex, ...policy } = row;
  // Preserve the actual snapshot privately: a hash alone cannot explain an old policy.
  const contextJson = JSON.stringify({ kind: 'execution_manifest_snapshot', phase: input.phase, policy, memory: memory ?? [] });
  await session.db.insert(agentModelContexts).values({ id: crypto.randomUUID(), organizationId, taskId,
    stepIndex: Number(stepIndex), contextJson, digest: await payloadHash(JSON.parse(contextJson)), createdAt: new Date() });
  return executionManifest({ ...input, policy, memory: memory ?? [] });
}

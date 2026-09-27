import type { AvalRuntimeBindings } from '@/lib/runtime/bindings';
import { withWorkerOrganizationSession } from '@/lib/api/with-session';
import { sql } from 'drizzle-orm';
import { insertBraintrustEvents, traceEvent, type TraceExportRow } from './braintrust';

/** Independent journal consumer. No external IO in the case transaction. */
export async function exportBraintrustTraces(bindings: AvalRuntimeBindings) {
  if (!bindings.BRAINTRUST_API_KEY || !bindings.BRAINTRUST_TRACE_ROUTES) return;
  const routes: unknown = JSON.parse(bindings.BRAINTRUST_TRACE_ROUTES);
  if (!Array.isArray(routes) || routes.length > 10) throw new Error('Invalid Braintrust trace routes');
  for (const route of routes) {
    if (!route || typeof route.organizationId !== 'string' || typeof route.projectId !== 'string' ||
      typeof route.since !== 'string' || !Number.isFinite(Date.parse(route.since))) throw new Error('Invalid trace route');
    await withWorkerOrganizationSession(route.organizationId, async session => {
      const candidates = await session.db.execute(sql`
        SELECT s.* FROM agent_task_steps s LEFT JOIN agent_trace_deliveries d
        ON d.step_id=s.id AND d.organization_id=s.organization_id AND d.project_id=${route.projectId}
        WHERE s.organization_id=${route.organizationId} AND s.created_at>=${route.since}::timestamptz
        AND d.delivered_at IS NULL AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=now())
        ORDER BY s.created_at,s.id LIMIT 50`);
      if (!candidates.rows.length) return;
      const events = candidates.rows.map(row => traceEvent(row as unknown as TraceExportRow));
      let outcome = { ok: false, status: 0 };
      try {
        outcome = await session.outsideTransaction(() => insertBraintrustEvents({
          apiKey: bindings.BRAINTRUST_API_KEY!, region: bindings.BRAINTRUST_REGION ?? '', projectId: route.projectId,
        }, events));
      } catch { /* Durable retry below; never expose transport error/secret text. */ }
      for (const event of events) await session.db.execute(sql`
        INSERT INTO agent_trace_deliveries(organization_id,step_id,project_id,attempts,next_attempt_at,delivered_at,last_status)
        VALUES(${route.organizationId},${event.id},${route.projectId},1,now()+interval '1 minute',
          CASE WHEN ${outcome.ok} THEN now() ELSE NULL END,${outcome.status})
        ON CONFLICT(organization_id,step_id,project_id) DO UPDATE SET
          attempts=agent_trace_deliveries.attempts+1,
          next_attempt_at=now()+least(3600,power(2,least(agent_trace_deliveries.attempts,6))*60)*interval '1 second',
          delivered_at=coalesce(agent_trace_deliveries.delivered_at,EXCLUDED.delivered_at),last_status=EXCLUDED.last_status`);
      console.log(JSON.stringify({ event: 'braintrust_delivery', count: events.length, ok: outcome.ok, status: outcome.status }));
    }, bindings);
  }
}

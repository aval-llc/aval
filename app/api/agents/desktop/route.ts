import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity } from '@/lib/integrations/session';
import { desktopQuery as query, validateDesktopResponse } from '@/lib/agents/desktop-inference';
import { readJsonBody } from '@/lib/operations/validation';
import { withWorkerOrganizationSession } from '@/lib/api/with-session';
import { runAgentWorkerBatch } from '@/lib/agents/worker';
import { runtimeBindings } from '@/lib/runtime/bindings';
import { getRequestExecutionContext } from 'vinext/shims/request-context';

export const GET = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status: 403 });
  const rows = await query(session, 'SELECT model,enabled,heartbeat_at,tokens_used,tokens_reserved,token_limit FROM desktop_model_runners WHERE organization_id=$1', [identity.organizationId]);
  return Response.json({ organizationId: identity.organizationId, runner: rows.rows[0] ?? null }, { headers: { 'cache-control': 'no-store' } });
});

export const POST = withApiSession(async (session, request) => {
  const identity = await getApiIdentity(session, request);
  if (!identity || identity.role !== 'owner') return Response.json({ error: 'Owner access required' }, { status: 403 });
  try {
    const body = await readJsonBody(request);
    const org = identity.organizationId;
    if (body.organizationId !== org) return Response.json({ error: 'Workspace changed; reconnect Desktop' }, { status: 409 });
    const runnerId = typeof body.runnerId === 'string' && /^[a-zA-Z0-9_-]{10,100}$/.test(body.runnerId) ? body.runnerId : null;
    if (!runnerId) return Response.json({ error: 'Invalid runner' }, { status: 400 });
    if (body.action === 'register') {
      if (typeof body.model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(body.model)) throw new Error('Select a model');
      await query(session, `INSERT INTO desktop_model_runners(organization_id,user_id,runner_id,model) VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id) DO UPDATE SET user_id=$2,runner_id=$3,model=$4,enabled=true,heartbeat_at=now()`, [org, identity.userId, runnerId, body.model]);
      await query(session, `UPDATE organizations SET active_model_provider='desktop_codex',updated_at=now() WHERE id=$1`, [org]);
      return Response.json({ connected: true, organizationId: org });
    }
    const runner = (await query(session, `SELECT * FROM desktop_model_runners WHERE organization_id=$1 AND user_id=$2 AND runner_id=$3 FOR UPDATE`, [org, identity.userId, runnerId])).rows[0];
    if (!runner) return Response.json({ error: 'Desktop runner disconnected' }, { status: 409 });
    await query(session, 'UPDATE desktop_model_runners SET heartbeat_at=now() WHERE organization_id=$1', [org]);
    if (body.action === 'claim') {
      if (!runner.enabled) return Response.json({ error:'Desktop runner paused' },{status:409});
      // One in-flight inference per workspace bounds spend and response ordering.
      const busy = await query(session, `SELECT id FROM desktop_model_jobs WHERE organization_id=$1 AND status='claimed' AND lease_until>now() LIMIT 1`, [org]);
      if (busy.rows.length) return Response.json({ job: null });
      const candidates = await query(session, `SELECT j.* FROM desktop_model_jobs j JOIN agent_tasks t ON t.id=j.task_id AND t.organization_id=j.organization_id
        WHERE j.organization_id=$1 AND (j.status='pending' OR (j.status='claimed' AND j.lease_until<=now()))
        AND t.status='WAITING_FOR_MODEL' AND t.cancel_requested=false ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [org]);
      const job = candidates.rows[0];
      if (!job) return Response.json({ job: null });
      // Reserve a conservative upper bound before starting another model call.
      const request = job.request_json as {tool_choice?:{name?:string}};
      const allowance = Math.max(request.tool_choice?.name==='semantic_verdict'?64000:128000, new TextEncoder().encode(JSON.stringify(job.request_json)).length + 32768);
      if (Number(runner.tokens_used) + Number(runner.tokens_reserved) + allowance > Number(runner.token_limit)) return Response.json({ error: 'Evaluation token cap reached; work remains incomplete', code: 'budget_exhausted' }, { status: 429 });
      const claim = crypto.randomUUID();
      // An abandoned claim keeps its reservation: an unknown billed attempt is never free.
      await query(session,'UPDATE desktop_model_runners SET tokens_reserved=tokens_reserved+$2 WHERE organization_id=$1',[org,allowance]);
      await query(session, `UPDATE desktop_model_jobs SET status='claimed',runner_id=$2,claim_token=$3,lease_until=now()+interval '2 minutes',model=$4,reserved_tokens=$5,error=NULL WHERE id=$1`, [job.id, runnerId, claim,runner.model,allowance]);
      return Response.json({ job: { id: job.id, taskId: job.task_id, claimToken: claim, params: job.request_json, model: runner.model } });
    }
    if (body.action === 'complete') {
      const job = (await query(session, 'SELECT * FROM desktop_model_jobs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [body.jobId, org])).rows[0];
      if (!job || job.runner_id !== runnerId || job.claim_token !== body.claimToken) return Response.json({ error: 'Stale inference claim' }, { status: 409 });
      if (job.status === 'completed') return Response.json({ accepted: true, replay: true });
      if (job.status !== 'claimed' || new Date(String(job.lease_until)).getTime() <= Date.now()) return Response.json({ error: 'Inference claim expired' }, { status: 409 });
      const response = validateDesktopResponse(body.response, job.request_json as Parameters<typeof validateDesktopResponse>[1], String(job.model));
      // Never accept client-supplied provenance; retain the queued server snapshot.
      if (job.execution_manifest_json) response.executionManifest = { ...job.execution_manifest_json as NonNullable<typeof response.executionManifest>, model: String(job.model), model_provider: 'desktop_codex', ...response.usage };
      const task = (await query(session, 'SELECT status,cancel_requested FROM agent_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE', [job.task_id, org])).rows[0];
      const cancelled = !task || task.cancel_requested || task.status !== 'WAITING_FOR_MODEL';
      await query(session, `UPDATE desktop_model_jobs SET status=$2,response_json=$3,completed_at=now(),lease_until=NULL WHERE id=$1`, [job.id, cancelled ? 'cancelled' : 'completed', JSON.stringify(response)]);
      await query(session, 'UPDATE desktop_model_runners SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3 WHERE organization_id=$1', [org, response.usage.input_tokens + response.usage.output_tokens,job.reserved_tokens]);
      if (!cancelled) {
        await query(session, `UPDATE agent_tasks SET status='QUEUED',next_attempt_at=NULL,
          deadline_at=CASE WHEN deadline_at>=$3::timestamptz THEN deadline_at+(now()-$3::timestamptz) ELSE deadline_at END,
          updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='WAITING_FOR_MODEL' AND cancel_requested=false`, [job.task_id, org,job.created_at]);
        const work = session.afterCommit(() => withWorkerOrganizationSession(org, worker => runAgentWorkerBatch(worker, runtimeBindings(), 'request')));
        getRequestExecutionContext()?.waitUntil(work);
      }
      return Response.json({ accepted: !cancelled, taskId: job.task_id });
    }
    if (body.action === 'pause') {
      await query(session, 'UPDATE desktop_model_runners SET enabled=false WHERE organization_id=$1', [org]);
      return Response.json({ paused: true });
    }
    return Response.json({ error: 'Unknown runner operation' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Desktop request failed' }, { status: 400 });
  }
});

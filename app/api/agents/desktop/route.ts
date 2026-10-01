import { withApiSession } from '@/lib/api/with-session';
import { getApiIdentity } from '@/lib/integrations/session';
import { desktopQuery as query, validateDesktopResponse, sanitizeInferenceDiagnostics, measuredFailureUsage } from '@/lib/agents/desktop-inference';
import { getTask } from '@/lib/agents/tasks';
import { maintenanceOutcome } from '@/lib/agents/maintenance-receipt';
import { maintenanceAdmission, estimateInputTokens } from '@/lib/agents/inference-budget';
import { readJsonBody } from '@/lib/operations/validation';
import { withWorkerOrganizationSession } from '@/lib/api/with-session';
import { runTaskInBackground } from '@/lib/agents/worker';
import { runtimeBindings } from '@/lib/runtime/bindings';
import { agentsPaused } from '@/lib/agents/pause';
import { getRequestExecutionContext } from 'vinext/shims/request-context';

/** A runner's token allowance is per day, not for its life. */
const ALLOWANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
      await query(session, 'UPDATE desktop_model_runners SET protocol_version=$2 WHERE organization_id=$1', [org, body.protocolVersion === 3 ? 3 : body.protocolVersion === 2 ? 2 : 1]);
      return Response.json({ connected: true, organizationId: org });
    }
    const runner = (await query(session, `SELECT * FROM desktop_model_runners WHERE organization_id=$1 AND user_id=$2 AND runner_id=$3 FOR UPDATE`, [org, identity.userId, runnerId])).rows[0];
    if (!runner) return Response.json({ error: 'Desktop runner disconnected' }, { status: 409 });
    await query(session, 'UPDATE desktop_model_runners SET heartbeat_at=now() WHERE organization_id=$1', [org]);
    if (body.action === 'claim') {
      if (await agentsPaused(session, org)) return Response.json({ job: null, paused: true });
      if (!runner.enabled) return Response.json({ error:'Desktop runner paused' },{status:409});
      // The allowance is per day (20260928000200_desktop_runner_daily_allowance.sql).
      // A new window keeps only the reservations of claims that are still live.
      if (new Date(String(runner.window_started_at)).getTime() <= Date.now() - ALLOWANCE_WINDOW_MS) {
        await query(session, `UPDATE desktop_model_runners SET tokens_used=0,window_started_at=now(),
          tokens_reserved=COALESCE((SELECT sum(reserved_tokens) FROM desktop_model_jobs WHERE organization_id=$1 AND status='claimed' AND lease_until>now()),0)
          WHERE organization_id=$1`, [org]);
      }
      // One in-flight inference per workspace bounds spend and response ordering.
      const busy = await query(session, `SELECT id FROM desktop_model_jobs WHERE organization_id=$1 AND status='claimed' AND lease_until>now() LIMIT 1`, [org]);
      if (busy.rows.length) return Response.json({ job: null });
      const candidates = await query(session, `SELECT j.*,t.check_json,t.execution_scope_json,t.max_tokens,t.tokens_used AS task_tokens_used FROM desktop_model_jobs j JOIN agent_tasks t ON t.id=j.task_id AND t.organization_id=j.organization_id
        WHERE j.organization_id=$1 AND (j.status='pending' OR (j.status='claimed' AND j.lease_until<=now()))
        AND t.status='WAITING_FOR_MODEL' AND t.cancel_requested=false ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [org]);
      const job = candidates.rows[0];
      if (!job) return Response.json({ job: null });
      // An admission reservation, NOT an enforceable provider ceiling.
      const request = job.request_json as {tool_choice?:{name?:string};tools?:{name:string}[]};
      const requiredProtocol = (job.execution_scope_json as {maintenanceProtocol?:number})?.maintenanceProtocol === 3 ? 3 : 2;
      if ((job.check_json as {kind?:string})?.kind === 'internal_maintenance' && Number(runner.protocol_version) < requiredProtocol) return Response.json({ error: `Update Aval Desktop to run maintenance protocol v${requiredProtocol}`, code: 'desktop_update_required' }, { status: 426 });
      let admission = null;
      if ((job.check_json as {kind?:string})?.kind === 'internal_maintenance') {
        const measured = await query(session, `SELECT request_json,response_json FROM desktop_model_jobs WHERE organization_id=$1 AND model=$2 AND status='completed' ORDER BY completed_at DESC LIMIT 32`, [org,runner.model]);
        let actor = 0, review = 0;
        for (const row of measured.rows) {
          const response = row.response_json as {usage?:{input_tokens?:number;output_tokens?:number}};
          const actual = Number(response?.usage?.input_tokens ?? 0) + Number(response?.usage?.output_tokens ?? 0);
          if ((row.request_json as {tool_choice?:{name?:string}})?.tool_choice?.name === 'semantic_verdict') review=Math.max(review,actual);
          else actor=Math.max(actor,actual);
        }
        admission=maintenanceAdmission(Number(job.max_tokens)-Number(job.task_tokens_used),request.tool_choice?.name==='semantic_verdict',actor,review);
        if (!admission.allowed) {
          const task=await getTask(session,org,String(job.task_id));
          if(task && task.status==='WAITING_FOR_MODEL' && !task.cancelRequested) {
            const outcome=await maintenanceOutcome(session,task,JSON.parse(task.transcriptJson),'WAITING_FOR_HUMAN','inference_budget');
            await query(session, `UPDATE agent_tasks SET status='WAITING_FOR_HUMAN',maintenance_outcome_json=$3,error='Insufficient task allowance for inference and reserved verification',next_attempt_at=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='WAITING_FOR_MODEL' AND cancel_requested=false`,[task.id,org,JSON.stringify(outcome)]);
            await query(session, `UPDATE desktop_model_jobs SET status='cancelled',error='Task admission budget exhausted',diagnostics_json=$2 WHERE id=$1`,[job.id,JSON.stringify({admission})]);
          }
          return Response.json({job:null,handoff:true,reason:'inference_budget'});
        }
      }
      // Re-claiming an abandoned claim: its reservation moves to what was used
      // (an unknown billed attempt is never free), instead of staying reserved
      // forever on top of the new one.
      if (job.status === 'claimed' && Number(job.reserved_tokens) > 0) {
        await query(session, 'UPDATE desktop_model_runners SET tokens_reserved=GREATEST(tokens_reserved-$2,0),tokens_used=tokens_used+$2 WHERE organization_id=$1', [org, Number(job.reserved_tokens)]);
        await query(session, 'UPDATE desktop_model_jobs SET reserved_tokens=0 WHERE id=$1', [job.id]);
      }
      const budget = (await query(session, 'SELECT tokens_used,tokens_reserved,token_limit,window_started_at FROM desktop_model_runners WHERE organization_id=$1', [org])).rows[0];
      // Reserve admission allowance, not a provider-enforced token ceiling.
      const allowance = Math.max(request.tool_choice?.name==='semantic_verdict'?64000:128000, estimateInputTokens(job.request_json) + 32768);
      if (Number(budget.tokens_used) + Number(budget.tokens_reserved) + allowance > Number(budget.token_limit)) {
        const resetsAt = new Date(new Date(String(budget.window_started_at)).getTime() + ALLOWANCE_WINDOW_MS).toISOString();
        return Response.json({ error: `Today's allowance for agents on this plan is used up. It resets at ${resetsAt}; work waits until then.`, code: 'budget_exhausted', resetsAt }, { status: 429 });
      }
      const claim = crypto.randomUUID();
      await query(session, `UPDATE desktop_model_jobs SET attempt_history_json=attempt_history_json || jsonb_build_array(jsonb_build_object('claimToken',$2::text,'reservedTokens',$3::bigint,'startedAt',now(),'usageStatus','unknown')) WHERE id=$1`, [job.id,claim,allowance]);
      // The prior unknown attempt stays in history and is conservatively charged
      // to this daily window above; reserve the new attempt separately.
      await query(session,'UPDATE desktop_model_runners SET tokens_reserved=tokens_reserved+$2 WHERE organization_id=$1',[org,allowance]);
      await query(session, `UPDATE desktop_model_jobs SET status='claimed',runner_id=$2,claim_token=$3,lease_until=now()+interval '2 minutes',model=$4,reserved_tokens=$5,error=NULL,diagnostics_json=$6 WHERE id=$1`, [job.id, runnerId, claim,runner.model,allowance,JSON.stringify({admission})]);
      return Response.json({ job: { id: job.id, taskId: job.task_id, claimToken: claim, params: job.request_json, model: runner.model } });
    }
    if (body.action === 'complete' || body.action === 'report_failure') {
      const job = (await query(session, 'SELECT * FROM desktop_model_jobs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [body.jobId, org])).rows[0];
      if (!job || job.runner_id !== runnerId || job.claim_token !== body.claimToken) return Response.json({ error: 'Stale inference claim' }, { status: 409 });
      if (job.status === 'completed' || job.status === 'cancelled') return Response.json({ accepted: job.status === 'completed', replay: true });
      if (job.status !== 'claimed' || (body.action === 'complete' && new Date(String(job.lease_until)).getTime() <= Date.now())) return Response.json({ error: 'Inference claim expired' }, { status: 409 });
      if (body.action === 'report_failure') {
        const diagnostics = sanitizeInferenceDiagnostics(body.diagnostics);
        const usage = measuredFailureUsage(body.usage, diagnostics);
        const actual = usage ? usage.input_tokens + usage.output_tokens : null;
        await query(session, `UPDATE desktop_model_jobs SET status='cancelled',completed_at=now(),lease_until=NULL,diagnostics_json=$2,
          attempt_history_json=attempt_history_json || jsonb_build_array(jsonb_build_object('claimToken',$3::text,'actualTokens',$4::bigint,'completedAt',now(),'usageStatus',$5::text,'failed',true)),
          error=$6 WHERE id=$1`, [job.id, JSON.stringify({ ...job.diagnostics_json as Record<string,unknown>, ...diagnostics, usage_status: usage ? 'reported' : 'unknown', interrupted_at: new Date().toISOString(), reserved_tokens: Number(job.reserved_tokens), actual_tokens: actual }), body.claimToken,actual,usage?'reported':'unknown',usage?'Inference failed; measured usage retained':'Inference interrupted; usage reservation retained']);
        if (usage) {
          await query(session,'UPDATE desktop_model_runners SET tokens_used=tokens_used+$2,tokens_reserved=tokens_reserved-$3 WHERE organization_id=$1',[org,actual,job.reserved_tokens]);
          // No response will reach the runtime, so charge this attempt here exactly once.
          await query(session,'UPDATE agent_tasks SET tokens_used=tokens_used+$3 WHERE id=$1 AND organization_id=$2',[job.task_id,org,actual]);
        }
        const task = await getTask(session,org,String(job.task_id));
        if (task && task.status === 'WAITING_FOR_MODEL' && !task.cancelRequested) {
          const outcome = await maintenanceOutcome(session,task,JSON.parse(task.transcriptJson),'WAITING_FOR_HUMAN',usage?'inference_interrupted':'inference_usage_unknown');
          await query(session, `UPDATE agent_tasks SET status='WAITING_FOR_HUMAN',maintenance_outcome_json=$3,error=$4,next_attempt_at=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='WAITING_FOR_MODEL' AND cancel_requested=false`,[task.id,org,outcome ? JSON.stringify(outcome) : null,usage?'Inference interrupted. A human must review preserved progress.':'Inference interrupted; final usage is unknown. A human must review preserved progress.']);
        }
        await query(session, 'UPDATE desktop_model_runners SET enabled=false WHERE organization_id=$1', [org]);
        return Response.json({ accepted: true, usageStatus: usage ? 'reported' : 'unknown' });
      }
      const response = validateDesktopResponse(body.response, job.request_json as Parameters<typeof validateDesktopResponse>[1], String(job.model));
      if (Number(runner.protocol_version) >= 2 && response.diagnostics?.protocol_version !== Number(runner.protocol_version)) throw Error('Update Aval Desktop: matching inference diagnostics are required');
      const actualTokens = response.usage.input_tokens + response.usage.output_tokens;
      await query(session, `UPDATE desktop_model_jobs SET diagnostics_json=$2,attempt_history_json=attempt_history_json || jsonb_build_array(jsonb_build_object('claimToken',$3::text,'actualTokens',$4::bigint,'completedAt',now(),'usageStatus','reported')) WHERE id=$1`, [job.id, JSON.stringify({ ...job.diagnostics_json as Record<string,unknown>, ...response.diagnostics, reserved_tokens: Number(job.reserved_tokens), actual_tokens: actualTokens, reservation_exceeded: actualTokens > Number(job.reserved_tokens) }), body.claimToken, actualTokens]);
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
        const work = session.afterCommit(() => withWorkerOrganizationSession(org, worker => runTaskInBackground(worker, runtimeBindings(), org, String(job.task_id), 'request')));
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

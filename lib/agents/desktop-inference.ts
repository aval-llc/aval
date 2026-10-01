import type { DbSession } from '@/db/postgres/session';
import type { MessagesResponse } from '@/lib/ask-aval/model-types';
import { callModel } from '@/lib/ask-aval/model-router';
import { payloadHash } from './canonical-payload';
import { sql } from 'drizzle-orm';
import { taskManifest } from './manifest-storage';

/** SQL text is always a source constant; values remain bound parameters. */
export function desktopQuery(session: DbSession, text: string, values: unknown[] = []) {
  const pieces = text.split(/(\$\d+)/).map(part => /^\$\d+$/.test(part) ? sql`${values[Number(part.slice(1)) - 1]}` : sql.raw(part));
  return session.db.execute(sql.join(pieces, sql.raw('')));
}

export class DesktopInferencePending extends Error {
  constructor() { super('Waiting for Aval Desktop'); }
}
/** An invocation yield, not a model failure or an exhausted task budget. */
export class InferenceDeferred extends Error {}
export class DesktopEvidenceChanged extends Error {
  constructor() { super('Inference evidence changed. The previous attempt is retained; human review is required before spending again.'); }
}

async function requestKey(params: Parameters<typeof callModel>[3], step: number, phase: string) {
  const request = {...params}; delete request.timeout_ms;
  return `${step}:${phase}:${await payloadHash(request)}`;
}

/** Read-only lookup. A paid, completed answer does not need a new reservation. */
export async function completedTaskModel(session: DbSession, org: string, params: Parameters<typeof callModel>[3], taskId: string, step: number, phase: string): Promise<MessagesResponse | null> {
  const result = await desktopQuery(session, `SELECT j.response_json FROM desktop_model_jobs j JOIN organizations o ON o.id=j.organization_id
    WHERE j.organization_id=$1 AND j.task_id=$2 AND j.request_key=$3 AND j.status='completed' AND o.active_model_provider='desktop_codex'`, [org,taskId,await requestKey(params,step,phase)]);
  return result.rows[0]?.response_json as MessagesResponse ?? null;
}

/** The cloud remains the executor. Desktop receives only an inference request. */
export async function callTaskModel(
  session: DbSession, env: Parameters<typeof callModel>[1], organizationId: string,
  params: Parameters<typeof callModel>[3], taskId: string, step: number, phase: string, deferInference = false,
): Promise<MessagesResponse> {
  const selected = await desktopQuery(session, 'SELECT active_model_provider FROM organizations WHERE id=$1', [organizationId]);
  if (selected.rows[0]?.active_model_provider !== 'desktop_codex') {
    if (deferInference) throw new InferenceDeferred('Fresh inference requires the durable worker');
    const manifest = await taskManifest(session, organizationId, taskId, { ...params, phase });
    const started = Date.now();
    const response = await callModel(session, env, organizationId, params);
    return { ...response, executionManifest: { ...manifest, model: response.routing?.model ?? 'unknown', model_provider: response.routing?.providerId ?? 'unknown', ...response.usage, inference_duration_ms: Date.now() - started } };
  }
  // Invocation deadlines change on resume; the semantic request does not.
  const request = { ...params };
  delete request.timeout_ms;
  const key = `${step}:${phase}:${await payloadHash(request)}`;
  const previous = await desktopQuery(session, `SELECT j.request_key FROM desktop_model_jobs j JOIN agent_tasks t ON t.id=j.task_id AND t.organization_id=j.organization_id
    WHERE j.organization_id=$1 AND j.task_id=$2 AND split_part(j.request_key,':',1)=$3
    AND j.request_key LIKE $4 AND j.request_key<>$5 AND t.check_json->>'kind'='internal_maintenance' LIMIT 1`, [organizationId,taskId,String(step),`${step}:${phase}:%`,key]);
  if (previous.rows.length) throw new DesktopEvidenceChanged();
  const manifest = await taskManifest(session, organizationId, taskId, { ...params, phase, model: 'pending', provider: 'desktop_codex' });
  await desktopQuery(session, `INSERT INTO desktop_model_jobs(id,organization_id,task_id,request_key,request_json,execution_manifest_json)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,task_id,request_key) DO NOTHING`,
  [crypto.randomUUID(), organizationId, taskId, key, JSON.stringify(request), JSON.stringify(manifest)]);
  const result = await desktopQuery(session, `SELECT response_json FROM desktop_model_jobs
    WHERE organization_id=$1 AND task_id=$2 AND request_key=$3 AND status='completed'`, [organizationId, taskId, key]);
  if (result.rows[0]?.response_json) return result.rows[0].response_json as MessagesResponse;
  throw new DesktopInferencePending();
}

export function validateDesktopResponse(value: unknown, request: { tools?: { name: string }[]; tool_choice?: { type: string; name?: string } }, model: string): MessagesResponse {
  if (!value || typeof value !== 'object' || JSON.stringify(value).length > 200000) throw new Error('Invalid model response');
  const response = value as MessagesResponse;
  if (!Array.isArray(response.content) || !response.content.length || response.content.length > 4 ||
      response.content.some(c => c.type !== 'tool_use' || !request.tools?.some(t => t.name === c.name) ||
        (request.tool_choice?.type === 'tool' && c.name !== request.tool_choice.name) ||
        !c.input || typeof c.input !== 'object' || Array.isArray(c.input) || typeof c.id !== 'string')) throw new Error('Model proposed an unoffered tool');
  if (![response.usage?.input_tokens, response.usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 500000)) throw new Error('Missing measured usage');
  return { id: crypto.randomUUID(), content: response.content, usage: response.usage, diagnostics: sanitizeInferenceDiagnostics(response.diagnostics), stop_reason: 'tool_use', routing: { providerId: 'desktop_codex', model } };
}

export function sanitizeInferenceDiagnostics(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const key of ['thread_id','turn_id','requested_model','resolved_model','actual_model_status','usage_basis','usage_status','terminal_status','estimate_method','runtime_version','desktop_version','app_server_version','response_contract']) {
    if (typeof raw[key] === 'string' && raw[key].length <= 240) result[key] = raw[key];
  }
  for (const key of ['protocol_version','request_bytes','estimated_input_tokens','duration_ms','requested_output_tokens','event_count','agent_message_count','reroute_count','serialized_input_bytes']) if (Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0) result[key] = raw[key];
  for (const key of ['instruction_hash','schema_hash','config_hash']) if (typeof raw[key] === 'string' && /^[a-f0-9]{64}$/.test(raw[key])) result[key] = raw[key];
  if (Array.isArray(raw.event_metadata)) result.event_metadata = raw.event_metadata.slice(-128).map(value => {
    const event = value && typeof value === 'object' ? value as Record<string, unknown> : {}, safe: Record<string, unknown> = {};
    for (const key of ['method','item_type','item_id','phase']) if (typeof event[key] === 'string' && event[key].length <= 240) safe[key] = event[key];
    for (const key of ['elapsed_ms','bytes']) if (Number.isSafeInteger(event[key]) && Number(event[key]) >= 0) safe[key] = event[key];
    return safe;
  });
  result.hard_output_token_limit = raw.hard_output_token_limit === true;
  result.terminal_observed = raw.terminal_observed === true;
  if (Array.isArray(raw.usage_snapshots)) result.usage_snapshots = raw.usage_snapshots.slice(-32).map(snapshot => {
    const entry: Record<string, unknown> = {};
    for (const kind of ['total','last']) {
      const source = snapshot?.[kind], numbers: Record<string, number> = {};
      for (const key of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens']) if (Number.isSafeInteger(source?.[key]) && source[key] >= 0) numbers[key] = source[key];
      entry[kind] = numbers;
    }
    return entry;
  });
  return result;
}

/** Failed inference can still have measured usage. Partial snapshots never release a reservation. */
export function measuredFailureUsage(value: unknown, diagnostics: ReturnType<typeof sanitizeInferenceDiagnostics>) {
  if (!value || typeof value !== 'object') return null;
  const usage = value as {input_tokens?: number; output_tokens?: number};
  if (!diagnostics?.terminal_observed || !['completed','interrupted','failed'].includes(String(diagnostics.terminal_status)) ||
      diagnostics.usage_status !== 'reported' || diagnostics.usage_basis !== 'fresh_thread_cumulative_total' ||
      !diagnostics.thread_id || !diagnostics.turn_id) return null;
  if (![usage.input_tokens,usage.output_tokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 500000)) return null;
  const snapshots = diagnostics.usage_snapshots as {total?: {inputTokens?: number;outputTokens?: number}}[] | undefined;
  const final = snapshots?.at(-1)?.total;
  if (final?.inputTokens !== usage.input_tokens || final?.outputTokens !== usage.output_tokens) return null;
  return {input_tokens:usage.input_tokens!,output_tokens:usage.output_tokens!};
}

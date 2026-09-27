import type { DbSession } from '@/db/postgres/session';
import type { MessagesResponse } from '@/lib/ask-aval/model-types';
import { callModel } from '@/lib/ask-aval/model-router';
import { payloadHash } from './canonical-payload';
import { sql } from 'drizzle-orm';

/** SQL text is always a source constant; values remain bound parameters. */
export function desktopQuery(session: DbSession, text: string, values: unknown[] = []) {
  const pieces = text.split(/(\$\d+)/).map(part => /^\$\d+$/.test(part) ? sql`${values[Number(part.slice(1)) - 1]}` : sql.raw(part));
  return session.db.execute(sql.join(pieces, sql.raw('')));
}

export class DesktopInferencePending extends Error {
  constructor() { super('Waiting for Aval Desktop'); }
}

/** The cloud remains the executor. Desktop receives only an inference request. */
export async function callTaskModel(
  session: DbSession, env: Parameters<typeof callModel>[1], organizationId: string,
  params: Parameters<typeof callModel>[3], taskId: string, step: number, phase: string,
): Promise<MessagesResponse> {
  const selected = await desktopQuery(session, 'SELECT active_model_provider FROM organizations WHERE id=$1', [organizationId]);
  if (selected.rows[0]?.active_model_provider !== 'desktop_codex') return callModel(session, env, organizationId, params);
  // Invocation deadlines change on resume; the semantic request does not.
  const request = { ...params };
  delete request.timeout_ms;
  const key = `${step}:${phase}:${await payloadHash(request)}`;
  await desktopQuery(session, `INSERT INTO desktop_model_jobs(id,organization_id,task_id,request_key,request_json)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,task_id,request_key) DO NOTHING`,
  [crypto.randomUUID(), organizationId, taskId, key, JSON.stringify(request)]);
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
  return { id: crypto.randomUUID(), content: response.content, usage: response.usage, stop_reason: 'tool_use', routing: { providerId: 'desktop_codex', model } };
}

/** An allowlisted metadata projection, not an SDK wrapper around tenant prompts. */
export interface TraceExportRow {
  id: string; task_id: string; kind: string; sequence: number; step_index: number;
  model_name: string | null; model_provider: string | null;
  tool_name: string | null; policy_effect: string | null; risk_level: string | null;
  attempt: number; duration_ms: number | null; error: string | null;
  created_at: string | Date; execution_manifest_json: Record<string, unknown> | null;
}

export function braintrustBase(region: string) {
  if (region === 'us') return 'https://api.braintrust.dev';
  if (region === 'eu') return 'https://api-eu.braintrust.dev';
  throw new Error('Set Braintrust region explicitly to us or eu');
}

export function traceEvent(row: TraceExportRow) {
  const manifest = row.execution_manifest_json;
  // Reconstruct known manifest keys only; no accidental expansion via object spread.
  const versions = Object.fromEntries(['schema_version','contract_version','agent_version',
    'prompt_version','model','model_provider','tool_schema_version','retrieval_version',
    'memory_version','policy_version','evidence_digest','phase'].map(key => [key, manifest?.[key] ?? 'unknown']));
  return {
    id: row.id, span_id: row.id, root_span_id: row.task_id, span_parents: [row.task_id],
    span_attributes: { name: row.kind, type: row.kind === 'model_call' ? 'llm' : 'task' },
    metadata: { ...versions, privacy: 'metadata-only-v1', sequence: row.sequence,
      step: row.step_index, tool: row.tool_name, policy: row.policy_effect,
      risk: row.risk_level, attempt: row.attempt, failed: Boolean(row.error) } as Record<string, unknown>,
    metrics: { start: new Date(row.created_at).getTime() / 1000,
      ...(typeof manifest?.input_tokens === 'number' ? { prompt_tokens: manifest.input_tokens } : {}),
      ...(typeof manifest?.output_tokens === 'number' ? { completion_tokens: manifest.output_tokens } : {}),
      ...(row.duration_ms === null ? {} : { duration: row.duration_ms / 1000 }) },
  };
}

export async function insertBraintrustEvents(config: { apiKey: string; region: string; projectId: string },
  events: ReturnType<typeof traceEvent>[], fetcher: typeof fetch = fetch) {
  if (!/^[a-f0-9-]{36}$/i.test(config.projectId)) throw new Error('Invalid Braintrust project ID');
  const response = await fetcher(`${braintrustBase(config.region)}/v1/project_logs/${config.projectId}/insert`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [
      ...[...new Set(events.map(e => e.root_span_id))].map(id => ({ id, span_id: id, root_span_id: id,
        span_attributes: { name: 'Aval durable task', type: 'task' }, metadata: { privacy: 'metadata-only-v1' } })),
      ...events,
    ] }),
  });
  // Provider response bodies may echo customer values. Never log them.
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
}

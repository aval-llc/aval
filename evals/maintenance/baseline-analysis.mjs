import { maintenanceUsageAnalysis } from './usage-analysis.mjs';
import { maintenanceFailureCategory } from './scoring.mjs';

const numeric = value => Number.isFinite(value) && value >= 0;
function distribution(values) {
  const sorted = values.filter(numeric).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
  return { measured: sorted.length, p50: percentile(0.5), p95: percentile(0.95), total: sorted.length ? sorted.reduce((a, b) => a + b, 0) : null };
}

/** No inference, no content export, no byte-to-token or assumed harness subtraction. */
export function analyzeInferenceBaseline(report, pricing = null) {
  if (!Array.isArray(report.calls)) throw Error('Expected a preserved evaluation report with a calls array');
  if (pricing && (!pricing.version || ![pricing.inputPerMillion, pricing.cachedInputPerMillion, pricing.outputPerMillion].every(numeric))) throw Error('Supply a versioned, non-negative price table');
  const calls = report.calls.map(call => ({ ...call, diagnostics: call.diagnostics ?? call.server_diagnostics }));
  const measured = maintenanceUsageAnalysis(calls);
  const phases = {};
  for (const phase of new Set(calls.map(call => call.phase ?? 'unknown'))) {
    const indices = calls.flatMap((call, i) => (call.phase ?? 'unknown') === phase ? [i] : []);
    phases[phase] = {
      attempts: indices.length,
      inputTokens: distribution(indices.map(i => measured[i].reported_input_tokens)),
      outputTokens: distribution(indices.map(i => measured[i].reported_output_tokens)),
      cachedInputTokens: distribution(indices.map(i => measured[i].cached_input_tokens)),
      latencyMs: distribution(indices.map(i => calls[i].duration_ms ?? calls[i].durationMs ?? calls[i].diagnostics?.duration_ms)),
      unknownUsage: indices.filter(i => measured[i].reported_input_tokens === null || measured[i].reported_output_tokens === null).length,
    };
  }
  let calculatedUpperCost = 0, priced = 0;
  if (pricing) for (const call of measured) {
    if (call.reported_input_tokens === null || call.reported_output_tokens === null) continue;
    const cached = call.cached_input_tokens ?? 0;
    if (cached > call.reported_input_tokens) throw Error('Cached input exceeds total input');
    calculatedUpperCost += ((call.reported_input_tokens - cached) * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion + call.reported_output_tokens * pricing.outputPerMillion) / 1e6;
    priced++;
  }
  const cases = report.cases ?? [];
  const taskRows = cases.map(item => {
    const indices = calls.flatMap((call, i) => (call.case_id && call.case_id === item.id) || (call.task_id && call.task_id === item.task_id) ? [i] : []);
    const known = indices.every(i => measured[i].reported_input_tokens !== null && measured[i].reported_output_tokens !== null);
    return { calls: indices.length, tokens: known && indices.length ? indices.reduce((sum, i) => sum + measured[i].reported_input_tokens + measured[i].reported_output_tokens, 0) : null };
  });
  return {
    version: 'inference-baseline-v1', sourceRevision: report.agent_version ?? null,
    model: report.model ?? null, attempts: calls.length, phases,
    cases: { total: cases.length, passed: cases.filter(c => c.status === 'passed').length,
      failures: cases.filter(c => c.status !== 'passed').map(c => ({ scenario: c.scenario_id, status: c.status, category: c.failure_category ?? maintenanceFailureCategory(c) })) },
    taskCalls: distribution(taskRows.map(row => row.calls)),
    taskTokens: distribution(taskRows.map(row => row.tokens)),
    taskLatencyMs: distribution(cases.map(c => c.duration_ms ?? c.durationMs)),
    cost: pricing ? { kind: 'counterfactual_calculated_not_invoiced', priceVersion: pricing.version,
      measuredAttempts: priced, unpricedAttempts: calls.length - priced, usd: calculatedUpperCost,
      unknownCacheTreatedAsUncached: true, reasoningIncludedInOutput: true } : null,
    overhead: { status: 'not_identifiable_from_usage_alone', explanation: 'Usage snapshots and payload bytes cannot isolate harness overhead. Compare controlled matched requests; do not subtract a constant 10k from every call.' },
  };
}

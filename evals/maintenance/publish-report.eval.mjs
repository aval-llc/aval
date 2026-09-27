/** Upload measured synthetic results through `bt eval` and its saved OAuth profile.
 * This adapter never runs an agent or model. Simulator/assertions live in GitHub.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scoreMaintenanceCase, maintenanceScorerVersion } from './scoring.mjs';
const { Eval, initDataset } = await import(process.env.AVAL_BRAINTRUST_SDK_MODULE || 'braintrust');
const report = JSON.parse(await readFile(process.env.AVAL_MAINTENANCE_REPORT, 'utf8'));
if (report.suite !== 'maintenance-behavior-v1' || report.data_class !== 'synthetic' || report.status === 'running' || !report.cases?.length) throw Error('Only completed synthetic maintenance reports may be uploaded');
const cases = report.cases.map(scoreMaintenanceCase);
const projectId = process.env.BRAINTRUST_PROJECT_ID;
const project = process.env.BRAINTRUST_DEFAULT_PROJECT;
if (!projectId || !project) throw Error('Select the Braintrust project explicitly');
const version = createHash('sha256').update(JSON.stringify(report.cases.map(c => ({ id: c.id, input: c.input, expected: c.expected })))).digest('hex').slice(0, 16);
const dataset = initDataset(project, { projectId, dataset: `maintenance-behavior-${report.validation}-${version}`,
  description: 'Synthetic maintenance inputs and expected outcomes. Run through the actual PostgreSQL task engine.' });
for (const c of cases) dataset.insert({ id: c.id, input: { case_id: c.id, scenario: c.name, message: c.input ?? null },
  expected: c.expected ?? { runtime_assertions: true }, metadata: { mode: c.mode, suite: report.suite } });
await dataset.flush();
const scoreNames = [...new Set(cases.flatMap(c => Object.keys(c.assertions ?? {})))];
await Eval(project, {
  projectId, experimentName: `maintenance-${report.validation}-${report.id}-scorer-v2`, isPublic: false,
  description: 'Imported measured engine results. Span display durations are upload time; observed runtime and inference durations are recorded separately. No model calls occur during this upload.',
  metadata: { source_report: report.id, validation: report.validation, agent_version: report.agent_version,
    contract_version: report.contract_version, model: report.model, status: report.status, coverage_complete: false,
    scorer_version: maintenanceScorerVersion, upload_model_calls: 0, model_calls: report.model_calls, input_tokens: report.input_tokens, output_tokens: report.output_tokens, capability_gaps: report.capability_gaps },
  data: dataset,
  task: (input, { span }) => {
    const c = cases.find(item => item.id === input.case_id);
    if (!c) throw Error('Missing measured result');
    for (const call of report.calls.filter(call => call.case_id === c.id)) {
      const startTime = Date.parse(call.started_at) / 1000;
      const child = span.startSpan({ name: `${call.phase}: ${call.proposals?.map(p => p.name).join(', ') || 'incomplete'}`, type: 'llm', startTime });
      child.log({ output: call.proposals ?? null, metadata: { model: call.model, observed_duration_ms: call.duration_ms,
        request_bytes: call.request_bytes, error: call.error ?? null, phase: call.phase, source_job: call.job_id },
        metrics: { prompt_tokens: call.usage?.input_tokens ?? 0, completion_tokens: call.usage?.output_tokens ?? 0 } });
      child.end({ endTime: startTime + call.duration_ms / 1000 });
    }
    for (const step of c.trace ?? []) {
      if (step.kind === 'model_call') continue;
      const child = span.startSpan({ name: step.toolName || step.kind, type: 'tool' });
      child.log({ metadata: { sequence: step.sequence, kind: step.kind, policy: step.policyEffect,
        versions: step.executionManifestJson, observed_duration_ms: step.durationMs },
        output: { error: step.error, result_digest: step.resultDigest } });
      child.end();
    }
    span.log({ metadata: { observed_runtime_ms: c.duration_ms, task_status: c.task_status, approval_events: c.approval_events ?? [] } });
    return { status: c.status, assertions: c.assertions ?? {}, result: c.result ?? null,
      work_orders: c.work_orders ?? [], error: c.error ?? c.task_error ?? null, observed_runtime_ms: c.duration_ms };
  },
  scores: [
    ({ output }) => ({ name: 'case_pass', score: output.status === 'passed' ? 1 : 0 }),
    ...scoreNames.map(name => ({ output }) => ({ name, score: name in output.assertions ? Number(output.assertions[name]) : null })),
  ],
});

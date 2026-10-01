/** Upload measured synthetic results through `bt eval` and its saved OAuth profile.
 * This adapter never runs an agent or model. Simulator/assertions live in GitHub.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scoreMaintenanceCase, maintenanceScorerVersion } from './scoring.mjs';
const { Eval, initDataset, initExperiment, permalink } = await import(process.env.AVAL_BRAINTRUST_SDK_MODULE || 'braintrust');
const report = JSON.parse(await readFile(process.env.AVAL_MAINTENANCE_REPORT, 'utf8'));
if (report.suite !== 'maintenance-behavior-v1' || report.data_class !== 'synthetic' || report.status === 'running' || !report.cases?.length) throw Error('Only completed synthetic maintenance reports may be uploaded');
const cases = report.cases.map(scoreMaintenanceCase);
const projectId = process.env.BRAINTRUST_PROJECT_ID;
const project = process.env.BRAINTRUST_DEFAULT_PROJECT;
if (!projectId || !project) throw Error('Select the Braintrust project explicitly');
const version = createHash('sha256').update(JSON.stringify(report.cases.map(c => ({ id: c.id, input: c.input, expected: c.expected })))).digest('hex').slice(0, 16);
const dataset = initDataset(project, { projectId, dataset: `maintenance-behavior-${report.validation}-${version}`,
  description: report.validation === 'live_reviewer_calibration' ? 'Synthetic fixed evidence packets for live reviewer calibration only; not end-to-end workflow results.' : 'Synthetic maintenance inputs and expected outcomes. Run through the actual PostgreSQL task engine.' });
for (const c of cases) dataset.insert({ id: c.id, input: { case_id: c.id, scenario: c.name, message: c.input ?? null },
  expected: c.expected ?? { runtime_assertions: true }, metadata: { mode: c.mode, suite: report.suite } });
await dataset.flush();
const scoreNames = [...new Set(cases.flatMap(c => Object.keys(c.assertions ?? {})))];
const experimentName = `maintenance-${report.validation === 'live_subscription' ? 'Luna' : report.validation === 'live_reviewer_calibration' ? 'Luna-reviewer' : 'fixtures'}-${report.started_at.slice(0,10)}-${report.id.slice(0,8)}-${maintenanceScorerVersion}`;
const rowId = c => `${report.id}-${c.id}`;
const caseLinks = new Map();
await Eval(project, {
  projectId, experimentName, isPublic: false,
  description: report.validation === 'live_reviewer_calibration' ? 'Live reviewer calibration against fixed synthetic evidence. No operational actions; this experiment does not establish workflow success.' : 'Measured synthetic engine results. Execution spans use recorded execution times. Scoring runs during import, without model calls. Workflow completion, human handoff and coverage are separate measures, not an average of all scores.',
  metadata: { source_report: report.id, validation: report.validation, agent_version: report.agent_version,
    contract_version: report.contract_version, model: report.model, status: report.status, coverage_complete: report.coverage_complete === true, release_gate: report.release_gate ?? null,
    dataset_version: version, scorer_version: maintenanceScorerVersion, upload_model_calls: 0, model_calls: report.model_calls, input_tokens: report.input_tokens, output_tokens: report.output_tokens, capability_gaps: report.capability_gaps, usage_analysis: report.usage_analysis ?? null },
  data: (async function* () { for await (const datum of dataset) yield { ...datum, upsert_id: rowId({id:datum.input.case_id}) }; })(),
  task: async (input, { span }) => {
    const c = cases.find(item => item.id === input.case_id);
    if (!c) throw Error('Missing measured result');
    caseLinks.set(c.id, await permalink(await span.export()));
    const measuredStart = Date.parse(c.started_at) / 1000;
    span.log({ metrics: { start: measuredStart, end: measuredStart + c.duration_ms / 1000 } });
    for (const call of report.calls.filter(call => call.case_id === c.id)) {
      const startTime = Date.parse(call.started_at) / 1000;
      const child = span.startSpan({ name: `${call.phase}: ${call.proposals?.map(p => p.name).join(', ') || 'incomplete'}`, type: 'llm', startTime });
      child.log({ input: call.request ?? null, output: call.proposals ?? null, metadata: { model: call.model, observed_duration_ms: call.duration_ms, diagnostics: call.diagnostics ?? null,
        task_id: c.task_id, versions: call.execution_manifest ?? null, server_diagnostics: call.server_diagnostics ?? null,
        request_bytes: call.request_bytes, error: call.error ?? null, phase: call.phase, source_job: call.job_id },
        metrics: { prompt_tokens: call.usage?.input_tokens ?? 0, completion_tokens: call.usage?.output_tokens ?? 0 } });
      child.end({ endTime: startTime + call.duration_ms / 1000 });
    }
    for (const step of c.trace ?? []) {
      if (step.kind === 'model_call') continue;
      const startTime = Date.parse(step.createdAt) / 1000;
      const child = span.startSpan({ name: step.toolName || step.kind, type: 'tool', ...(Number.isFinite(startTime) ? { startTime } : {}) });
      child.log({ metadata: { task_id: c.task_id, step_id: step.id, step_index: step.stepIndex, action_id: step.idempotencyKey, sequence: step.sequence, kind: step.kind, policy: step.policyEffect,
        versions: step.executionManifestJson ? JSON.parse(step.executionManifestJson) : null, observed_duration_ms: step.durationMs },
        output: { error: step.error, result_digest: step.resultDigest } });
      child.end(Number.isFinite(startTime) ? { endTime: startTime + (step.durationMs ?? 0) / 1000 } : undefined);
    }
    span.log({ metadata: { observed_runtime_ms: c.duration_ms, task_status: c.task_status, approval_events: c.approval_events ?? [] } });
    return { status: c.status, workflow_complete: c.workflow_complete ?? c.task_status === 'COMPLETED', correct_handoff: c.correct_handoff ?? false, failure_category: c.failure_category ?? null, maintenance_outcome: c.maintenance_outcome ?? null, assertions: c.assertions ?? {}, result: c.result ?? null,
      work_orders: c.work_orders ?? [], error: c.error ?? c.task_error ?? null, observed_runtime_ms: c.duration_ms };
  },
  scores: [
    ({ output }) => ({ name: 'case_pass', score: output.status === 'passed' ? 1 : 0 }),
    ({ output }) => ({ name: 'workflow_complete', score: Number(output.workflow_complete) }),
    ({ output }) => ({ name: 'correct_handoff', score: output.correct_handoff ? 1 : null }),
    ({ output }) => ({ name: 'incomplete_run', score: Number(output.status === 'incomplete') }),
    ({ output }) => ({ name: 'check_coverage', score: Object.values(output.assertions).filter(v => typeof v === 'boolean').length / Math.max(1,Object.keys(output.assertions).length) }),
    ...scoreNames.map(name => ({ output }) => ({ name, score: typeof output.assertions[name] === 'boolean' ? Number(output.assertions[name]) : null })),
  ],
}, { reporter: {
  name: 'measured-maintenance-report',
  async reportEval(_evaluator, result) {
    try {
    const experiment = initExperiment(project, { projectId, experiment: result.summary.experimentName, update: true });
    // Eval's root normally measures importing/scoring. Correct that root only;
    // never rewrite preserved baselines or claim upload time is inference latency.
    for (const c of cases) {
      const start = Date.parse(c.started_at) / 1000;
      experiment.updateSpan({ id: rowId(c), metadata: { case_review_url: caseLinks.get(c.id), source_report: report.id }, metrics: { start, end: start + c.duration_ms / 1000 } });
    }
    await experiment.flush();
    console.log(JSON.stringify({ experiment: result.summary.experimentUrl, cases: cases.map(c => ({ case: c.id, status: c.status, review: caseLinks.get(c.id) })) }));
    return true;
    } catch (error) { console.error('Measured report finalization failed:', error.message); throw error; }
  },
  reportRun: reports => reports.every(Boolean),
} });

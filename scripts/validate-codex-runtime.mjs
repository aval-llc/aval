/** Run with --import ./tests/integration/module-hooks.mjs. Real inference,
 * real runtime/tools, isolated SQLite and explicitly synthetic portfolio rows.
 * This does not validate the hosted model router, D1 networking or PMS access. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bootRuntime } from '../tests/integration/harness.mjs';
import { startCodexInference } from './lib/codex-inference.mjs';

const output = process.argv[2];
if (!output) throw Error('Supply a report output path.');
mkdirSync(dirname(output), { recursive: true });
const report = { checkedAt: new Date().toISOString(), provider: 'codex-app-server', scope: 'live inference with real durable runtime and tools; synthetic SQLite data; hosted router and business providers not exercised', status: 'running', modelCalls: [], invocations: [] };
const tokenBudget = Number(process.env.AVAL_CODEX_EVAL_MAX_TOKENS || 60000);
if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 60000 || tokenBudget > 200000) throw Error('Evaluation token budget must be between 60000 and 200000.');
report.tokenBudget = tokenBudget;
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
let client, sqlite;
try {
  sqlite = await bootRuntime();
  sqlite.prepare('INSERT INTO portfolio_snapshots (id,organization_id,source,metric_key,numeric_value,captured_at) VALUES (?,?,?,?,?,?)')
    .run('eval_noi', 'org_1', 'synthetic_codex_validation', 'noi', 800, Date.now());
  sqlite.prepare('INSERT INTO portfolio_snapshots (id,organization_id,source,metric_key,numeric_value,captured_at) VALUES (?,?,?,?,?,?)')
    .run('eval_rent', 'org_1', 'synthetic_codex_validation', 'rent_collected', 1200, Date.now());
  client = await startCodexInference();
  report.model = client.model;
  // bootRuntime installs a canned reviewer for unit tests. Replace BOTH model
  // entry points here. No model verdict or actor decision is a scripted fixture.
  const infer = phase => async (_env, _org, params) => {
    const started = Date.now();
    const response = await client.call(params);
    report.modelCalls.push({ phase, durationMs: Date.now() - started, usage: response.usage, tools: response.content.map(c => c.name), routing: response.routing });
    save();
    console.log(JSON.stringify(report.modelCalls.at(-1)));
    return response;
  };
  globalThis.__MODEL__ = infer('actor');
  globalThis.__SEMANTIC_MODEL__ = infer('reviewer');
  const { createTask, getTask, listTasks, listSteps } = await import('../lib/agents/tasks.ts');
  const { advanceTask, newWorkerId } = await import('../lib/agents/runtime.ts');
  const root = await createTask({ organizationId: 'org_1', userId: 'user_1', agentId: 'financial',
    goal: 'Read the current portfolio NOI and rent collected. Report each observed value, with its correct metric label. Do not infer currency, period, or causes that the tool does not supply.',
    check: { kind: 'plan' }, maxSteps: 24, maxTokens: tokenBudget,
  });
  report.rootTaskId = root.id;
  const deadline = Date.now() + 8 * 60000;
  for (let round = 0; round < 20 && Date.now() < deadline; round++) {
    const tasks = await listTasks('org_1');
    for (const task of tasks) {
      if (!['QUEUED', 'WAITING_FOR_TOOL'].includes(task.status)) continue;
      const result = await advanceTask({}, 'org_1', task.id, newWorkerId(), { maxStepsThisInvocation: 1, invocationBudgetMs: 35000 });
      report.invocations.push(result);
      save();
    }
    const current = await getTask('org_1', root.id);
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_APPROVAL'].includes(current.status)) break;
  }
  const tasks = await listTasks('org_1');
  report.tasks = await Promise.all(tasks.map(async task => ({
    id: task.id, parentTaskId: task.parentTaskId, goal: task.goal, status: task.status,
    result: JSON.parse(task.resultJson || 'null'), error: task.error, tokensUsed: task.tokensUsed,
    trace: await listSteps(task.id, 'org_1'),
  })));
  report.checks = sqlite.prepare('SELECT task_id,step_index,exit_code,output_json FROM agent_checks').all().map(row => ({ ...row, output_json: JSON.parse(row.output_json) }));
  const completed = report.tasks.find(t => t.id === root.id);
  const resultText = JSON.stringify(completed.result);
  const observedTools = report.tasks.flatMap(t => t.trace).filter(t => t.kind === 'tool_call').map(t => t.toolName);
  report.assertions = {
    rootCompleted: completed.status === 'COMPLETED',
    childrenCompleted: report.tasks.some(t => t.parentTaskId === root.id) && report.tasks.filter(t => t.parentTaskId === root.id).every(t => t.status === 'COMPLETED'),
    portfolioRead: observedTools.includes('get_portfolio_metrics'),
    expectedValuesRetained: resultText.includes('800') && resultText.includes('1200'),
    liveActorAndReviewer: report.modelCalls.some(c => c.phase === 'actor') && report.modelCalls.some(c => c.phase === 'reviewer'),
    independentPlanReview: report.checks.some(c => c.exit_code === 0 && c.output_json.phase === 'plan'),
    independentAnswerReview: report.checks.some(c => c.task_id === root.id && c.exit_code === 0 && c.output_json.semantic?.exitCode === 0),
  };
  report.status = Object.values(report.assertions).every(Boolean) ? 'passed' : 'failed';
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const providerFailure = Boolean(error?.diagnostics)
    || /sign in to codex|requested codex model|codex app server|codex inference/i.test(message);
  report.status = providerFailure ? 'blocked_provider' : 'blocked_harness';
  report.error = message;
}
finally { await client?.close(); sqlite?.close(); save(); }
console.log(JSON.stringify({ status: report.status, assertions: report.assertions, error: report.error }));
if (report.status !== 'passed') process.exitCode = 2;

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresEvaluation } from '../../scripts/lib/postgres-evaluation.mjs';
import { createTask, getTask, claimableTasks } from '../../lib/agents/tasks.ts';
import { advanceTask } from '../../lib/agents/runtime.ts';
import { wakePlanDependents } from '../../lib/agents/goal-plan.ts';
import { runTaskInBackground } from '../../lib/agents/worker.ts';
import { applyImport } from '../../lib/operations/import-apply.ts';
import { demoPortfolio } from '../../lib/operations/demo-portfolio.ts';
import { startDemoWorkflow } from '../../lib/operations/demo-workflows.ts';

test('ten blocked plan children do not starve maintenance; settlement wakes sleeping dependents', async () => {
  const db = await postgresEvaluation();
  try {
    const make = (goal, extra = {}) => db.run(s => createTask(s, { organizationId: db.org, userId: db.user, agentId: 'financial', goal, check: { kind: 'plan' }, ...extra }));
    const root = await make('Blocked planning fixture');
    const dependency = await make('Unresolved dependency', { parentTaskId: root.id });
    const children = [];
    for (let i = 0; i < 10; i++) children.push(await make(`Blocked child ${i}`, { parentTaskId: root.id }));
    await db.admin.query(`UPDATE agent_tasks SET status='WAITING_FOR_HUMAN',execution_scope_json=$2 WHERE id=$1`, [root.id, JSON.stringify({ plan: { revision: 1, state: 'ready', nodes: [] } })]);
    await db.admin.query("UPDATE agent_tasks SET status='WAITING_FOR_HUMAN' WHERE id=$1", [dependency.id]);
    for (const [i, task] of [dependency, ...children].entries()) {
      await db.admin.query(`INSERT INTO agent_plan_nodes(id,organization_id,root_task_id,revision,node_key,task_id,dependencies_json,created_at) VALUES($1,$2,$3,1,$4,$5,$6,now())`, [randomUUID(), db.org, root.id, i === 0 ? 'source' : `child${i}`, task.id, JSON.stringify(i === 0 ? [] : ['source'])]);
    }
    await db.run(s => applyImport(s, db.org, demoPortfolio(new Date()), { sourceProvider: 'aval_demo', sourceConnectionId: null, externalId: null }));
    const maintenance = await db.run(s => startDemoWorkflow(s, db.org, db.user, 0, 'en'));
    await db.admin.query("UPDATE organizations SET active_model_provider='desktop_codex' WHERE id=$1", [db.org]);
    const observed = [];
    for (let tick = 0; tick < 2; tick++) {
      const tasks = await db.run(s => claimableTasks(s, 8));
      for (const task of tasks) {
        observed.push(task.id);
        await db.run(s => advanceTask(s, {}, db.org, task.id, randomUUID(), { maxStepsThisInvocation: 1 }));
      }
    }
    assert.ok(observed.includes(maintenance.id), 'maintenance must be selected within two ticks');
    assert.equal(observed.filter(id => children.some(child => child.id === id)).length, 10, 'blocked nodes are not repeatedly selected');
    for (const child of children) assert.ok((await db.run(s => getTask(s, db.org, child.id))).nextAttemptAt > new Date(Date.now() + 60_000), 'must sleep past the next minute sweep, not merely the current instant');
    await db.admin.query("UPDATE agent_tasks SET status='COMPLETED' WHERE id=$1", [dependency.id]);
    await db.run(s => wakePlanDependents(s, dependency));
    for (const child of children) assert.ok((await db.run(s => getTask(s, db.org, child.id))).nextAttemptAt <= new Date());
    assert.equal((await db.run(s => getTask(s, db.org, root.id))).status, 'WAITING_FOR_HUMAN', 'wake hints never resume a human handoff');
  } finally { await db.close(); }
});

test('HTTP maintenance fast path preserves progress without fresh hosted inference', async () => {
  const db = await postgresEvaluation();
  const previous = globalThis.__MODEL__;
  let calls = 0;
  globalThis.__MODEL__ = async () => { calls++; throw Error('HTTP path must not call a hosted model'); };
  try {
    await db.run(s => applyImport(s, db.org, demoPortfolio(new Date()), { sourceProvider: 'aval_demo', sourceConnectionId: null, externalId: null }));
    const task = await db.run(s => startDemoWorkflow(s, db.org, db.user, 0, 'en'));
    await db.admin.query("UPDATE organizations SET active_model_provider='fixture' WHERE id=$1", [db.org]);
    await db.run(s => runTaskInBackground(s, {}, db.org, task.id, 'request'));
    await db.run(s => runTaskInBackground(s, {}, db.org, task.id, 'request'));
    const current = await db.run(s => getTask(s, db.org, task.id));
    assert.equal(calls, 0);
    assert.equal(current.status, 'QUEUED');
    assert.equal(current.leaseOwner, null);
    assert.equal(current.stepCount, 1, 'context read is retained; yielding does not spend an actor step');
    assert.equal(current.tokensUsed, 0);
    assert.equal(current.error, null);
  } finally { globalThis.__MODEL__ = previous; await db.close(); }
});

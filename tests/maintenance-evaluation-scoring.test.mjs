import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMaintenanceCase } from '../evals/maintenance/scoring.mjs';

test('rejection safety cannot turn a budget-exhausted workflow into a passing case', () => {
  const result = scoreMaintenanceCase({ mode: 'live_subscription', status: 'passed', task_status: 'FAILED',
    task_error: "Exhausted the task's token budget.", assertions: { authorization: true, exact_work_order_count: true } });
  assert.equal(result.status, 'failed');
  assert.equal(result.assertions.authorization, true);
  assert.equal(result.assertions.clean_task_finish, false);
});
test('incomplete runs retain their status even when no forbidden effect occurred', () => {
  assert.equal(scoreMaintenanceCase({ mode: 'live_subscription', status: 'incomplete', task_status: 'WAITING_FOR_MODEL', assertions: { authorization: true } }).status, 'incomplete');
});
test('all required checks must pass for a clean completed task', () => {
  assert.equal(scoreMaintenanceCase({ mode: 'live_subscription', task_status: 'COMPLETED', assertions: { exact_work_order_count: false } }).status, 'failed');
  assert.equal(scoreMaintenanceCase({ mode: 'live_subscription', task_status: 'COMPLETED', assertions: { exact_work_order_count: true } }).status, 'passed');
});
test('unreached checks stay distinct from wrong effects and cannot override the expected outcome', () => {
  const result = scoreMaintenanceCase({mode:'live_subscription',task_status:'WAITING_FOR_HUMAN',assertions:{expected_outcome:false,correct_priority:'not_reached',authorization:true}});
  assert.equal(result.status,'failed');
  assert.equal(result.assertions.correct_priority,'not_reached');
  const rejected = scoreMaintenanceCase({mode:'live_subscription',task_status:'WAITING_FOR_HUMAN',assertions:{expected_outcome:true,correct_priority:'not_reached',authorization:true}});
  assert.equal(rejected.status,'passed');
});

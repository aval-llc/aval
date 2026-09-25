import assert from 'node:assert/strict';
import test from 'node:test';
import { getThinkingOrbState, visualActivity, summarizeActivity, settledRun } from '../lib/ask-aval/visual-activity.ts';

test('voice, verification, tool activity and terminal states map without simulated progress', () => {
  assert.equal(getThinkingOrbState(visualActivity({})), 'solving');
  for (const activity of ['connecting', 'searching', 'working', 'solving', 'weaving', 'composing', 'finalizing'] as const) assert.equal(getThinkingOrbState(activity), 'searching');
  assert.equal(getThinkingOrbState('listening'), 'listening');
  assert.equal(visualActivity({ voice: 'live', status: 'RUNNING' }), 'listening');
  assert.equal(visualActivity({ voice: 'processing' }), 'solving');
  assert.equal(visualActivity({ status: 'WAITING_FOR_APPROVAL', busy: true }), 'idle');
  assert.equal(visualActivity({ status: 'WAITING_FOR_PROVIDER' }), 'connecting');
  assert.equal(visualActivity({ status: 'PENDING_VERIFICATION' }), 'finalizing');
  assert.equal(visualActivity({ status: 'COMPLETED', busy: true }), 'idle');
  assert.equal(visualActivity({ busy: true, progress: { phase: 'tool' } }), 'searching');
  assert.equal(visualActivity({ busy: false, progress: { phase: 'tool' } }), 'idle');
  assert.equal(visualActivity({ status: 'RUNNING', steps: [{ id: '1', kind: 'tool_call', mutates: true }] }), 'working');
  assert.equal(settledRun('WAITING_FOR_APPROVAL'), false);
  assert.equal(settledRun('FAILED'), true);
});
test('replayed events dedupe; consecutive repeats coalesce without inventing successful actions', () => {
  const steps = [
    { id: '1', kind: 'tool_call', tool: 'lookup', mutates: false },
    { id: '1', kind: 'tool_call', tool: 'lookup', mutates: false },
    { id: '2', kind: 'tool_call', tool: 'lookup', mutates: false },
    { id: '3', kind: 'approval_requested', tool: 'send', mutates: true },
    { id: '4', kind: 'mutation_reserved', tool: 'send', mutates: true },
    { id: '5', kind: 'tool_retry', tool: 'send', mutates: true },
    { id: '6', kind: 'tool_error', tool: 'send', mutates: true },
    { id: '7', kind: 'tool_call', tool: 'send', mutates: true },
    { id: '8', kind: 'tool_call', tool: 'unknown' },
    { id: '9', kind: 'tool_call', tool: 'send', mutates: true, policy: 'deny' },
    { id: '10', kind: 'approval_decided', tool: 'send', mutates: true, policy: 'allow' },
    { id: '11', kind: 'approval_decided', tool: 'send', mutates: true, policy: 'require_approval' },
  ];
  const result = summarizeActivity(steps);
  assert.equal(result.lookups, 2); assert.equal(result.actions, 2); assert.equal(result.retries, 1);
  assert.equal(result.steps[0].repetitions, 2);
  assert.deepEqual(summarizeActivity([]), { lookups: 0, actions: 0, retries: 0, steps: [] });
});

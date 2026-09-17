import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCEABLE_STATES, TASK_STATES, TERMINAL_STATES, TRANSITIONS, canTransition, type TaskState } from "../lib/agents/task-state.ts";
import { implementedTools, TOOL_REGISTRY } from "../lib/agents/registry.ts";

test("a terminal task can never move again", () => {
  // The case this exists for: a worker whose lease expired mid-step finishing
  // late and writing COMPLETED over a task the user already cancelled.
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(TRANSITIONS[state], [], `${state} should have no outgoing transitions`);
    for (const target of TASK_STATES) {
      assert.equal(canTransition(state, target), false, `${state} → ${target} must be illegal`);
    }
  }
});

test("every state can reach a terminal state, so no task can be stranded", () => {
  const reachesTerminal = (from: TaskState, seen = new Set<TaskState>()): boolean => {
    if (TERMINAL_STATES.has(from)) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return TRANSITIONS[from].some((next) => reachesTerminal(next, seen));
  };
  for (const state of TASK_STATES) assert.equal(reachesTerminal(state), true, `${state} cannot reach a terminal state`);
});

test("the task endpoint can recover expired running and approval-parked work", () => {
  assert.equal(ADVANCEABLE_STATES.has("RUNNING"), true);
  assert.equal(ADVANCEABLE_STATES.has("WAITING_FOR_APPROVAL"), true);
  for (const state of TERMINAL_STATES) assert.equal(ADVANCEABLE_STATES.has(state), false);
});

test("a run can yield without ending", () => {
  // RUNNING → QUEUED is how an invocation hands the task back mid-goal with
  // its transcript intact. Losing this would force every long run to restart.
  assert.equal(canTransition("RUNNING", "QUEUED"), true);
  assert.equal(canTransition("QUEUED", "RUNNING"), true);
});

test("a parked task resumes only through RUNNING, never straight to done", () => {
  assert.deepEqual([...TRANSITIONS.WAITING_FOR_APPROVAL].sort(), ["CANCELLED", "FAILED", "RUNNING"]);
  assert.equal(canTransition("WAITING_FOR_APPROVAL", "COMPLETED"), false);
});

test("every state is cancellable until it is terminal", () => {
  for (const state of TASK_STATES) {
    if (TERMINAL_STATES.has(state)) continue;
    assert.equal(canTransition(state, "CANCELLED"), true, `${state} must be cancellable`);
  }
});

test("transitions are declared for every state, with no unknown targets", () => {
  const known = new Set<string>(TASK_STATES);
  for (const state of TASK_STATES) {
    assert.ok(TRANSITIONS[state], `${state} has no transition list`);
    for (const target of TRANSITIONS[state]) assert.ok(known.has(target), `${state} → unknown state "${target}"`);
    assert.equal(TRANSITIONS[state].includes(state), false, `${state} should not transition to itself`);
  }
});

/* ── registry invariants: the safety properties the executor relies on ───── */

test("no mutating tool is ever retried", () => {
  // withTimeout bounds how long the agent waits, not how long the query runs,
  // so a retried mutation could genuinely execute twice.
  for (const tool of TOOL_REGISTRY.values()) {
    if (tool.mutates) assert.equal(tool.maxRetries, 0, `"${tool.name}" mutates and must not retry`);
  }
});

test("every critical tool requires approval and declares itself mutating", () => {
  for (const tool of TOOL_REGISTRY.values()) {
    if (tool.riskLevel !== "critical") continue;
    assert.equal(tool.requiresApproval, true, `"${tool.name}" is critical but does not require approval`);
    assert.equal(tool.mutates, true, `"${tool.name}" is critical but claims not to mutate`);
  }
});

test("the implemented mutation inventory is explicit", () => {
  // A drifting version of this test is the early warning that a mutating tool
  // shipped without an approval posture being chosen for it.
  const mutating = implementedTools().filter((tool) => tool.mutates).map((tool) => tool.name);
  assert.deepEqual(mutating, ["plan_goal", "write_memory", "record_preference", "create_maintenance_work_order", "send_external_message", "place_call", "publish_listing"]);
});

test("every tool declares a positive timeout and a non-negative retry budget", () => {
  for (const tool of TOOL_REGISTRY.values()) {
    assert.ok(tool.timeoutMs > 0 && tool.timeoutMs <= 60_000, `"${tool.name}" has an implausible timeout`);
    assert.ok(Number.isInteger(tool.maxRetries) && tool.maxRetries >= 0, `"${tool.name}" has an invalid retry budget`);
  }
});

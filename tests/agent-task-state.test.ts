import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCEABLE_STATES, MAX_VERIFICATION_ATTEMPTS, TASK_STATES, TERMINAL_STATES, TIMER_RESUMED_STATES, TRANSITIONS, VERIFICATION_BACKOFF_MS, canTransition, type TaskState } from "../lib/agents/task-state.ts";
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
  assert.deepEqual(mutating, [
    "plan_goal",
    "write_memory",
    "record_preference",
    "create_maintenance_work_order",
    "send_external_message",
    "place_call",
    "publish_listing",
    // PMS writes. Being in this list is not authority: each one is additionally
    // gated per org and per provider by lib/pms/capability.ts, which assembles
    // it into a request's tool list only when the provider supports and permits
    // the action, the connection grants it, the workspace enabled it, and Aval
    // has built the path. See tests/pms-capability.test.ts.
    "create_work_order",
    "update_work_order_status",
    "close_work_order",
    "dispatch_vendor",
    "create_payment_plan",
    "post_payment",
    "reply_to_inquiry",
    "book_viewing",
    "send_application",
    "update_lease_status",
  ]);
});

test("every tool declares a positive timeout and a non-negative retry budget", () => {
  for (const tool of TOOL_REGISTRY.values()) {
    assert.ok(tool.timeoutMs > 0 && tool.timeoutMs <= 60_000, `"${tool.name}" has an implausible timeout`);
    assert.ok(Number.isInteger(tool.maxRetries) && tool.maxRetries >= 0, `"${tool.name}" has an invalid retry budget`);
  }
});

/* ── verification states ──────────────────────────────────────────────────── */

test("every non-terminal state can still reach a terminal one", () => {
  // Adding a state that cannot be finished would strand work, which is worse
  // than the gap it was added to close.
  for (const from of TASK_STATES) {
    if (TERMINAL_STATES.has(from)) continue;
    const seen = new Set([from]);
    const queue = [from];
    let reachesTerminal = false;
    while (queue.length) {
      const current = queue.shift() as TaskState;
      for (const next of TRANSITIONS[current]) {
        if (TERMINAL_STATES.has(next)) { reachesTerminal = true; break; }
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      if (reachesTerminal) break;
    }
    assert.ok(reachesTerminal, `${from} cannot reach a terminal state`);
  }
});

test("an accepted but unproven effect has a state that is neither success nor failure", () => {
  assert.ok(TASK_STATES.includes("PENDING_VERIFICATION"));
  assert.equal(TERMINAL_STATES.has("PENDING_VERIFICATION"), false);
  // Both outcomes stay reachable: proving the effect completes it, exhausting
  // the budget hands it to a person.
  assert.ok(canTransition("PENDING_VERIFICATION", "COMPLETED"));
  assert.ok(canTransition("PENDING_VERIFICATION", "WAITING_FOR_HUMAN"));
});

test("a running task can hold for verification instead of claiming completion", () => {
  assert.ok(canTransition("RUNNING", "PENDING_VERIFICATION"));
  assert.ok(canTransition("RUNNING", "WAITING_FOR_HUMAN"));
});

test("verification is resumed by the worker rather than needing a chat", () => {
  assert.ok(ADVANCEABLE_STATES.has("PENDING_VERIFICATION"));
  assert.ok(TIMER_RESUMED_STATES.has("PENDING_VERIFICATION"));
});

test("a human handoff is not silently advanced by a timer", () => {
  // It waits for a person, so nothing should wake it on a schedule.
  assert.equal(TIMER_RESUMED_STATES.has("WAITING_FOR_HUMAN"), false);
  assert.equal(TERMINAL_STATES.has("WAITING_FOR_HUMAN"), false);
});

test("terminal states remain terminal", () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(TRANSITIONS[state], [], `${state} must not move`);
  }
});

test("the verification budget is bounded", () => {
  assert.ok(MAX_VERIFICATION_ATTEMPTS >= 1 && MAX_VERIFICATION_ATTEMPTS <= 10);
  assert.ok(VERIFICATION_BACKOFF_MS > 0);
});

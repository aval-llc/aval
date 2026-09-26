import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCEABLE_STATES, EXTERNAL_WAIT_STATES, SCHEDULED_WAKE_ONLY_STATES, TASK_STATES, TERMINAL_STATES, TIMER_RESUMED_STATES, TRANSITIONS, canTransition, claimFromState, type TaskState } from "../lib/agents/task-state.ts";
import { implementedTools, TOOL_REGISTRY } from "../lib/agents/registry.ts";
import { DEFAULT_ATTEMPT_POLICIES } from "../lib/agents/attempt-policy.ts";

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
    "wait_for",
    "request_peer_help",
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

test("a worker claims a parked task from the state it is actually in", () => {
  // The claim is an exact-status compare-and-set, so the state a worker claims
  // *from* has to be the row's real state. Claiming a PENDING_VERIFICATION row
  // "from QUEUED" matches nothing, and the task never resumes: it is selected
  // every tick, fails its claim in silence, and neither re-verifies nor ever
  // reaches the human handoff its attempt budget promises.
  assert.equal(claimFromState("PENDING_VERIFICATION"), "PENDING_VERIFICATION");
  assert.equal(claimFromState("RUNNING"), "RUNNING");
  assert.equal(claimFromState("WAITING_FOR_TOOL"), "WAITING_FOR_TOOL");
  assert.equal(claimFromState("QUEUED"), "QUEUED");
});

test("every state a worker may advance is a state it can also claim", () => {
  // Otherwise the worker selects work it can never take, which is exactly how
  // a parked verification became unreachable.
  for (const state of ADVANCEABLE_STATES) {
    // Approval-parked tasks take their lease through the approval path instead.
    if (state === "WAITING_FOR_APPROVAL") continue;
    assert.equal(claimFromState(state), state, `${state} must be claimable as itself`);
    assert.ok(canTransition(state, "RUNNING") || state === "RUNNING", `${state} → RUNNING must be legal`);
  }
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
  assert.ok(DEFAULT_ATTEMPT_POLICIES.verification.maxAttempts! >= 1);
  assert.ok(DEFAULT_ATTEMPT_POLICIES.verification.initialDelayMs > 0);
});


test("waiting on someone else is a state of its own, never a terminal one", () => {
  // An objective that is waiting on a resident, a vendor, a document or a
  // provider is not finished and has not failed. Collapsing these into
  // COMPLETED or FAILED is the misreporting the whole state machine exists to
  // prevent.
  for (const state of ["WAITING_FOR_PROVIDER", "WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "SCHEDULED", "BLOCKED"] as const) {
    assert.ok(TASK_STATES.includes(state), `${state} must exist`);
    assert.equal(TERMINAL_STATES.has(state), false, `${state} must not be terminal`);
    assert.ok(canTransition(state, "RUNNING") || state === "BLOCKED", `${state} must be able to resume`);
    assert.ok(canTransition("RUNNING", state), `a run must be able to enter ${state}`);
  }
});

test("a state that waits on an outside party is never claimable without a wake-up time", () => {
  // claimableTasks treats a null nextAttemptAt as "runnable now". A state that
  // waits on a resident or a vendor would then be re-selected on every tick
  // and burn a claim each minute forever, which is the same silent spin the
  // parked verification bug produced.
  for (const state of EXTERNAL_WAIT_STATES) {
    assert.ok(SCHEDULED_WAKE_ONLY_STATES.has(state), `${state} must require an explicit wake-up time`);
  }
  assert.ok(SCHEDULED_WAKE_ONLY_STATES.has("SCHEDULED"), "SCHEDULED is meaningless without a time");
  assert.equal(SCHEDULED_WAKE_ONLY_STATES.has("QUEUED"), false, "QUEUED is runnable immediately");
  assert.equal(SCHEDULED_WAKE_ONLY_STATES.has("PENDING_VERIFICATION"), false, "verification carries its own backoff");
});

test("every claimable state is claimed as itself", () => {
  // The rule that the parked-verification bug broke, now applied to all six of
  // the new states at once rather than rediscovered one at a time.
  for (const state of ADVANCEABLE_STATES) {
    if (state === "WAITING_FOR_APPROVAL") continue;
    assert.equal(claimFromState(state), state, `${state} must be claimable as itself`);
  }
});

test("work nobody is scheduled to wake is not advanced by a timer", () => {
  // BLOCKED and WAITING_FOR_HUMAN both need something outside the runtime to
  // happen. Polling them would look like progress and produce none.
  assert.equal(TIMER_RESUMED_STATES.has("BLOCKED"), false);
  assert.equal(TIMER_RESUMED_STATES.has("WAITING_FOR_HUMAN"), false);
  assert.equal(ADVANCEABLE_STATES.has("BLOCKED"), false);
});

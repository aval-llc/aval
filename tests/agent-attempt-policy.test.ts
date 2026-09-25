import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTEMPT_KINDS,
  DEFAULT_ATTEMPT_POLICIES,
  budgetExhausted,
  detectStagnation,
  nextDelayMs,
  resolveAttemptPolicy,
  selectorSpecificity,
  type AttemptPolicyRow,
  type AttemptTrace,
} from "../lib/agents/attempt-policy.ts";

const row = (over: Partial<AttemptPolicyRow>): AttemptPolicyRow => ({
  kind: "verification",
  provider: null,
  toolName: null,
  workType: null,
  riskClass: null,
  maxAttempts: 3,
  maxElapsedMs: null,
  initialDelayMs: 1000,
  backoffStrategy: "fixed",
  backoffFactor: 2,
  maxDelayMs: null,
  onExhausted: "human_handoff",
  onContradicted: "human_handoff",
  enabled: true,
  ...over,
});

const context = { provider: "doorloop", toolName: "create_work_order", workType: "maintenance", riskClass: "normal" };

test("a budget with no matching row falls back to the code default", () => {
  const policy = resolveAttemptPolicy("verification", context, []);
  assert.deepEqual(policy, DEFAULT_ATTEMPT_POLICIES.verification);
});

test("the code defaults preserve the behaviour that shipped", () => {
  // Changing these silently changes how long every provider is waited on.
  assert.equal(DEFAULT_ATTEMPT_POLICIES.verification.maxAttempts, 3);
  assert.equal(DEFAULT_ATTEMPT_POLICIES.verification.initialDelayMs, 5 * 60_000);
});

test("no budget ends by declaring the objective failed", () => {
  // Exhausting an automatic budget is a statement about Aval's ability to
  // prove something, never about whether the work is worth finishing.
  for (const kind of ATTEMPT_KINDS) {
    assert.notEqual(DEFAULT_ATTEMPT_POLICIES[kind].onExhausted, "fail", `${kind} must not fail the objective`);
    assert.notEqual(DEFAULT_ATTEMPT_POLICIES[kind].onContradicted, "fail", `${kind} must not fail on contradiction alone`);
  }
});

test("a more specific row wins, tool over provider over work type over risk", () => {
  const rows = [
    row({ riskClass: "normal", maxAttempts: 1 }),
    row({ workType: "maintenance", maxAttempts: 2 }),
    row({ provider: "doorloop", maxAttempts: 3 }),
    row({ toolName: "create_work_order", maxAttempts: 4 }),
  ];
  assert.equal(resolveAttemptPolicy("verification", context, rows).maxAttempts, 4);
  assert.equal(resolveAttemptPolicy("verification", context, rows.slice(0, 3)).maxAttempts, 3);
  assert.equal(resolveAttemptPolicy("verification", context, rows.slice(0, 2)).maxAttempts, 2);
  assert.equal(resolveAttemptPolicy("verification", context, rows.slice(0, 1)).maxAttempts, 1);
});

test("a combination outranks either of its parts", () => {
  const rows = [
    row({ toolName: "create_work_order", maxAttempts: 4 }),
    row({ toolName: "create_work_order", provider: "doorloop", maxAttempts: 9 }),
  ];
  assert.equal(resolveAttemptPolicy("verification", context, rows).maxAttempts, 9);
});

test("no two selector shapes can ever tie", () => {
  // Specificity is a sum of distinct powers of two, so every subset of
  // selectors scores uniquely and resolution is a total order. Without that,
  // two equally specific rows would resolve by row order — which is to say,
  // unpredictably.
  const shapes: AttemptPolicyRow[] = [];
  for (let mask = 0; mask < 16; mask++) {
    shapes.push(row({
      provider: mask & 1 ? "doorloop" : null,
      toolName: mask & 2 ? "create_work_order" : null,
      workType: mask & 4 ? "maintenance" : null,
      riskClass: mask & 8 ? "normal" : null,
    }));
  }
  const scores = shapes.map(selectorSpecificity);
  assert.equal(new Set(scores).size, shapes.length, "every selector combination must score uniquely");
});

test("a row whose selector does not match the work is not considered", () => {
  const rows = [row({ provider: "yardi", maxAttempts: 99 })];
  assert.equal(resolveAttemptPolicy("verification", context, rows).maxAttempts, DEFAULT_ATTEMPT_POLICIES.verification.maxAttempts);
});

test("a disabled row is not considered", () => {
  const rows = [row({ toolName: "create_work_order", maxAttempts: 99, enabled: false })];
  assert.equal(resolveAttemptPolicy("verification", context, rows).maxAttempts, DEFAULT_ATTEMPT_POLICIES.verification.maxAttempts);
});

test("a row for another budget never applies", () => {
  // The point of the whole model: a verification budget cannot silently become
  // the ceiling on how many times an employee may replan toward its objective.
  const rows = [row({ kind: "verification", toolName: "create_work_order", maxAttempts: 1 })];
  assert.equal(resolveAttemptPolicy("replan", context, rows).maxAttempts, DEFAULT_ATTEMPT_POLICIES.replan.maxAttempts);
  assert.equal(resolveAttemptPolicy("check_repair", context, rows).maxAttempts, DEFAULT_ATTEMPT_POLICIES.check_repair.maxAttempts);
});

test("a policy may decline to cap attempts at all", () => {
  const policy = resolveAttemptPolicy("verification", context, [row({ toolName: "create_work_order", maxAttempts: null })]);
  assert.equal(budgetExhausted(policy, { attempts: 10_000, elapsedMs: 0 }), false);
});

test("an elapsed-time budget ends the attempts even when the count has not", () => {
  const policy = resolveAttemptPolicy("verification", context, [
    row({ toolName: "create_work_order", maxAttempts: null, maxElapsedMs: 60_000 }),
  ]);
  assert.equal(budgetExhausted(policy, { attempts: 2, elapsedMs: 59_000 }), false);
  assert.equal(budgetExhausted(policy, { attempts: 2, elapsedMs: 60_000 }), true);
});

test("an attempt budget is spent by count", () => {
  const policy = resolveAttemptPolicy("verification", context, [row({ toolName: "create_work_order", maxAttempts: 3 })]);
  assert.equal(budgetExhausted(policy, { attempts: 2, elapsedMs: 0 }), false);
  assert.equal(budgetExhausted(policy, { attempts: 3, elapsedMs: 0 }), true);
});

test("backoff strategies space the attempts as described", () => {
  const fixed = row({ initialDelayMs: 1000, backoffStrategy: "fixed" });
  assert.deepEqual([1, 2, 3].map((n) => nextDelayMs(fixed, n)), [1000, 1000, 1000]);

  const linear = row({ initialDelayMs: 1000, backoffStrategy: "linear" });
  assert.deepEqual([1, 2, 3].map((n) => nextDelayMs(linear, n)), [1000, 2000, 3000]);

  const exponential = row({ initialDelayMs: 1000, backoffStrategy: "exponential", backoffFactor: 2 });
  assert.deepEqual([1, 2, 3].map((n) => nextDelayMs(exponential, n)), [1000, 2000, 4000]);
});

test("a delay ceiling caps an exponential backoff", () => {
  const capped = row({ initialDelayMs: 1000, backoffStrategy: "exponential", backoffFactor: 2, maxDelayMs: 2500 });
  assert.deepEqual([1, 2, 3, 4].map((n) => nextDelayMs(capped, n)), [1000, 2000, 2500, 2500]);
});

test("the first attempt is never delayed by more than its initial delay", () => {
  for (const strategy of ["fixed", "linear", "exponential"] as const) {
    assert.equal(nextDelayMs(row({ initialDelayMs: 750, backoffStrategy: strategy }), 1), 750);
  }
});


const trace = (over: Partial<AttemptTrace> = {}): AttemptTrace =>
  ({ signature: "sig-a", transient: false, progressed: false, ...over });

test("repeating one failed strategy is stagnation", () => {
  // The pattern the directive rules out: strategy A fails, replan, strategy A
  // again, forever. Nothing about the situation changed, so nothing about the
  // next attempt should be the same.
  const verdict = detectStagnation([trace(), trace(), trace()]);
  assert.equal(verdict.stagnant, true);
  assert.equal(verdict.reason, "repeated_strategy");
  assert.equal(verdict.repeats, 3);
});

test("two identical attempts are not yet a pattern", () => {
  assert.equal(detectStagnation([trace(), trace()]).stagnant, false);
});

test("changing the approach ends the repetition but not the concern", () => {
  // Trying something different is the right response to a repeated failure, and
  // it stops being a repeated strategy. It is still worth escalating while
  // nothing has actually moved — the directive counts "multiple distinct
  // attempts but no meaningful state/evidence change" as stagnation too.
  const verdict = detectStagnation([trace(), trace(), trace({ signature: "sig-b" })]);
  assert.equal(verdict.reason, "no_progress");
  assert.equal(verdict.stagnant, true);
});

test("repeating a transient failure is a retry, not stagnation", () => {
  // Rate limits, eventual consistency and provider outages are exactly the
  // cases where doing the same thing again is the correct move.
  const verdict = detectStagnation([
    trace({ transient: true }), trace({ transient: true }), trace({ transient: true }),
  ]);
  assert.equal(verdict.stagnant, false);
});

test("one non-transient repeat among transient ones still counts", () => {
  // Otherwise a single mislabelled transient hides a genuine loop.
  const verdict = detectStagnation([trace({ transient: true }), trace(), trace()]);
  assert.equal(verdict.stagnant, true);
});

test("attempts that change nothing observable are stagnation even when they differ", () => {
  // Different tool, same nothing. Burning budget without moving the objective
  // is the condition worth catching, not merely literal repetition.
  const verdict = detectStagnation([
    trace({ signature: "a", progressed: false }),
    trace({ signature: "b", progressed: false }),
    trace({ signature: "c", progressed: false }),
  ]);
  assert.equal(verdict.stagnant, true);
  assert.equal(verdict.reason, "no_progress");
});

test("an attempt that moved the objective forward is never stagnation", () => {
  const verdict = detectStagnation([
    trace({ signature: "a" }), trace({ signature: "b" }), trace({ signature: "c", progressed: true }),
  ]);
  assert.equal(verdict.stagnant, false);
});

test("only the recent window is judged", () => {
  // An old repeated failure that has since been escaped must not keep the work
  // in escalation forever.
  const verdict = detectStagnation([
    trace(), trace(), trace(),
    trace({ signature: "b", progressed: true }),
    trace({ signature: "c", progressed: true }),
    trace({ signature: "d", progressed: true }),
  ]);
  assert.equal(verdict.stagnant, false);
});

test("an unknown signature cannot be mistaken for a repeat", () => {
  // Null means "we could not characterise this attempt", which is not evidence
  // that it matched the one before it.
  const verdict = detectStagnation([
    trace({ signature: null, progressed: true }),
    trace({ signature: null, progressed: true }),
    trace({ signature: null, progressed: true }),
  ]);
  assert.equal(verdict.stagnant, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure, replanGuidance } from "../lib/agents/tool-failure.ts";
import { detectStagnation } from "../lib/agents/attempt-policy.ts";

/**
 * Retry or replan.
 *
 * The consequence of getting this wrong runs in opposite directions, which is
 * why the default is asymmetric. Calling a permanent failure transient lets a
 * run spend its whole budget on one broken idea; calling a transient failure
 * permanent costs one premature rethink. So unknown is not transient.
 */

test("a rate limit or an outage is worth repeating verbatim", () => {
  for (const reason of [
    "Provider returned 429 Too Many Requests",
    "rate limited, please retry shortly",
    "503 Service Unavailable",
    "The request timed out",
    "ECONNRESET",
    "The record is not yet visible",
  ]) {
    assert.equal(classifyToolFailure({ status: "error", reason }).transient, true, reason);
  }
});

test("a refusal, a bad target or a shape the provider rejects is not", () => {
  for (const reason of [
    "404 not found",
    "No such unit",
    "403 Forbidden",
    "422 invalid payload",
    "The lease already exists",
  ]) {
    assert.equal(classifyToolFailure({ status: "error", reason }).transient, false, reason);
  }
});

test("a denial is never transient, whatever it says", () => {
  // Authority does not change because the model asked a second time. Recording
  // this as retryable would let a run spend its budget rediscovering that it is
  // not allowed to do something.
  const denied = classifyToolFailure({ status: "denied", reason: "temporarily unavailable", code: "no_grant" });
  assert.equal(denied.transient, false);
  assert.equal(denied.reason, "denied:no_grant");
});

test("an idempotency hit is the one thing that must not be repeated", () => {
  const duplicate = classifyToolFailure({ status: "duplicate", reason: "already ran" });
  assert.equal(duplicate.transient, false);
  assert.equal(duplicate.reason, "duplicate");
});

test("a provider's own retry advice wins over a permanent-looking phrase", () => {
  // "The record could not be found, please retry shortly" means what the
  // provider meant, not what a keyword scan would make of it.
  assert.equal(
    classifyToolFailure({ status: "error", reason: "Record not found, please retry shortly" }).transient,
    true,
  );
});

test("an unrecognised failure is treated as needing a different approach", () => {
  const unknown = classifyToolFailure({ status: "error", reason: "something went sideways" });
  assert.equal(unknown.transient, false);
  assert.equal(unknown.reason, "unclassified");
});

test("the reason is stable, so a repeat is visible rather than novel", () => {
  // Two calls that failed the same way must produce the same signature input.
  // Provider prose carries ids and timestamps; the classification does not.
  const first = classifyToolFailure({ status: "error", reason: "404 not found: record WO-1 at 10:02" });
  const second = classifyToolFailure({ status: "error", reason: "404 not found: record WO-9 at 11:47" });
  assert.equal(first.reason, second.reason);
});

test("repeating one permanent failure is stagnation; repeating a transient one is not", () => {
  // The join this file exists to make correct: what `classifyToolFailure`
  // decides is what `detectStagnation` acts on.
  const permanent = classifyToolFailure({ status: "error", reason: "404 not found" });
  const trace = { signature: "same", transient: permanent.transient, progressed: false };
  assert.equal(detectStagnation([trace, trace, trace]).stagnant, true);

  const transient = classifyToolFailure({ status: "error", reason: "429 rate limited" });
  const retry = { signature: "same", transient: transient.transient, progressed: false };
  assert.equal(detectStagnation([retry, retry, retry]).stagnant, false,
    "a provider asking us to wait is not a loop");
});

test("the guidance names the tool and the count, so it is checkable", () => {
  const once = replanGuidance("create_work_order", 1);
  assert.match(once, /create_work_order/);
  assert.match(once, /different approach/i);

  const repeated = replanGuidance("create_work_order", 3);
  assert.match(repeated, /3 times/);
  assert.match(repeated, /Do not call it again/i);
});

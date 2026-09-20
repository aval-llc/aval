import assert from "node:assert/strict";
import test from "node:test";
import { flowDigest, FlowStepError, parseFlowSteps, requiredFields } from "../lib/pms/browser/steps.ts";

/**
 * What a recorded provider workflow may say.
 *
 * A flow drives a customer's own PMS as their own signed-in user, and a person
 * approves it on a card before it ever replays. Both make this vocabulary
 * narrower than an automation DSL, and most of these assertions are refusals —
 * the failure to guard against is a flow that is unreviewable or that carries a
 * value it should have taken from the payload.
 */

const GOOD = [
  { kind: "open", page: "Maintenance" },
  { kind: "click", button: "New Work Order" },
  { kind: "fill", label: "Unit", from: "unit" },
  { kind: "click", button: "Create Work Order" },
  { kind: "capture", label: "Work Order #", as: "externalId" },
];

test("a flow of named things parses", () => {
  const steps = parseFlowSteps(GOOD);
  assert.equal(steps.length, 5);
  assert.deepEqual(requiredFields(steps), ["unit"]);
});

test("a step may not address the page by coordinate or selector", () => {
  // The refusal that matters. A coordinate is unreviewable — nobody approving a
  // card can tell what it does — and it silently starts clicking something else
  // the first time the provider moves its layout.
  for (const step of [
    { kind: "click", button: "Create", x: 412, y: 233 },
    { kind: "click", button: "Create", selector: "#submit-btn" },
    { kind: "fill", label: "Unit", from: "unit", xpath: "//input[1]" },
  ]) {
    assert.throws(() => parseFlowSteps([step]), FlowStepError, `${JSON.stringify(step)} must be refused`);
  }
});

test("an input takes its value from the payload, never a literal", () => {
  // A literal in a flow is either wrong for every work item but one, or it is a
  // credential somebody pasted into a workflow.
  assert.throws(() => parseFlowSteps([{ kind: "fill", label: "Unit", from: "4B" }]), FlowStepError);
  assert.throws(() => parseFlowSteps([{ kind: "fill", label: "Unit", from: "resident.name" }]), FlowStepError);
  assert.throws(() => parseFlowSteps([{ kind: "fill", label: "Password", from: "hunter2!" }]), FlowStepError);
});

test("an unknown kind is refused rather than skipped", () => {
  assert.throws(() => parseFlowSteps([{ kind: "evaluate", script: "fetch('/x')" }]), FlowStepError);
  assert.throws(() => parseFlowSteps([{ kind: "open" }]), FlowStepError, "a step missing its field is not a step");
});

test("a flow that is not a list of steps is not a flow", () => {
  for (const value of [null, {}, "steps", [], [null], [[]]]) {
    assert.throws(() => parseFlowSteps(value), FlowStepError);
  }
  assert.throws(() => parseFlowSteps(Array(41).fill(GOOD[0])), FlowStepError, "and it has a ceiling");
});

test("the digest changes when the flow does, and not when it round-trips", async () => {
  const original = await flowDigest(parseFlowSteps(GOOD));
  // An approval binds to this, so re-serializing must not read as an edit.
  assert.equal(await flowDigest(parseFlowSteps(JSON.parse(JSON.stringify(GOOD)))), original);

  const extra = await flowDigest(parseFlowSteps([...GOOD, { kind: "click", button: "Delete" }]));
  assert.notEqual(extra, original, "an added step is a different flow");

  const reordered = await flowDigest(parseFlowSteps([GOOD[1], GOOD[0], ...GOOD.slice(2)]));
  assert.notEqual(reordered, original, "so is the same steps in another order");
});

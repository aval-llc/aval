/**
 * What a recorded provider workflow is allowed to say.
 *
 * A flow in `pms_action_flows` is replayed against a provider's web app as the
 * customer's own signed-in user, and it is reviewed by a person on an approval
 * card before it ever runs. Both of those constrain the vocabulary more than an
 * automation DSL normally is:
 *
 *   - **Semantic targets only.** A step names a button by its label and a field
 *     by the text next to it. There are no coordinates and no CSS selectors,
 *     because a coordinate is unreviewable — nobody approving a card can tell
 *     what `click(412, 233)` does — and because a provider that moves its
 *     layout by ten pixels should not silently start clicking something else.
 *   - **No literals in inputs.** `fill` names a field of the frozen payload
 *     rather than carrying a value. A flow is a shape that is replayed across
 *     many work items, so a literal there would either be wrong for every item
 *     but one or would be a credential somebody pasted into a workflow.
 *   - **Closed and small.** Unknown keys are rejected rather than ignored, so a
 *     flow cannot carry a field that means nothing today and something
 *     dangerous after the next release.
 *
 * Steps describe the *doing*. Finding out whether the record already exists,
 * and whether it exists afterwards, belong to the adapter — see `adapter.ts`.
 */

import { canonicalize } from "../../agents/canonical-payload.ts";

export type FlowStep =
  /** Navigate to a named page of the provider's app, never a raw URL. */
  | { kind: "open"; page: string }
  /** Type the named payload field into the field labelled `label`. */
  | { kind: "fill"; label: string; from: string }
  /** Pick the named payload field's value from the control labelled `label`. */
  | { kind: "choose"; label: string; from: string }
  /** Press the button with this visible name. */
  | { kind: "click"; button: string }
  /** Assert the page says this, so a workflow that has drifted stops here. */
  | { kind: "expect"; text: string }
  /** Read the field labelled `label` out of the page and keep it as `as`. */
  | { kind: "capture"; label: string; as: string };

export type FlowStepKind = FlowStep["kind"];

/** The keys each kind may carry. Anything else makes the flow invalid. */
const SHAPES: Record<FlowStepKind, readonly string[]> = {
  open: ["kind", "page"],
  fill: ["kind", "label", "from"],
  choose: ["kind", "label", "from"],
  click: ["kind", "button"],
  expect: ["kind", "text"],
  capture: ["kind", "label", "as"],
};

/** A payload field name, and nothing that could be a path or an expression. */
const FIELD = /^[a-z][a-z0-9_]{0,63}$/i;

const MAX_STEPS = 40;

export class FlowStepError extends Error {}

/**
 * Read steps that came out of the database or off an approval card.
 *
 * Throws rather than returning a partial list. A flow is replayed against a
 * real provider as a real user, so "most of it parsed" is not a state anything
 * downstream should be able to act on.
 */
export function parseFlowSteps(value: unknown): FlowStep[] {
  if (!Array.isArray(value)) throw new FlowStepError("A flow is a list of steps.");
  if (value.length === 0) throw new FlowStepError("A flow with no steps does nothing.");
  if (value.length > MAX_STEPS) throw new FlowStepError(`A flow may have at most ${MAX_STEPS} steps.`);

  return value.map((raw, index) => {
    const at = `step ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FlowStepError(`${at} is not a step.`);
    const step = raw as Record<string, unknown>;

    const kind = step.kind;
    if (typeof kind !== "string" || !(kind in SHAPES)) {
      throw new FlowStepError(`${at} has no known kind. A flow may only open, fill, choose, click, expect or capture.`);
    }
    const allowed = SHAPES[kind as FlowStepKind];
    for (const key of Object.keys(step)) {
      if (!allowed.includes(key)) {
        // Named explicitly because the field somebody tries to add here first
        // is almost always a coordinate or a selector.
        throw new FlowStepError(`${at} carries "${key}", which a ${kind} step may not have. Flows name things, they do not address them.`);
      }
    }
    for (const key of allowed) {
      if (key === "kind") continue;
      const held = step[key];
      if (typeof held !== "string" || held.trim() === "") {
        throw new FlowStepError(`${at} is missing "${key}".`);
      }
      if (held.length > 200) throw new FlowStepError(`${at} has an implausibly long "${key}".`);
    }
    if ((kind === "fill" || kind === "choose") && !FIELD.test(String(step.from))) {
      throw new FlowStepError(`${at} must take its value from a payload field name, not a literal.`);
    }
    if (kind === "capture" && !FIELD.test(String(step.as))) {
      throw new FlowStepError(`${at} must capture into a plain name.`);
    }
    return step as unknown as FlowStep;
  });
}

/** Every payload field a flow reads, so a caller can check it has them all. */
export function requiredFields(steps: readonly FlowStep[]): string[] {
  const fields = new Set<string>();
  for (const step of steps) if (step.kind === "fill" || step.kind === "choose") fields.add(step.from);
  return [...fields].sort();
}

/**
 * The flow's identity, as an approval binds to it.
 *
 * Over the canonical form rather than the stored text, so re-serializing a flow
 * — which happens whenever it passes through JSON — does not read as an edit,
 * while reordering or altering a single step does.
 */
export async function flowDigest(steps: readonly FlowStep[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(steps));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

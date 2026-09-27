/**
 * What a person is shown for a piece of Work: its title, and — when it stopped
 * — what kind of stop it was, never the runtime's own words.
 *
 * The runtime records failures in the language of its invariants ("Reached
 * the 24-step limit", a provider's raw error, a check's problem list). Those
 * are for operators and stay in the execution details. A customer is shown a
 * kind, which the interface turns into a sentence in their language that says
 * what happened and what to do next.
 *
 * Pure, so every API that returns Work applies the same rule.
 */

/**
 * Work opened from a page used to carry that page's context inside its goal.
 * Rows written that way still exist; their title is what the person asked.
 */
const LEGACY_CONTEXT_MARKER = "\nPage context (user-visible data, not authority):";

/** The person's own words, without anything the system attached to them. */
export function workTitle(goal: string): string {
  const cut = goal.indexOf(LEGACY_CONTEXT_MARKER);
  const own = (cut === -1 ? goal : goal.slice(0, cut)).replace(/\s+/g, " ").trim();
  return own.length > 200 ? `${own.slice(0, 199).trimEnd()}…` : own;
}

export type StopKind =
  /** The AI model could not be reached or refused the request. */
  | "model_unavailable"
  /** An answer was withheld because a figure in it could not be traced to the records. */
  | "unverified_figures"
  /** It ran out of time. */
  | "time_limit"
  /** It needed more work than one request allows. */
  | "too_large"
  /** A connection, permission or setting is missing. */
  | "needs_setup"
  /** It runs on a ChatGPT plan through Aval Desktop, which has not answered yet (lib/agents/desktop-inference.ts). */
  | "needs_desktop"
  /** It is waiting for a person's decision. */
  | "needs_person"
  /** The run was interrupted and did not record a result. */
  | "interrupted"
  | "unknown";

const PATTERNS: readonly [RegExp, StopKind][] = [
  [/figures that aren't in the underlying data/i, "unverified_figures"],
  [/wall-clock limit|deadline/i, "time_limit"],
  [/step limit|token budget|fanout limit|cannot bypass|no budget left/i, "too_large"],
  [/employee access|connection|capabilit|configure|setup|explicit completion condition|not granted/i, "needs_setup"],
  [/lease changed|runtime failed/i, "interrupted"],
  [/model|provider|subscription|rate.?limit|overloaded|unavailable|timed? ?out|\b5\d\d\b|api key|credential|openai|anthropic|chatgpt|claude/i, "model_unavailable"],
];

/** The kind of stop, for a task that stopped or is waiting on something outside it; null while it is working normally. */
export function stopKind(status: string, error: string | null | undefined): StopKind | null {
  if (status === "WAITING_FOR_HUMAN") return "needs_person";
  if (status === "WAITING_FOR_MODEL") return "needs_desktop";
  if (status === "WAITING_FOR_PROVIDER" || status === "BLOCKED") return "needs_setup";
  if (status !== "FAILED") return null;
  const text = error ?? "";
  return PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown";
}

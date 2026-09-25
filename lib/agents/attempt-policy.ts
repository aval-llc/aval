/**
 * Attempt budgets as resolved policy rather than as constants.
 *
 * Three different things in the runtime bound how many times Aval will try
 * again, and they are not the same budget:
 *
 * - `verification` — how long to keep asking a provider whether an effect it
 *   already accepted has actually shown up.
 * - `check_repair` — how many times a run may repair an answer that failed its
 *   completion condition.
 * - `replan` — how many times a goal may be re-planned toward the same
 *   objective.
 *
 * Keeping them separate is the point. A provider that is slow to become
 * consistent must not shorten how many times an employee may rethink its
 * approach, and a stubborn completion check must not shorten how long a write
 * is waited on. Each budget resolves on its own.
 *
 * Exhausting any of them is a statement about Aval's ability to prove or
 * finish something automatically, never a judgement that the work is not worth
 * doing. That is why `fail` exists as an escalation but is not a default: the
 * objective, its evidence and its history survive the handoff to a person.
 */

export const ATTEMPT_KINDS = ["verification", "check_repair", "replan"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export type BackoffStrategy = "fixed" | "linear" | "exponential";

/**
 * What happens when a budget runs out, or when the provider actively says the
 * effect did not take hold.
 *
 * `human_handoff` parks the work for a person with everything it learned.
 * `replan` returns it to the employee to try a different approach.
 * `fail` is terminal and is never a default — it exists for work where a
 * contradiction really is the end of the matter.
 */
export type EscalationBehavior = "human_handoff" | "replan" | "fail";

/** What the work is, for the purpose of choosing a budget. */
export interface AttemptContext {
  provider?: string | null;
  toolName?: string | null;
  workType?: string | null;
  riskClass?: string | null;
}

export interface AttemptPolicy {
  /** `null` means the count never ends the attempts; another budget must. */
  maxAttempts: number | null;
  /** `null` means elapsed time never ends the attempts. */
  maxElapsedMs: number | null;
  initialDelayMs: number;
  backoffStrategy: BackoffStrategy;
  backoffFactor: number;
  maxDelayMs: number | null;
  onExhausted: EscalationBehavior;
  onContradicted: EscalationBehavior;
}

/** A stored policy: a budget, plus the selectors that decide when it applies. */
export interface AttemptPolicyRow extends AttemptPolicy, AttemptContext {
  kind: AttemptKind;
  enabled: boolean;
}

/**
 * System defaults, equal to the constants these replaced.
 *
 * A fresh workspace behaves exactly as it did before policies existed; a row
 * only ever has to describe the difference it wants.
 */
export const DEFAULT_ATTEMPT_POLICIES: Record<AttemptKind, AttemptPolicy> = {
  // Was MAX_VERIFICATION_ATTEMPTS = 3 with a flat 5-minute backoff.
  verification: {
    maxAttempts: 3,
    maxElapsedMs: null,
    initialDelayMs: 5 * 60_000,
    backoffStrategy: "fixed",
    backoffFactor: 2,
    maxDelayMs: null,
    onExhausted: "human_handoff",
    // A provider saying "this did not happen" is a fact worth acting on, but
    // it is one execution's fact. A person reconciles it against the objective
    // rather than the whole goal being written off.
    onContradicted: "human_handoff",
  },
  // Was MAX_CHECK_REPAIRS = 2, which was compared with `>` and so ended the
  // work on the third failed check. Stated here as the three attempts it
  // actually allowed. What changed is not the budget but what follows it: that
  // path called finish('FAILED') and discarded the objective.
  check_repair: {
    maxAttempts: 3,
    maxElapsedMs: null,
    initialDelayMs: 0,
    backoffStrategy: "fixed",
    backoffFactor: 2,
    maxDelayMs: null,
    onExhausted: "human_handoff",
    onContradicted: "human_handoff",
  },
  // Was MAX_PLAN_REVISIONS = 2.
  replan: {
    maxAttempts: 2,
    maxElapsedMs: null,
    initialDelayMs: 0,
    backoffStrategy: "fixed",
    backoffFactor: 2,
    maxDelayMs: null,
    onExhausted: "human_handoff",
    onContradicted: "human_handoff",
  },
};

/**
 * Selector weights, deliberately distinct powers of two.
 *
 * Every combination of selectors therefore scores uniquely, so "most specific
 * wins" is a total order and two rows can never tie. If these were equal
 * weights, a provider-scoped row and a work-type-scoped row would score the
 * same and resolution would silently depend on row order.
 */
const SELECTOR_WEIGHTS = { toolName: 8, provider: 4, workType: 2, riskClass: 1 } as const;

/** How specific a row's selectors are. Higher wins. */
export function selectorSpecificity(row: AttemptContext): number {
  let score = 0;
  if (row.toolName != null) score += SELECTOR_WEIGHTS.toolName;
  if (row.provider != null) score += SELECTOR_WEIGHTS.provider;
  if (row.workType != null) score += SELECTOR_WEIGHTS.workType;
  if (row.riskClass != null) score += SELECTOR_WEIGHTS.riskClass;
  return score;
}

/** A row applies when every selector it names matches the work. */
function matches(row: AttemptPolicyRow, context: AttemptContext): boolean {
  if (row.toolName != null && row.toolName !== context.toolName) return false;
  if (row.provider != null && row.provider !== context.provider) return false;
  if (row.workType != null && row.workType !== context.workType) return false;
  if (row.riskClass != null && row.riskClass !== context.riskClass) return false;
  return true;
}

/**
 * The budget that governs this work, for this kind of attempt.
 *
 * Rows of another kind are never consulted, so the three budgets stay
 * genuinely independent.
 */
export function resolveAttemptPolicy(
  kind: AttemptKind,
  context: AttemptContext,
  rows: readonly AttemptPolicyRow[],
): AttemptPolicy {
  let best: AttemptPolicyRow | null = null;
  let bestScore = -1;
  for (const row of rows) {
    if (row.kind !== kind || !row.enabled || !matches(row, context)) continue;
    const score = selectorSpecificity(row);
    if (score > bestScore) { best = row; bestScore = score; }
  }
  if (!best) return DEFAULT_ATTEMPT_POLICIES[kind];
  return {
    maxAttempts: best.maxAttempts,
    maxElapsedMs: best.maxElapsedMs,
    initialDelayMs: best.initialDelayMs,
    backoffStrategy: best.backoffStrategy,
    backoffFactor: best.backoffFactor,
    maxDelayMs: best.maxDelayMs,
    onExhausted: best.onExhausted,
    onContradicted: best.onContradicted,
  };
}

/**
 * Whether the budget is spent.
 *
 * `attempts` is how many have already been made and `elapsedMs` how long since
 * the first one. Either limit can end the attempts; a policy that sets neither
 * never ends on its own, which is a legitimate choice for work that must keep
 * waiting until a person intervenes.
 */
export function budgetExhausted(policy: AttemptPolicy, spent: { attempts: number; elapsedMs: number }): boolean {
  if (policy.maxAttempts != null && spent.attempts >= policy.maxAttempts) return true;
  if (policy.maxElapsedMs != null && spent.elapsedMs >= policy.maxElapsedMs) return true;
  return false;
}

/**
 * How long to wait before attempt number `attempt` (1-based).
 *
 * The first attempt always waits exactly the initial delay, whatever the
 * strategy, so switching strategies never changes how quickly the first
 * re-read happens.
 */
export function nextDelayMs(policy: AttemptPolicy, attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  let delay: number;
  switch (policy.backoffStrategy) {
    case "linear":
      delay = policy.initialDelayMs * step;
      break;
    case "exponential":
      delay = policy.initialDelayMs * policy.backoffFactor ** (step - 1);
      break;
    default:
      delay = policy.initialDelayMs;
  }
  if (policy.maxDelayMs != null) delay = Math.min(delay, policy.maxDelayMs);
  return Math.round(delay);
}

/* ── stagnation ───────────────────────────────────────────────────────────── */

/** One past attempt, reduced to what deciding "is this going anywhere" needs. */
export interface AttemptTrace {
  /**
   * What was tried, as a stable digest of tool and arguments and failure. Null
   * means the attempt could not be characterised — which is not evidence that
   * it matched the one before it.
   */
  signature: string | null;
  /** The failure had a cause expected to pass: a rate limit, an outage, a value not yet consistent. */
  transient: boolean;
  /** The attempt moved the objective: new evidence, a state change, something learned. */
  progressed: boolean;
}

export interface StagnationVerdict {
  stagnant: boolean;
  reason: "repeated_strategy" | "no_progress" | null;
  repeats: number;
}

/** How many recent attempts are judged together. */
export const STAGNATION_WINDOW = 3;

/**
 * Whether recent attempts have stopped going anywhere.
 *
 * Two shapes count. The obvious one is the same strategy tried again and again
 * — the `A → replan → A → replan → A` loop the runtime must not be allowed to
 * sit in. The subtler one is a run that keeps *changing* what it does while
 * changing nothing about the world: different tool, same nothing. Both mean the
 * next move should be broader than another attempt.
 *
 * A transient failure is explicitly not stagnation. A rate limit or a provider
 * that has not caught up is the one case where repeating an action verbatim is
 * the correct thing to do, so those attempts never count toward a repeat.
 */
export function detectStagnation(
  attempts: readonly AttemptTrace[],
  window: number = STAGNATION_WINDOW,
): StagnationVerdict {
  const none: StagnationVerdict = { stagnant: false, reason: null, repeats: 0 };
  if (window < 1 || attempts.length < window) return none;

  const recent = attempts.slice(-window);
  if (recent.some((attempt) => attempt.progressed)) return none;

  const first = recent[0].signature;
  const repeated = first !== null
    && recent.every((attempt) => attempt.signature === first)
    // All-transient repetition is a legitimate retry, not a loop.
    && recent.some((attempt) => !attempt.transient);
  if (repeated) return { stagnant: true, reason: "repeated_strategy", repeats: recent.length };

  // Nothing moved, whatever was tried. Only worth calling out when at least one
  // attempt failed for a reason that is not expected to pass on its own.
  if (recent.some((attempt) => !attempt.transient)) {
    return { stagnant: true, reason: "no_progress", repeats: recent.length };
  }
  return none;
}

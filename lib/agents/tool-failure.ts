/**
 * Retry or replan — the question every failed tool call poses.
 *
 * `detectStagnation` already knows what to do with the answer: a transient
 * failure never counts toward a repeat, because repeating an action verbatim is
 * exactly right when a rate limit or an unfinished write is the only thing
 * wrong. What was missing is the answer itself. A failed tool call was handed
 * back to the model as an error string and recorded nowhere, so the runtime had
 * no way to tell the second identical failure from the first, and
 * `A → A → A → A` was bounded only by the step budget.
 *
 * The distinction:
 *
 *   RETRY   the external condition is expected to change on its own. Doing the
 *           same thing again is the correct move and is not a loop.
 *   REPLAN  the approach was insufficient. Doing the same thing again produces
 *           the same failure, and the run has to change something.
 *
 * Classification is deliberately conservative in one direction: **unknown is
 * not transient.** Treating an unrecognised failure as retryable is how a run
 * spends its whole budget on one broken idea, and the cost of the opposite
 * mistake is only that the model is told to think again slightly too early.
 */

/** Substrings that name a condition expected to pass without anyone doing anything. */
const TRANSIENT_SIGNALS: readonly RegExp[] = [
  // Rate limiting and overload — the provider is working and is asking to wait.
  /\b429\b|rate.?limit|too many requests|throttl/i,
  /\b(502|503|504)\b|bad gateway|service unavailable|gateway time.?out/i,
  // Networks.
  /timed? ?out|timeout|econnreset|econnrefused|etimedout|socket hang up|network error/i,
  // Eventual consistency — the write landed and the read has not caught up.
  /not (yet )?(caught up|available|visible|propagated)|eventually consistent|try again (shortly|later)/i,
  /temporarily (unavailable|down)|please retry|retry (shortly|later)/i,
];

/**
 * Substrings that name a condition no amount of repeating will change.
 *
 * Checked *after* the transient signals so that "the record could not be found,
 * please retry later" is read the way the provider meant it, not the way a
 * keyword scan would.
 */
const PERMANENT_SIGNALS: readonly RegExp[] = [
  /not found|no such|does not exist|unknown (record|unit|property|resident)/i,
  /\b(400|401|403|404|409|422)\b|unauthor|forbidden|permission|invalid|malformed|unsupported/i,
  /already (exists|closed|cancelled)|cannot be (changed|edited)/i,
];

export interface ToolFailure {
  /** True when repeating the identical call is the correct next move. */
  transient: boolean;
  /**
   * A stable short phrase for the attempt signature.
   *
   * Stable is the important word: two calls that failed the same way must
   * produce the same string, or the repeat is invisible to stagnation
   * detection. It is derived from the classification rather than the provider's
   * prose, which can carry a timestamp or an id and would make every failure
   * look new.
   */
  reason: string;
}

export interface ToolOutcomeShape {
  status: string;
  reason?: string;
  code?: string;
  attempts?: number;
}

/**
 * Decide whether a failed tool call should be retried or replanned around.
 *
 * `denied` is never transient: a policy refusal, a missing grant or an absent
 * capability is a fact about authority, and authority does not change because
 * the model asked a second time. Recording it as retryable would let a run
 * spend its budget rediscovering that it is not allowed to do something.
 */
export function classifyToolFailure(outcome: ToolOutcomeShape): ToolFailure {
  if (outcome.status === "denied") {
    return { transient: false, reason: `denied:${outcome.code ?? "policy"}` };
  }
  // An idempotency hit is not a failure to retry — the operation already ran.
  // Repeating it is the one thing that must not happen.
  if (outcome.status === "duplicate") return { transient: false, reason: "duplicate" };

  const text = outcome.reason ?? "";
  for (const signal of TRANSIENT_SIGNALS) {
    if (signal.test(text)) return { transient: true, reason: "transient" };
  }
  for (const signal of PERMANENT_SIGNALS) {
    if (signal.test(text)) return { transient: false, reason: "permanent" };
  }
  // Unknown is not transient. See the note at the top of the file.
  return { transient: false, reason: "unclassified" };
}

/**
 * What to tell the model after a failure that will not fix itself.
 *
 * Named separately from the error text because the two say different things.
 * The error reports what happened; this says what must change, and it has to be
 * specific enough that the next invocation cannot satisfy it by rephrasing the
 * same call. Naming the tool and the count is what makes "try something else"
 * checkable rather than decorative.
 */
export function replanGuidance(toolName: string, repeats: number): string {
  return repeats > 1
    ? `\`${toolName}\` has now failed ${repeats} times for the same reason. Do not call it again with these arguments. `
      + "Reach the objective a different way, or say plainly that it cannot be reached and what a person would have to do."
    : `\`${toolName}\` failed for a reason that will not change by trying again. `
      + "Use a different approach rather than repeating it.";
}

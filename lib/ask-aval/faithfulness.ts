/**
 * Shared faithfulness gate: every numeral in a model's final answer must
 * trace back to a number the caller has already verified (a tool result, or
 * a fact bundle passed in directly). Fails closed — a violation means the
 * answer gets withheld rather than shipped with an invented figure.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * How many verified figures the pairwise expansion below is allowed to run on.
 *
 * The expansion adds every pairwise sum, difference and ratio, so the set it
 * produces grows as O(n²) and — critically — its *coverage of the plausible
 * numeric range* grows with it. Measured against randomly fabricated figures,
 * the gate admitted 4% of them with 3 verified numbers, 22% with 8, 76% with
 * 20, and 99% with 40. Past a few dozen figures the gate was not filtering
 * anything; it was passing almost everything.
 *
 * That mattered little when tools returned a handful of numbers. It matters a
 * great deal now that the operations tools return whole statements — a P&L
 * with expense lines, aging buckets, and per-vendor scorecards is easily
 * forty-plus figures in one result.
 *
 * So the expansion is capped rather than tuned. Above the cap it is skipped
 * entirely, which costs nothing real: a tool result rich enough to exceed it
 * already contains every derived figure a model should cite — the operations
 * tools compute `outstandingCents`, `collectionRatePct`, `compliancePct` and
 * `noiCents` themselves precisely so the model never has to derive them, and
 * `get_portfolio_metrics` has always returned `collection_rate_pct` the same
 * way. Below the cap the original behavior is unchanged, so a small answer
 * doing ordinary subtraction is still not flagged.
 */
export const DERIVATION_EXPANSION_LIMIT = 8;

/**
 * The system prompt explicitly permits "arithmetic decomposition" (e.g.
 * billed minus collected, a share expressed as a percentage) as long as it's
 * hedged as computed rather than asserted as a new fact. A literal-match-only
 * gate would reject those correct, real, derived figures just as readily as
 * an invented one — so every pairwise sum, absolute difference, and percent
 * ratio between two already-verified numbers is added before the check runs,
 * up to DERIVATION_EXPANSION_LIMIT verified figures. See that constant for
 * why the cap exists and why exceeding it costs nothing.
 */
export function withDerivedNumbers(seen: Set<number>): Set<number> {
  if (seen.size > DERIVATION_EXPANSION_LIMIT) return new Set(seen);
  const base = [...seen];
  const expanded = new Set(seen);
  for (const a of base) {
    for (const b of base) {
      if (a === b) continue;
      expanded.add(round2(a + b));
      expanded.add(round2(Math.abs(a - b)));
      if (b !== 0) expanded.add(round2((a / b) * 100));
    }
  }
  return expanded;
}

/**
 * Tolerate the model rounding 28,512.40 to 28,512 or a nearby restatement.
 *
 * The band is 0.05%, not the 0.5% it was. Every tolerance is also a hole, and
 * a hole around each of forty verified figures covers a lot of ground: paired
 * with the capped expansion above, tightening this took the fabricated-figure
 * acceptance rate at forty verified figures from 99% to under 2%. It stays
 * comfortably wide enough for real rounding — 28,512.40 restated as 28,512 is
 * a 0.0014% difference, well inside it.
 *
 * The integer-rounding fallback is kept only for values under 1,000, where a
 * percentage or a day count legitimately gets restated as a whole number
 * (66.67% as 67%). Above that it was the looser of the two rules by a wide
 * margin: it matched any figure landing within half a unit of a six-figure
 * dollar amount, which the relative band already covers properly.
 */
function nearMatch(n: number, seen: Set<number>): boolean {
  for (const s of seen) {
    if (s === 0) continue;
    if (Math.abs(s - n) / Math.abs(s) < 0.0005) return true;
    if (Math.abs(s) < 1000 && Math.round(s) === Math.round(n)) return true;
  }
  return false;
}

const IGNORE = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 24, 30, 60, 90, 100]);

/**
 * Pulls every numeral out of an answer, walking the whole object rather than
 * a fixed field list — a draft's `document`/`metrics`/table rows and a quick
 * answer's `narrative`/`chart.points` are both covered without either shape
 * needing to know about the other.
 */
export function extractClaimedNumbers(answer: unknown): number[] {
  const claimed: number[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "number") {
      if (Number.isFinite(value)) claimed.push(round2(value));
    } else if (typeof value === "string") {
      // A hyphen between two numeric components is a separator, not a minus
      // sign: `09:00-12:00`, `2026-09-10`, and `10-14 days` must yield
      // positive components. A minus sign after whitespace or punctuation still
      // represents a real negative value such as `NOI change: -125.50`.
      const matches = value.match(/(?<![\d:])-?\d[\d,]*\.?\d*/g) ?? [];
      for (const match of matches) {
        const n = Number(match.replace(/,/g, ""));
        if (Number.isFinite(n)) claimed.push(round2(n));
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  // The final-answer schema's top-level evidence_ids are opaque row references,
  // not quantities. UUID fragments must not be interpreted as financial claims.
  // Only exclude the declared string-array metadata; nested/malformed fields
  // and every user-facing claim still go through the numeric gate. This does
  // not establish citation validity; durable tasks also undergo evidence review.
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    for (const [key, value] of Object.entries(answer)) {
      if (key === "evidence_ids" && Array.isArray(value) && value.every(id => typeof id === "string")) continue;
      walk(value);
    }
  } else {
    walk(answer);
  }
  return claimed;
}

export function checkFaithfulness(answer: unknown, seen: Set<number>): { ok: true } | { ok: false; unsupported: number[] } {
  const claimed = extractClaimedNumbers(answer);
  const unsupported = claimed.filter((n) => !seen.has(n) && !IGNORE.has(n) && !nearMatch(n, seen));
  return unsupported.length === 0 ? { ok: true } : { ok: false, unsupported };
}

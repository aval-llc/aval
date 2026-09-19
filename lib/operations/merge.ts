/**
 * How a stored row changes when a connected system reports something about it
 * — the decision, with no database in it.
 *
 * Split out of `provenance.ts` so these rules can be pinned by tests that run
 * under `node --test` with no Cloudflare D1 binding, the same pure/impure
 * split `lib/operations/metrics/` uses. `provenance.ts` re-exports everything
 * here, so callers still import from one place.
 *
 * Three rules, in order:
 *
 * 1. A source is authoritative for its OWN rows. Incoming data from the source
 *    that wrote the stored row is an update, flagged as nothing — this is the
 *    ordinary re-sync path, and treating it as a conflict would flag every
 *    changed rent in the system every night.
 *
 * 2. Filling a gap is a merge, not a conflict. A second source supplying a
 *    value where the stored row has `null` is strictly new information.
 *
 * 3. Changing a value across sources is a conflict. The stored value stays,
 *    the incoming one is recorded, and the field is contested until someone
 *    resolves it. Last-write-wins here is how a dashboard ends up confidently
 *    wrong with nothing on screen to indicate it.
 */

export interface FieldConflict {
  field: string;
  /** The value already stored, and the source that put it there. */
  storedValue: string;
  storedSource: string;
  /** The value that just arrived, and where from. */
  incomingValue: string;
  incomingSource: string;
}

export interface MergePlan<T extends Record<string, unknown>> {
  /** The fields to actually write. Empty when the incoming data adds nothing. */
  updates: Partial<T>;
  /** Fields where two sources disagree. The stored value is kept; these are recorded for a human. */
  conflicts: FieldConflict[];
}

/**
 * How a stored row should change given an incoming one, applying the three
 * rules above.
 *
 * `fields` is explicit rather than "every key on the incoming object" so that
 * adding a column to a table cannot silently start overwriting it from a
 * connector that was never meant to own it.
 *
 * `undefined` on an incoming field means "this source did not report it",
 * which is different from `null` meaning "this source reports it as empty".
 * Only the second can clear a value, and only from the owning source — a
 * secondary source reporting a blank is not evidence that the value it does
 * not have does not exist.
 */
export function planMerge<T extends Record<string, unknown>>(
  stored: T,
  storedSource: string,
  incoming: Partial<T>,
  incomingSource: string,
  fields: readonly (keyof T & string)[],
): MergePlan<T> {
  const sameSource = storedSource === incomingSource;
  const updates: Partial<T> = {};
  const conflicts: FieldConflict[] = [];

  for (const field of fields) {
    const incomingValue = incoming[field];
    if (incomingValue === undefined) continue;

    const storedValue = stored[field];
    if (valuesMatch(storedValue, incomingValue)) continue;

    // Rule 1: a source owns what it wrote.
    if (sameSource) {
      updates[field] = incomingValue;
      continue;
    }

    // Rule 2: filling a gap is new information, not a disagreement.
    if (storedValue === null || storedValue === undefined) {
      if (incomingValue !== null) updates[field] = incomingValue;
      continue;
    }

    // Rule 3: two sources, two values. Keep what is stored, record the clash.
    if (incomingValue === null) continue;
    conflicts.push({
      field,
      storedValue: describeValue(storedValue),
      storedSource,
      incomingValue: describeValue(incomingValue),
      incomingSource,
    });
  }

  return { updates, conflicts };
}

/**
 * Whether two field values are the same for merge purposes.
 *
 * Dates compare by instant, not by identity — two `Date` objects for the same
 * moment arrive from different code paths constantly, and treating them as a
 * disagreement would flag a conflict on every synced timestamp.
 */
function valuesMatch(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** A field value as text. Dates go in as ISO so a disagreement is readable without knowing the column's type. */
export function describeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return "";
  return String(value);
}

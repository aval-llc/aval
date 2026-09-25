/**
 * Canonical serialization of a tool payload, so an approval can be bound to
 * the exact action a person saw rather than to the identity of the model
 * message that proposed it.
 *
 * `AVAL_AGENT.md` §5.4 states the contract: semantically identical payloads
 * MUST hash identically, and material changes MUST produce a different hash.
 * Those two requirements pull in opposite directions, so each rule below
 * records which one it serves.
 *
 * What is deliberately NOT normalized: whitespace inside string values. The
 * specification's phrase "normalized numbers/whitespace" is applied to the
 * serialization envelope, not to the payload's own strings. A resident-facing
 * message body differs materially when its line breaks differ, and collapsing
 * that whitespace would let an approved message be sent with a different one.
 * Structural whitespace never enters the hash because the serializer emits
 * none.
 */

/** A payload that cannot be canonicalized fails closed rather than hashing to something arbitrary. */
export class CanonicalPayloadError extends Error {}

/**
 * Deterministic JSON.
 *
 * - Object keys are sorted by UTF-16 code unit, recursively, so key order in
 *   the model's output cannot change the hash.
 * - `undefined` object values are omitted, matching `JSON.stringify`, so a key
 *   the model emitted as absent and one it emitted as `undefined` agree.
 * - `null` is retained and is distinct from absence: clearing a field is a
 *   material change.
 * - Array order is preserved and therefore material. Two recipient lists in a
 *   different order are treated as different actions; this is the safe
 *   direction to be wrong in.
 * - `-0` normalizes to `0`; `NaN` and `Infinity` are rejected rather than
 *   silently becoming `null` as `JSON.stringify` would do.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalPayloadError("A payload number must be finite to be approved.");
      }
      // Object.is distinguishes -0 from 0, which JSON.stringify does not.
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalPayloadError("A payload may not contain a bigint.");
    case "undefined":
      // Reachable only at the top level; object members are filtered below.
      throw new CanonicalPayloadError("A payload may not be undefined.");
    case "function":
    case "symbol":
      throw new CanonicalPayloadError(`A payload may not contain a ${typeof value}.`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry === undefined ? null : entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${members.join(",")}}`;
}

/**
 * SHA-256 of the canonical form, hex encoded.
 *
 * Uses WebCrypto, which is available in Workers and in Node's global scope,
 * so this module stays free of a runtime-specific import the way
 * `task-state.ts` is.
 */
export async function payloadHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

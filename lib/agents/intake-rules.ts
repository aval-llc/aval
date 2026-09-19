/**
 * Event-intake rules, with no storage dependency.
 *
 * Split from `intake.ts` (which imports `@/db`, unresolvable outside the
 * Workers/Vite build) so the parts worth testing can be exercised directly
 * with `node --test` — the same convention `task-state.ts` follows for the
 * task state machine.
 */

/**
 * The coordinator profile. `general` already exists in `permissions.ts` with
 * read-everything and no PMS write permission, and in `delegation-rules.ts` as
 * the role that delegates to specialists. Event-driven work is owned by it for
 * that reason — it is the accountable coordinator of `AVAL_AGENT.md` §11.2,
 * not a new persona.
 */
export const COORDINATOR_AGENT_ID = "general";

export type IntakeSource = "pms_seat_email" | "pms_notification" | "pms_sync" | "schedule";

export type IntakeTrustState = "verified" | "unverified" | "quarantined";

export type IntakeRefusal = { ok: false; reason: string };

/**
 * Whether an event may create work at all.
 *
 * `AVAL_AGENT.md` §7.1 and product context §30 are explicit that accepting a
 * message is not permission to act on it. Only a verified event creates work;
 * anything else stays a recorded artifact awaiting the pending-sender review.
 * This is checked before any query runs, so an unverified message never
 * reaches the database on this path.
 */
export function admissible(event: { trustState: IntakeTrustState; sourceId: string }): true | IntakeRefusal {
  if (event.trustState !== "verified") {
    return { ok: false, reason: `A ${event.trustState} message does not create work. It remains recorded for sender review.` };
  }
  if (!event.sourceId) {
    return { ok: false, reason: "An event without a stable source id cannot be deduplicated." };
  }
  return true;
}

/**
 * A stable task id for one event.
 *
 * Hex from SHA-256, shaped as a UUID so it is indistinguishable in storage
 * from the `crypto.randomUUID()` ids every other task carries. The version and
 * variant nibbles are forced so it cannot collide with a random v4.
 *
 * This is what makes a redelivered webhook, a retried sweep, or a duplicated
 * email reach the same row: `createTask` inserts with `onConflictDoNothing`,
 * so the second delivery returns the first one's task.
 */
export async function deterministicTaskId(organizationId: string, source: string, sourceId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`aval:intake:v1:${organizationId}:${source}:${sourceId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

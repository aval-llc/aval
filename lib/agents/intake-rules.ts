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

/**
 * Who owns work that no person started.
 *
 * An employee where the workspace has one that should take it, and the
 * built-in coordinator otherwise. The fallback is what keeps a workspace that
 * has not created any employees working exactly as it did.
 */
export function coordinatorFor(employeeId: string | null | undefined): { agentId: string; employeeId: string | null } {
  return { agentId: COORDINATOR_AGENT_ID, employeeId: employeeId ?? null };
}

/**
 * Where work can come from.
 *
 * Three of the original four named a PMS, which made a PMS a precondition for
 * event-driven work existing at all. That is backwards: the employee lives in
 * Aval and a PMS is one of the things it can reach, so a workspace with no PMS
 * connected must still be able to receive an email, read a document, or be
 * asked to do something, and have durable Work come of it.
 *
 * The PMS-specific values remain because existing callers name them and their
 * provenance is worth keeping — `pms_seat_email` says more than `email` does.
 */
export type IntakeSource =
  | "pms_seat_email"
  | "pms_notification"
  | "pms_sync"
  | "schedule"
  /** Mail reaching the workspace by any route that is not a PMS seat. */
  | "email"
  /** A document arriving or being uploaded. */
  | "document"
  /** A person asking for something directly. */
  | "manual"
  /** Another system calling Aval. */
  | "api";

/** Whether this kind of event needs a PMS to exist. Nothing else may assume one. */
export function requiresProvider(source: IntakeSource): boolean {
  return source === "pms_seat_email" || source === "pms_notification" || source === "pms_sync";
}

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

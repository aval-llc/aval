/**
 * Event intake: the seam that turns an authorized external event into durable
 * owned work.
 *
 * Everything downstream of this file already existed — the durable runtime
 * (`runtime.ts`), the scheduled worker that advances it
 * (`worker.ts`, driven by `lib/workers/scheduled-sweep.ts`), delegation to
 * specialists, approvals, the governed PMS write tools, and cancellation
 * cascade. What did not exist was anything that created work from a
 * PMS-originated event: `lib/pms/inbound/adjudicate.ts` authenticated a
 * message, recorded it, and returned. A verified maintenance email was stored
 * and never actioned.
 *
 * Two rules are enforced here rather than left to the caller, because both are
 * invariants rather than policy:
 *
 * 1. **Acceptance is not authority.** `AVAL_AGENT.md` §7.1 and the product
 *    context §30 are explicit that receiving a message is not permission to
 *    execute what it says. Only a `verified` trust state creates work. An
 *    unverified or quarantined message stays a recorded artifact awaiting the
 *    pending-sender review.
 * 2. **One event is one work item.** The task id is derived from
 *    (organization, source, sourceId), so a redelivered webhook, a retried
 *    sweep, or a duplicated email reaches the same row. `createTask` inserts
 *    with `onConflictDoNothing` and then re-reads, so the duplicate returns the
 *    existing task instead of creating a second one. This is the same
 *    DB-enforced discipline `reserveMutation` uses: the database objects, not a
 *    read-then-write race in application code.
 */

import { eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { organizations } from "@/db/postgres/schema";
import { createTask, getTask, type TaskRecord } from "./tasks.ts";
import { admissible, COORDINATOR_AGENT_ID, deterministicTaskId, type IntakeSource, type IntakeTrustState } from "./intake-rules.ts";

export { COORDINATOR_AGENT_ID, deterministicTaskId, admissible } from "./intake-rules.ts";
export type { IntakeSource, IntakeTrustState } from "./intake-rules.ts";

export interface IntakeEvent {
  organizationId: string;
  source: IntakeSource;
  /** Provider-stable identity of the event. A message digest, a webhook id, a sync cursor. */
  sourceId: string;
  trustState: IntakeTrustState;
  /** What the coordinator is accountable for. Stated as an outcome, not as the message's own words. */
  goal: string;
  /** Optional provider context, retained on the task's execution scope for the coordinator to read. */
  providerId?: string;
}

export type IntakeOutcome =
  | { status: "created"; task: TaskRecord }
  | { status: "attached"; task: TaskRecord }
  | { status: "refused"; reason: string };

/**
 * Creates or re-reaches the durable work for one external event.
 *
 * The returned task is `QUEUED` and owned by the coordinator. It is advanced by
 * the scheduled worker batch, so progress does not depend on anyone having a
 * chat session open.
 */
export async function intakeEvent(dbSession: DbSession, event: IntakeEvent): Promise<IntakeOutcome> {
  const admission = admissible(event);
  if (admission !== true) return { status: "refused", reason: admission.reason };

  const [organization] = await dbSession.db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, event.organizationId))
    .limit(1);

  if (!organization) {
    return { status: "refused", reason: "No such workspace." };
  }

  const id = await deterministicTaskId(event.organizationId, event.source, event.sourceId);

  // Read first so a redelivery is reported as an attachment rather than a
  // creation. The insert below is still the authority: two concurrent
  // deliveries both miss this read, and the primary key decides.
  const existing = await getTask(dbSession, event.organizationId, id);
  if (existing) return { status: "attached", task: existing };

  const task = await createTask(dbSession, {
    id,
    organizationId: event.organizationId,
    // The workspace owner is the accountable principal for work no human
    // started. Policy re-reads this on every step, so the coordinator carries
    // the owner's authority and no more.
    userId: organization.ownerUserId,
    agentId: COORDINATOR_AGENT_ID,
    goal: event.goal,
    // A plan root. `task-boundary.ts` restricts a plan root to managing its
    // plan, so the coordinator cannot perform operational work itself: it must
    // decompose the goal into checked child tasks owned by the specialists
    // that hold the domain permissions. That is the intended shape, not a
    // limitation worked around here.
    check: { kind: "plan" as const },
    executionScope: {
      source: "pms_event",
      origin: event.source,
      sourceId: event.sourceId,
      trustState: "verified",
      ...(event.providerId ? { providerId: event.providerId } : {}),
    },
  });

  // `createTask` is idempotent, so a concurrent delivery that lost the race
  // returns the winner's row rather than a second task.
  return { status: task.createdAt.getTime() === task.updatedAt.getTime() ? "created" : "attached", task };
}

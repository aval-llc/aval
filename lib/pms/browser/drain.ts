/**
 * The desktop runner's half of a customer-authorized write.
 *
 * `lib/pms/execute.ts` resolves a `ui` write, authorizes it and puts it on
 * `pms_write_queue`. Until now nothing read that table, so every such write was
 * enqueued and abandoned. This is the other end.
 *
 * The order of operations here is the whole design, and none of it is
 * rearrangeable:
 *
 *   claim under a lease        so two runners for one org cannot both submit
 *   re-resolve authority       because a grant can be withdrawn while queued
 *   re-check the flow digest   so a flow edited after approval will not replay
 *   preflight / recover        because the session is the customer's, not ours
 *   look before writing        the duplicate guard, and the reason for §14
 *   execute                    the only step that touches the provider
 *   read it back               a submitted form is not proof
 *
 * The two outcomes people get wrong are both represented here rather than
 * collapsed. A write that executed but cannot yet be read is
 * `pending_verification` — it is neither done nor failed, and the Work item
 * belongs in `PENDING_VERIFICATION` until a later read settles it. A write that
 * found an existing record is `done` with `duplicate: true` and **no submit**,
 * because the record the customer wanted already exists and creating a second
 * one is the worst available outcome.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { pmsActionFlows, pmsWriteQueue } from "@/db/postgres/schema";
import { resolveCapability } from "../capability.ts";
import type { PmsAction } from "../types.ts";
import { browserAdapter, UNREPLAYABLE, type BrowserContext, type ProviderSessionState } from "./adapter.ts";
import { flowDigest, parseFlowSteps } from "./steps.ts";

/** How long a runner holds a queued write before another may take it. */
const LEASE_MS = 2 * 60 * 1000;
/** Attempts after which a write stops being retried and waits for a person. */
const MAX_ATTEMPTS = 5;

export type DrainStatus =
  /** Nothing was waiting. */
  | "idle"
  /** Executed and read back at the provider. */
  | "done"
  /** Executed; the provider has not caught up. Work stays unproven. */
  | "pending_verification"
  /** The record was already there. Nothing was submitted. */
  | "duplicate"
  /** Could not run now, and could later. The row goes back on the queue. */
  | "deferred"
  /** Authority, the flow or the provider says no. Not retried. */
  | "denied"
  /** Ran and failed. */
  | "failed";

export interface DrainOutcome {
  status: DrainStatus;
  queueId?: string;
  action?: PmsAction;
  externalId?: string;
  reason?: string;
  session?: ProviderSessionState;
  /** True when a person has to act before this can progress. */
  needsHuman?: boolean;
}

interface ClaimedWrite {
  id: string;
  provider: string;
  action: PmsAction;
  flowId: string | null;
  payload: unknown;
  attempts: number;
}

/**
 * Take one queued write, or report that there was nothing to take.
 *
 * Claiming is a single conditional update for the same reason `claimTask` is:
 * two runners racing both issue it, PostgreSQL locks the candidate, and the
 * loser matches zero rows. There is no read-then-write window between them.
 */
async function claim(dbSession: DbSession, organizationId: string, runnerId: string): Promise<ClaimedWrite | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_MS);

  const rows = await dbSession.db.execute(sql`
    with candidate as (
      select id
      from ${pmsWriteQueue}
      where ${pmsWriteQueue.organizationId} = ${organizationId}
        and ${pmsWriteQueue.status} in ('pending', 'leased')
        and (${pmsWriteQueue.leaseExpiresAt} is null or ${pmsWriteQueue.leaseExpiresAt} < ${now})
        and ${pmsWriteQueue.attempts} < ${MAX_ATTEMPTS}
      order by ${pmsWriteQueue.createdAt} asc
      limit 1
      for update skip locked
    )
    update ${pmsWriteQueue} as queued
    set status = 'leased', leased_by = ${runnerId}, lease_expires_at = ${expiresAt},
        attempts = queued.attempts + 1, updated_at = ${now}
    from candidate
    where queued.id = candidate.id
    returning queued.id, queued.provider, queued.action, queued.flow_id, queued.payload_json, queued.attempts
  `);

  const row = (rows as unknown as { rows?: Record<string, unknown>[] }).rows?.[0]
    ?? (Array.isArray(rows) ? (rows as Record<string, unknown>[])[0] : undefined);
  if (!row) return null;

  // `payload_json` is a jsonb column, so the driver hands back a parsed value
  // already. It is read as either shape because the same column is written as
  // text by the D1 schema this was ported from, and a `JSON.parse` over an
  // object yields "[object Object]" — which throws, and silently cost the
  // duplicate guard every field it matches on.
  const raw = row.payload_json;
  let payload: unknown = null;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  } else if (raw && typeof raw === "object") {
    payload = raw;
  }

  return {
    id: String(row.id),
    provider: String(row.provider),
    action: String(row.action) as PmsAction,
    flowId: row.flow_id === null || row.flow_id === undefined ? null : String(row.flow_id),
    payload,
    attempts: Number(row.attempts ?? 0),
  };
}

async function settle(
  dbSession: DbSession,
  organizationId: string,
  queueId: string,
  status: "done" | "failed" | "abandoned" | "pending",
  lastError: string | null,
): Promise<void> {
  await dbSession.db
    .update(pmsWriteQueue)
    .set({
      status,
      lastError,
      // Released on every settlement. A row left holding a lease it is no longer
      // working on is a row nothing else will pick up for two minutes.
      leasedBy: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    // Scoped by organization as well as by id. The id is a UUID and unguessable,
    // which is an argument for it being hard to reach another tenant's row and
    // not an argument for the query being allowed to. `tests/org-scoping-isolation.test.ts`
    // enforces the difference, and it caught this one.
    .where(and(eq(pmsWriteQueue.organizationId, organizationId), eq(pmsWriteQueue.id, queueId)));
}

/**
 * Drain one customer-authorized write.
 *
 * `organizationId` scopes the claim, and `runnerId` identifies the desktop
 * instance holding it — both are the caller's, never the model's.
 */
export async function drainOneWrite(
  dbSession: DbSession,
  organizationId: string,
  runnerId: string,
): Promise<DrainOutcome> {
  const claimed = await claim(dbSession, organizationId, runnerId);
  if (!claimed) return { status: "idle" };

  const ctx: BrowserContext = { organizationId, providerId: claimed.provider, runnerId };
  const base = { queueId: claimed.id, action: claimed.action };

  // Authority, again. Assembly and `executePmsWrite` both checked it, and a
  // queued write can sit here for hours — long enough for a workspace to
  // disable the action or a grant to lapse. Same-day revocation has to mean
  // the queue too, or it only means the next turn.
  const resolution = await resolveCapability(dbSession, organizationId, claimed.provider, claimed.action);
  if (resolution.state !== "allow") {
    await settle(dbSession, organizationId, claimed.id, "abandoned", resolution.reason ?? `Capability is ${resolution.state}.`);
    return { ...base, status: "denied", reason: resolution.reason ?? `This action is ${resolution.state} for this workspace.` };
  }

  const adapter = browserAdapter(claimed.provider);
  if (!adapter || !adapter.supports(claimed.action)) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "No browser workflow is implemented for this action.");
    return { ...base, status: "denied", reason: "No browser workflow is implemented for this action." };
  }

  // The flow, and proof it is the one that was approved.
  if (!claimed.flowId) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The queued write names no flow.");
    return { ...base, status: "denied", reason: "The queued write names no flow." };
  }
  const [flowRow] = await dbSession.db
    .select({
      stepsJson: pmsActionFlows.stepsJson,
      digest: pmsActionFlows.digest,
      status: pmsActionFlows.status,
    })
    .from(pmsActionFlows)
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, claimed.flowId)))
    .limit(1);

  if (!flowRow || flowRow.status !== "active") {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow is no longer active.");
    return { ...base, status: "denied", reason: "The flow this write was approved against is no longer active." };
  }

  let steps;
  try {
    steps = parseFlowSteps(JSON.parse(flowRow.stepsJson));
  } catch (error) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow could not be read.");
    return { ...base, status: "denied", reason: error instanceof Error ? error.message : "The flow could not be read." };
  }

  // An approval binds to the digest. A flow edited afterwards is a different
  // flow, and replaying it would run something nobody approved.
  if (await flowDigest(steps) !== flowRow.digest) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow changed after it was approved.");
    return { ...base, status: "denied", reason: "The flow changed after it was approved, so it was not replayed." };
  }

  // The session is the customer's own. Where it has lapsed the runner may sign
  // back in; where the provider wants an authenticator code, a person has to.
  let preflight = await adapter.preflight(ctx);
  if (!preflight.ready && !UNREPLAYABLE.has(preflight.session)) {
    const recovery = await adapter.recoverSession(ctx);
    preflight = recovery.recovered
      ? await adapter.preflight(ctx)
      : { ready: false, session: recovery.session, reason: recovery.reason };
  }
  if (!preflight.ready) {
    const needsHuman = UNREPLAYABLE.has(preflight.session);
    await settle(dbSession, organizationId, claimed.id, needsHuman ? "abandoned" : "pending", preflight.reason ?? "Not ready.");
    return {
      ...base,
      status: needsHuman ? "denied" : "deferred",
      reason: preflight.reason,
      session: preflight.session,
      needsHuman,
    };
  }

  // Look before writing. A previous attempt may have submitted successfully and
  // lost the answer; this is the only thing standing between that and a second
  // work order. An adapter that cannot look throws, and a throw defers rather
  // than proceeding blind.
  try {
    const existing = await adapter.findExisting(claimed.action, claimed.payload, ctx);
    if (existing) {
      await settle(dbSession, organizationId, claimed.id, "done", null);
      return {
        ...base,
        status: "duplicate",
        externalId: existing.externalId,
        reason: `The provider already holds this record (matched on ${existing.matchedOn.join(", ")}). Nothing was submitted.`,
        session: preflight.session,
      };
    }
  } catch (error) {
    await settle(dbSession, organizationId, claimed.id, "pending", "The duplicate check could not be completed.");
    return {
      ...base,
      status: "deferred",
      reason: error instanceof Error ? error.message : "The duplicate check could not be completed.",
    };
  }

  const execution = await adapter.execute(claimed.action, steps, claimed.payload, ctx);
  if (!execution.ok) {
    const exhausted = claimed.attempts >= MAX_ATTEMPTS;
    const retryable = execution.retryable === true && !exhausted;
    await settle(dbSession, organizationId, claimed.id, retryable ? "pending" : "failed", execution.error ?? "The workflow did not complete.");
    return {
      ...base,
      status: retryable ? "deferred" : "failed",
      reason: execution.error,
      session: execution.session,
      needsHuman: !retryable,
    };
  }

  // The only step that turns a submitted form into a fact.
  const verification = await adapter.verify(claimed.action, execution, claimed.payload, ctx);
  if (verification.confirmed) {
    await settle(dbSession, organizationId, claimed.id, "done", null);
    return {
      ...base,
      status: "done",
      externalId: verification.externalId ?? execution.externalId,
      session: execution.session,
    };
  }

  if (verification.pending) {
    // The write happened. The queue's job is finished and the proof is not, so
    // the row settles and the Work item is the thing that stays unproven.
    await settle(dbSession, organizationId, claimed.id, "done", null);
    return {
      ...base,
      status: "pending_verification",
      externalId: execution.externalId,
      reason: verification.detail ?? "The provider has not caught up yet.",
      session: execution.session,
    };
  }

  // Submitted, and the provider says the record is not there. That is a
  // failure even though the browser reported success, which is the entire
  // reason verification is a separate step.
  await settle(dbSession, organizationId, claimed.id, "failed", verification.detail ?? "The record could not be found after the write.");
  return {
    ...base,
    status: "failed",
    reason: verification.detail ?? "The provider does not show the record after the write.",
    session: execution.session,
    needsHuman: true,
  };
}

/** Drain until the queue is empty or `limit` writes have been handled. */
export async function drainWrites(
  dbSession: DbSession,
  organizationId: string,
  runnerId: string,
  limit = 10,
): Promise<DrainOutcome[]> {
  const outcomes: DrainOutcome[] = [];
  for (let index = 0; index < limit; index += 1) {
    const outcome = await drainOneWrite(dbSession, organizationId, runnerId);
    if (outcome.status === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

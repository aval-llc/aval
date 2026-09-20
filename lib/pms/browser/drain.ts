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
import {
  browserAdapter, UNREPLAYABLE,
  type BrowserContext, type ExecutionResult, type ProviderSessionState, type VerificationResult,
} from "./adapter.ts";
import { flowDigest, parseFlowSteps, type FlowStep } from "./steps.ts";
import { awaitsProvider, needsPerson, recordConnectionHealth, stateForSession, type ConnectionState } from "./health.ts";
import { appendAuditEvents } from "../../audit/log.ts";
import type { AuditEntryKind } from "../../audit/chain.ts";
import { payloadHash } from "../../agents/canonical-payload.ts";

/**
 * Record one moment of a provider browser execution.
 *
 * Never throws. A write that happened and an audit line that did not is bad; a
 * write refused *because* the audit line failed would be worse, and the chain
 * verifier already reports gaps. The digest covers the subject, never the
 * payload itself.
 */
async function trail(
  dbSession: DbSession,
  organizationId: string,
  kind: AuditEntryKind,
  label: string,
  subject: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAuditEvents(dbSession, organizationId, [{
      kind,
      label,
      payloadDigest: await payloadHash(subject),
      count: 1,
    }]);
  } catch {
    /* The chain verifier reports gaps; losing a line must not lose a write. */
  }
}

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
  /** What this outcome implies about the connection, for the settings panel. */
  connection?: ConnectionState;
  /**
   * True when a person has to act before this can progress.
   *
   * A lapsed session is deliberately *not* one of these: somebody signing back
   * in resumes the work, so the objective waits for the provider rather than
   * being handed over. Only the states that do not resolve by waiting — a
   * refused role, a changed page — reach a person.
   */
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
export interface RunnerInstruction {
  queueId: string;
  provider: string;
  action: PmsAction;
  /**
   * The closed, reviewable step vocabulary — never arbitrary browser commands.
   * Cloud tells the runner *which authorized workflow* to replay, and the
   * runner has no way to be told "navigate here and click that" outside it.
   */
  steps: FlowStep[];
  payload: unknown;
  flowVersion: number;
}

export type ClaimResult =
  | { instruction: RunnerInstruction }
  /** Nothing to do, or the claim was settled without the runner acting. */
  | { outcome: DrainOutcome };

/**
 * Cloud's half: take one queued write and hand the runner an authorized
 * instruction, or settle it without involving the runner at all.
 *
 * Everything that decides *whether* a write may happen lives here, on the side
 * that holds the database and the policy. The runner receives a provider, an
 * action and a recorded workflow; it cannot widen any of them, and there is no
 * shape in which cloud could send it a browser command that is not a step of an
 * approved flow.
 */
export async function claimForRunner(
  dbSession: DbSession,
  organizationId: string,
  runnerId: string,
): Promise<ClaimResult> {
  const claimed = await claim(dbSession, organizationId, runnerId);
  if (!claimed) return { outcome: { status: "idle" } };

  const base = { queueId: claimed.id, action: claimed.action };

  // Authority, again. Assembly and `executePmsWrite` both checked it, and a
  // queued write can sit here for hours — long enough for a workspace to
  // disable the action or a grant to lapse. Same-day revocation has to mean
  // the queue too, or it only means the next turn.
  const resolution = await resolveCapability(dbSession, organizationId, claimed.provider, claimed.action);
  if (resolution.state !== "allow") {
    await settle(dbSession, organizationId, claimed.id, "abandoned", resolution.reason ?? `Capability is ${resolution.state}.`);
    return { outcome: { ...base, status: "denied", reason: resolution.reason ?? `This action is ${resolution.state} for this workspace.` } };
  }

  if (!claimed.flowId) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The queued write names no flow.");
    return { outcome: { ...base, status: "denied", reason: "The queued write names no flow." } };
  }
  const [flowRow] = await dbSession.db
    .select({
      stepsJson: pmsActionFlows.stepsJson,
      digest: pmsActionFlows.digest,
      status: pmsActionFlows.status,
      version: pmsActionFlows.version,
    })
    .from(pmsActionFlows)
    .where(and(eq(pmsActionFlows.organizationId, organizationId), eq(pmsActionFlows.id, claimed.flowId)))
    .limit(1);

  if (!flowRow || flowRow.status !== "active") {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow is no longer active.");
    return { outcome: { ...base, status: "denied", reason: "The flow this write was approved against is no longer active." } };
  }

  let steps: FlowStep[];
  try {
    steps = parseFlowSteps(JSON.parse(flowRow.stepsJson));
  } catch (error) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow could not be read.");
    return { outcome: { ...base, status: "denied", reason: error instanceof Error ? error.message : "The flow could not be read." } };
  }

  // An approval binds to the digest. A flow edited afterwards is a different
  // flow, and replaying it would run something nobody approved.
  if (await flowDigest(steps) !== flowRow.digest) {
    await settle(dbSession, organizationId, claimed.id, "abandoned", "The flow changed after it was approved.");
    return { outcome: { ...base, status: "denied", reason: "The flow changed after it was approved, so it was not replayed." } };
  }

  await trail(dbSession, organizationId, "provider_work_claimed", `${claimed.provider}:${claimed.action}`, {
    queueId: claimed.id, runnerId, flowVersion: flowRow.version,
  });

  return {
    instruction: {
      queueId: claimed.id,
      provider: claimed.provider,
      action: claimed.action,
      steps,
      payload: claimed.payload,
      flowVersion: flowRow.version,
    },
  };
}

/**
 * What the runner may say about a claimed write.
 *
 * A closed set, because this crosses a trust boundary in the other direction:
 * the runner is the customer's own machine reporting on a provider neither side
 * controls. It reports what happened; it never reports what should follow.
 */
export type RunnerReport =
  /** The provider session is not usable. Nothing was attempted. */
  | { queueId: string; kind: "not_ready"; session: ProviderSessionState; reason?: string }
  /** The record was already at the provider. Nothing was submitted. */
  | { queueId: string; kind: "duplicate"; externalId: string; matchedOn: string[] }
  /** The workflow ran. `verification` is the provider read back afterwards. */
  | { queueId: string; kind: "executed"; execution: ExecutionResult; verification: VerificationResult };

/**
 * Cloud's other half: record what the runner did and settle the queue.
 *
 * The lease is re-checked against this runner and this organization before
 * anything is written. A report naming a row the caller does not hold is not an
 * error to recover from, it is someone reporting on work that is not theirs.
 */
export async function reportRunnerResult(
  dbSession: DbSession,
  organizationId: string,
  runnerId: string,
  report: RunnerReport,
): Promise<DrainOutcome> {
  const [row] = await dbSession.db
    .select({
      id: pmsWriteQueue.id,
      action: pmsWriteQueue.action,
      provider: pmsWriteQueue.provider,
      attempts: pmsWriteQueue.attempts,
      leasedBy: pmsWriteQueue.leasedBy,
      leaseExpiresAt: pmsWriteQueue.leaseExpiresAt,
      status: pmsWriteQueue.status,
    })
    .from(pmsWriteQueue)
    .where(and(eq(pmsWriteQueue.organizationId, organizationId), eq(pmsWriteQueue.id, report.queueId)))
    .limit(1);

  if (!row) return { status: "denied", reason: "No such queued write for this workspace." };
  if (row.leasedBy !== runnerId || row.status !== "leased") {
    return { status: "denied", queueId: row.id, reason: "This write is not leased by this runner." };
  }
  if ((row.leaseExpiresAt?.getTime() ?? 0) < Date.now()) {
    // The lease lapsed while the runner worked. Reporting is refused rather
    // than applied, because another runner may already hold it — and two
    // reports settling one row is how a duplicate becomes invisible.
    return { status: "denied", queueId: row.id, reason: "The lease on this write expired before it was reported." };
  }

  const action = row.action as PmsAction;
  const base = { queueId: row.id, action };

  // Every report says something about the session, including the ones that say
  // it is fine. A connection whose health is only written on failure looks
  // broken forever after one bad afternoon.
  const observed = report.kind === "not_ready"
    ? report.session
    : report.kind === "duplicate" ? "ACTIVE" as const : report.execution.session;
  const connection = stateForSession(observed);
  await recordConnectionHealth(dbSession, organizationId, row.provider, {
    state: connection,
    detail: report.kind === "not_ready" ? report.reason : undefined,
    runnerId,
    // A completed provider operation, not a successful poll. Finding an
    // existing record counts: it means the device read the provider.
    verified: report.kind === "duplicate" || (report.kind === "executed" && report.execution.ok),
  });

  if (report.kind === "not_ready") {
    // Waiting is decided by whether the state resolves on its own. A session
    // that lapsed comes back when somebody signs in; a refused role does not.
    const waits = awaitsProvider(connection);
    await trail(dbSession, organizationId, "provider_session_unavailable", `${row.provider}:${connection}`, {
      queueId: row.id, runnerId, session: report.session,
    });
    if (needsPerson(connection)) {
      await trail(dbSession, organizationId, "provider_human_handoff", `${row.provider}:${connection}`, {
        queueId: row.id, runnerId,
      });
    }
    await settle(dbSession, organizationId, row.id, waits ? "pending" : "abandoned", report.reason ?? "Not ready.");
    return {
      ...base,
      status: waits ? "deferred" : "denied",
      reason: report.reason,
      session: report.session,
      connection,
      // Both are reported. A lapsed session is work that waits *and* a person
      // who has to sign in; saying only one of those strands the other.
      needsHuman: needsPerson(connection),
    };
  }

  if (report.kind === "duplicate") {
    await trail(dbSession, organizationId, "provider_duplicate_reconciled", `${row.provider}:${action}`, {
      queueId: row.id, runnerId, externalId: report.externalId,
    });
    await settle(dbSession, organizationId, row.id, "done", null);
    return {
      ...base,
      status: "duplicate",
      connection,
      externalId: report.externalId,
      reason: `The provider already holds this record (matched on ${report.matchedOn.join(", ")}). Nothing was submitted.`,
    };
  }

  const { execution, verification } = report;
  if (!execution.ok) {
    await trail(
      dbSession, organizationId,
      connection === "UI_CHANGED" ? "provider_flow_broken" : "provider_execution_failed",
      `${row.provider}:${action}`,
      { queueId: row.id, runnerId, session: execution.session },
    );
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    const retryable = execution.retryable === true && !exhausted;
    // The handoff is its own line wherever it happens, so "who has this now"
    // can be answered from the chain without reading the failure reasons and
    // deciding which of them implied a person.
    if (needsPerson(connection) || !retryable) {
      await trail(dbSession, organizationId, "provider_human_handoff", `${row.provider}:${action}`, {
        queueId: row.id, runnerId, session: execution.session,
      });
    }
    await settle(dbSession, organizationId, row.id, retryable ? "pending" : "failed", execution.error ?? "The workflow did not complete.");
    return {
      ...base,
      status: retryable ? "deferred" : "failed",
      connection,
      reason: execution.error,
      session: execution.session,
      // Retryable and needing a person are not opposites. A session that died
      // part-way through is worth retrying *and* nobody can retry it until the
      // customer signs in, so both are reported.
      needsHuman: needsPerson(connection) || !retryable,
    };
  }

  await trail(dbSession, organizationId, "provider_execution_completed", `${row.provider}:${action}`, {
    queueId: row.id, runnerId, externalId: execution.externalId,
  });

  if (verification.confirmed) {
    await trail(dbSession, organizationId, "provider_verification_confirmed", `${row.provider}:${action}`, {
      queueId: row.id, externalId: verification.externalId ?? execution.externalId,
    });
    await settle(dbSession, organizationId, row.id, "done", null);
    return { ...base, status: "done", externalId: verification.externalId ?? execution.externalId, session: execution.session, connection };
  }

  if (verification.pending) {
    await trail(dbSession, organizationId, "provider_verification_inconclusive", `${row.provider}:${action}`, {
      queueId: row.id, externalId: execution.externalId,
    });
    // The write happened. The queue's job is finished and the proof is not, so
    // the row settles and the Work item is the thing that stays unproven.
    await settle(dbSession, organizationId, row.id, "done", null);
    return {
      ...base,
      status: "pending_verification",
      connection,
      externalId: execution.externalId,
      reason: verification.detail ?? "The provider has not caught up yet.",
      session: execution.session,
    };
  }

  // Submitted, and the provider says the record is not there. That is a failure
  // even though the browser reported success, which is the entire reason
  // verification is a separate step.
  await trail(dbSession, organizationId, "provider_verification_contradicted", `${row.provider}:${action}`, {
    queueId: row.id, externalId: execution.externalId,
  });
  await trail(dbSession, organizationId, "provider_human_handoff", `${row.provider}:${action}`, { queueId: row.id });
  await settle(dbSession, organizationId, row.id, "failed", verification.detail ?? "The record could not be found after the write.");
  return {
    ...base,
    status: "failed",
    reason: verification.detail ?? "The provider does not show the record after the write.",
    session: execution.session,
    connection,
    needsHuman: true,
  };
}

/**
 * One write, claimed and carried out.
 *
 * This is exactly what the desktop runner does, with the two halves co-located:
 * `claimForRunner` over the API, the adapter against the provider, then
 * `reportRunnerResult`. It exists as one function so the composition can be
 * exercised without a network, and it is the same composition — not a
 * test-only shortcut around it.
 */
export async function drainOneWrite(
  dbSession: DbSession,
  organizationId: string,
  runnerId: string,
): Promise<DrainOutcome> {
  const claimed = await claimForRunner(dbSession, organizationId, runnerId);
  if ("outcome" in claimed) return claimed.outcome;

  const instruction = claimed.instruction;
  const report = await runInstruction(instruction, { organizationId, providerId: instruction.provider, runnerId });
  return reportRunnerResult(dbSession, organizationId, runnerId, report);
}

/**
 * The runner's half: everything that touches the provider, and nothing that
 * decides whether it may be touched.
 *
 * Exported because the desktop process runs precisely this against the
 * instruction it fetched, and a second implementation there would be a second
 * set of rules about when a duplicate counts.
 */
export async function runInstruction(
  instruction: RunnerInstruction,
  ctx: BrowserContext,
): Promise<RunnerReport> {
  const adapter = browserAdapter(instruction.provider);
  if (!adapter || !adapter.supports(instruction.action)) {
    return {
      queueId: instruction.queueId,
      kind: "not_ready",
      session: "BLOCKED",
      reason: "This runner has no workflow for that action.",
    };
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
    return { queueId: instruction.queueId, kind: "not_ready", session: preflight.session, reason: preflight.reason };
  }

  // Look before writing. A previous attempt may have submitted successfully and
  // lost the answer; this is the only thing standing between that and a second
  // work order. An adapter that cannot look throws, and a throw defers rather
  // than proceeding blind.
  try {
    const existing = await adapter.findExisting(instruction.action, instruction.payload, ctx);
    if (existing) {
      return {
        queueId: instruction.queueId,
        kind: "duplicate",
        externalId: existing.externalId,
        matchedOn: existing.matchedOn,
      };
    }
  } catch (error) {
    return {
      queueId: instruction.queueId,
      kind: "not_ready",
      session: "EXPIRED",
      reason: error instanceof Error ? error.message : "The duplicate check could not be completed.",
    };
  }

  const execution = await adapter.execute(instruction.action, instruction.steps, instruction.payload, ctx);
  const verification = execution.ok
    ? await adapter.verify(instruction.action, execution, instruction.payload, ctx)
    : { confirmed: false };

  return { queueId: instruction.queueId, kind: "executed", execution, verification };
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

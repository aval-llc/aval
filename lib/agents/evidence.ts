/**
 * Evidence for external effects, and the comparison that closes them.
 *
 * `PENDING_VERIFICATION` existed before this module but could only ever end by
 * exhausting its budget into a human handoff. That is honest and it is not
 * verification. Here an action's claim is compared against an independent
 * observation, and the task completes only when something other than Aval's own
 * optimism says the effect took hold.
 *
 * The comparison is deliberately deterministic. A model may summarise evidence;
 * it may not decide whether evidence is sufficient.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { actionEvidence } from "@/db/postgres/schema";

export const EVIDENCE_TYPES = ["provider_reread", "provider_event", "human_confirmation", "document", "aval_native"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type VerificationResult = "confirmed" | "contradicted" | "inconclusive";

/** The verdict for a whole execution, as distinct from one observation. */
export type ExecutionVerdict = "confirmed" | "contradicted" | "unproven";

export interface EvidenceInput {
  organizationId: string;
  taskId: string;
  /** The idempotency key the executor reserved. One execution, however many observations. */
  actionExecutionId: string;
  toolName: string;
  claim: string;
  expectedState: Record<string, unknown>;
  evidenceType: EvidenceType;
  sourceProvider?: string | null;
  externalRecordId?: string | null;
  observedState: Record<string, unknown>;
  observedAt?: Date | null;
  payloadRef?: string | null;
}

/**
 * Compares what the action expected against what was observed.
 *
 * Every key the action expected must be present and equal. A missing key is
 * `inconclusive` — the observation did not cover it — while a present and
 * different value is `contradicted`. Conflating the two would let a partial
 * read masquerade as proof of failure.
 */
export function compareStates(
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
): VerificationResult {
  const keys = Object.keys(expected);
  if (keys.length === 0) return "inconclusive";
  let sawEvery = true;
  for (const key of keys) {
    if (!(key in observed)) { sawEvery = false; continue; }
    if (JSON.stringify(observed[key]) !== JSON.stringify(expected[key])) return "contradicted";
  }
  return sawEvery ? "confirmed" : "inconclusive";
}

/**
 * Stores one observation.
 *
 * The unique index absorbs a webhook delivered twice, or a scheduled re-read
 * racing one: the same observation of the same execution is one row.
 */
export async function recordEvidence(dbSession: DbSession, input: EvidenceInput): Promise<VerificationResult> {
  const verificationResult = compareStates(input.expectedState, input.observedState);
  await dbSession.db.insert(actionEvidence).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    taskId: input.taskId,
    actionExecutionId: input.actionExecutionId,
    toolName: input.toolName,
    claim: input.claim,
    expectedStateJson: JSON.stringify(input.expectedState),
    evidenceType: input.evidenceType,
    sourceProvider: input.sourceProvider ?? null,
    externalRecordId: input.externalRecordId ?? null,
    observedStateJson: JSON.stringify(input.observedState),
    observedAt: input.observedAt ?? null,
    verificationResult,
    payloadRef: input.payloadRef ?? null,
    createdAt: new Date(),
  }).onConflictDoNothing();
  return verificationResult;
}

/**
 * The verdict for one execution.
 *
 * `contradicted` wins over `confirmed`: evidence that the effect did not take
 * hold is not cancelled by an earlier optimistic read. Anything short of a
 * positive confirmation is `unproven`, which is the answer that keeps a task
 * out of `COMPLETED`.
 */
export async function executionVerdict(
  dbSession: DbSession,
  organizationId: string,
  actionExecutionId: string,
): Promise<ExecutionVerdict> {
  const rows = await dbSession.db
    .select({ result: actionEvidence.verificationResult })
    .from(actionEvidence)
    .where(and(
      eq(actionEvidence.organizationId, organizationId),
      eq(actionEvidence.actionExecutionId, actionExecutionId),
    ));
  if (rows.some((row) => row.result === "contradicted")) return "contradicted";
  if (rows.some((row) => row.result === "confirmed")) return "confirmed";
  return "unproven";
}

/** Every observation recorded for one task, for the trace a person reads. */
export async function evidenceForTask(dbSession: DbSession, organizationId: string, taskId: string) {
  return dbSession.db
    .select()
    .from(actionEvidence)
    .where(and(eq(actionEvidence.organizationId, organizationId), eq(actionEvidence.taskId, taskId)));
}

/* ── provider re-read ──────────────────────────────────────────────────────── */

/**
 * Reads the current state of an object Aval created or changed.
 *
 * Returns null when the object cannot be found, which is not the same as
 * observing that it is absent: a provider that is down, rate-limiting, or
 * eventually consistent also returns null, and treating that as proof of
 * failure would be exactly the overconfidence this module exists to prevent.
 */
export type ProviderVerifier = (
  dbSession: DbSession,
  request: { organizationId: string; providerId: string; toolName: string; externalRecordId: string },
) => Promise<Record<string, unknown> | null>;

const VERIFIERS = new Map<string, ProviderVerifier>();

const verifierKey = (providerId: string, toolName: string) => `${providerId}:${toolName}`;

export function registerVerifier(providerId: string, toolName: string, verifier: ProviderVerifier): void {
  VERIFIERS.set(verifierKey(providerId, toolName), verifier);
}

export function providerVerifier(providerId: string, toolName: string): ProviderVerifier | undefined {
  return VERIFIERS.get(verifierKey(providerId, toolName));
}

export function hasVerifier(providerId: string, toolName: string): boolean {
  return VERIFIERS.has(verifierKey(providerId, toolName));
}

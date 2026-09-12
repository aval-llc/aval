/** Durable financial operation ledger and scheduled reconciliation. */

import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentFinancialEvents, agentFinancialOperations } from "@/db/postgres/schema";
import { providerJson, ProviderHttpError } from "@/lib/integrations/http";
import { digestPayload } from "@/lib/audit/chain";
import { fingerprintAccount } from "./execution-policy.ts";
import { financialReservationStatement, type FinancialReservationRow } from "./financial-reservation-sql.ts";
import {
  compareFinancialState,
  projectProviderReport,
  reconciliationBackoffMs,
  validateFinancialToolResult,
  type ExternalFinancialState,
} from "./reconciliation-rules.ts";

export type FinancialOperationRecord = typeof agentFinancialOperations.$inferSelect;

export async function reserveFinancialOperation(dbSession: DbSession, input: {
  organizationId: string;
  taskId: string;
  approvalId?: string;
  stepIndex: number;
  toolName: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  accountFingerprint: string;
  dailyLimitCents: number;
}): Promise<{ ok: true; operation: FinancialOperationRecord } | { ok: false; duplicate: boolean; reason: "duplicate" | "daily_limit" | "storage" }> {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const row: FinancialReservationRow = {
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    taskId: input.taskId,
    approvalId: input.approvalId ?? null,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    idempotencyKey: input.idempotencyKey,
    amountCents: input.amountCents,
    currency: input.currency,
    accountFingerprint: input.accountFingerprint,
    status: "reserved",
    reconciliationStatus: "pending",
    externalTransactionId: null,
    resultDigest: null,
    discrepancyCode: null,
    reconcileAttempts: 0,
    // The provider call has a 30-second ceiling. Waiting two minutes prevents
    // the cron from racing the still-in-flight side effect; if the executor
    // died, the delayed read-back safely classifies the unknown outcome.
    nextReconcileAt: new Date(now.getTime() + 2 * 60_000),
    lastReconciledAt: null,
    reconcileLeaseOwner: null,
    reconcileLeaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    settledAt: null,
  };
  await dbSession.db.execute(sql`select aval_private.lock_organization(${input.organizationId})`);
  const inserted = await dbSession.db.execute(financialReservationStatement(row, { dailyLimitCents: input.dailyLimitCents, since }));
  if (inserted.rowCount !== 1) {
    // The cap predicate is evaluated before the unique index can object, so a
    // retry of an operation that is already reserved can fail the cap on its
    // own committed amount. Check identity before reporting a limit breach.
    if (await keyAlreadyReserved(dbSession, input.idempotencyKey)) {
      return { ok: false, duplicate: true, reason: "duplicate" };
    }
    return { ok: false, duplicate: false, reason: "daily_limit" };
  }
  await appendFinancialEvent(dbSession, row.id, input.organizationId, "reserved", await digestPayload({
    taskId: input.taskId,
    stepIndex: input.stepIndex,
    toolName: input.toolName,
    amountCents: input.amountCents,
    currency: input.currency,
    accountFingerprint: input.accountFingerprint,
  }));
  return { ok: true, operation: row };
}

/** The unique index on the key is the authority on whether this already ran. */
async function keyAlreadyReserved(dbSession: DbSession, idempotencyKey: string): Promise<boolean> {
  const [existing] = await dbSession.db.select({ id: agentFinancialOperations.id })
    .from(agentFinancialOperations)
    .where(eq(agentFinancialOperations.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing !== undefined;
}

/**
 * A provider call is recorded as submitted even when the provider says
 * "settled". Only an independent read-back can settle Aval's projection.
 * Missing output is `unknown`, never `failed`: the side effect may have
 * happened.
 */
export async function recordFinancialToolResult(dbSession: DbSession,
  operationId: string,
  organizationId: string,
  result: unknown
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const validated = validateFinancialToolResult(result);
  const now = new Date();
  const resultDigest = await digestPayload(result);
  if (!validated.ok) {
    await dbSession.db.update(agentFinancialOperations).set({
      status: "unknown",
      reconciliationStatus: "manual_review",
      discrepancyCode: "invalid_provider_result",
      resultDigest,
      updatedAt: now,
    }).where(and(eq(agentFinancialOperations.id, operationId), eq(agentFinancialOperations.organizationId, organizationId)));
    await appendFinancialEvent(dbSession, operationId, organizationId, "provider_result_invalid", resultDigest);
    return validated;
  }

  const projection = projectProviderReport(validated.status);
  await dbSession.db.update(agentFinancialOperations).set({
    // Even a provider-reported settlement remains submitted until the
    // independent reconciliation adapter reads and matches it.
    status: projection.operationStatus,
    reconciliationStatus: "pending",
    externalTransactionId: validated.externalTransactionId,
    resultDigest,
    nextReconcileAt: now,
    updatedAt: now,
    settledAt: null,
  }).where(and(eq(agentFinancialOperations.id, operationId), eq(agentFinancialOperations.organizationId, organizationId)));
  await appendFinancialEvent(dbSession, operationId, organizationId, projection.eventKind, resultDigest, validated.externalTransactionId);
  return { ok: true };
}

export interface ReconciliationAdapter {
  lookup(operation: FinancialOperationRecord): Promise<ExternalFinancialState | "not_found">;
}

export interface ReconciliationEnv {
  STRIPE_SECRET_KEY?: string;
}

/** Reconcile all due operations with independent provider reads. */
export async function reconcileDueFinancialOperations(dbSession: DbSession, env: ReconciliationEnv, limit = 25): Promise<{ checked: number; matched: number; discrepancies: number; deferred: number }> {
  const now = new Date();
  const workerId = `reconcile_${crypto.randomUUID()}`;
  const operations = await dbSession.db.select().from(agentFinancialOperations)
    .where(and(
      inArray(agentFinancialOperations.reconciliationStatus, ["pending", "provider_unavailable"]),
      lte(agentFinancialOperations.nextReconcileAt, now),
      or(isNull(agentFinancialOperations.reconcileLeaseExpiresAt), lt(agentFinancialOperations.reconcileLeaseExpiresAt, now)),
    ))
    .orderBy(asc(agentFinancialOperations.nextReconcileAt))
    .limit(limit);
  let matched = 0;
  let discrepancies = 0;
  let deferred = 0;
  let checked = 0;

  for (const operation of operations) {
    if (!(await claimReconciliation(dbSession, operation, workerId, new Date()))) continue;
    checked++;
    const adapter = adapterFor(operation, env);
    if (!adapter || !operation.externalTransactionId) {
      deferred++;
      await deferReconciliation(dbSession, operation, workerId, adapter ? "external_id_missing" : "provider_unavailable", new Date());
      continue;
    }
    try {
      // Persist the lease before contacting Stripe, then resume under a fresh
      // transaction to record the independently observed state.
      const observed = await dbSession.outsideTransaction(() => adapter.lookup(operation));
      if (observed === "not_found") {
        if (await writeReconciliation(dbSession, operation, workerId, { status: "mismatch", code: "external_transaction_not_found" }, new Date())) discrepancies++;
        else deferred++;
        continue;
      }
      const verdict = compareFinancialState(operation, observed);
      const recorded = await writeReconciliation(dbSession, operation, workerId, verdict, new Date(), observed.externalTransactionId);
      if (!recorded) deferred++;
      else if (verdict.status === "matched") matched++;
      else if (verdict.status === "mismatch" || verdict.status === "manual_review") discrepancies++;
      else deferred++;
    } catch (error) {
      deferred++;
      console.error("agent_reconciliation_provider_error", { operationId: operation.id, tool: operation.toolName, error });
      await deferReconciliation(dbSession, operation, workerId, "provider_error", new Date());
    }
  }
  return { checked, matched, discrepancies, deferred };
}

function adapterFor(operation: FinancialOperationRecord, env: ReconciliationEnv): ReconciliationAdapter | null {
  if (operation.toolName !== "issue_payment" || !env.STRIPE_SECRET_KEY) return null;
  return stripeTransferAdapter(env.STRIPE_SECRET_KEY);
}

/** Independent Stripe transfer read-back: amount, currency and destination must all match. */
export function stripeTransferAdapter(secret: string): ReconciliationAdapter {
  return {
    async lookup(operation) {
      const id = operation.externalTransactionId;
      if (!id || !/^tr_[A-Za-z0-9]+$/.test(id)) return "not_found";
      let value: { id?: unknown; amount?: unknown; currency?: unknown; destination?: unknown; reversed?: unknown };
      try {
        value = await providerJson(`https://api.stripe.com/v1/transfers/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${secret}`, "stripe-version": "2025-08-27.basil" },
        }) as typeof value;
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) return "not_found";
        throw error;
      }
      if (typeof value.id !== "string" || typeof value.amount !== "number" || typeof value.currency !== "string" || typeof value.destination !== "string") {
        throw new Error("Stripe reconciliation response was malformed.");
      }
      return {
        externalTransactionId: value.id,
        status: value.reversed === true ? "reversed" : "settled",
        amountCents: value.amount,
        currency: value.currency.toUpperCase(),
        accountFingerprint: await fingerprintAccount(value.destination),
      };
    },
  };
}

async function deferReconciliation(dbSession: DbSession, operation: FinancialOperationRecord, workerId: string, code: string, now: Date): Promise<void> {
  const attempt = operation.reconcileAttempts + 1;
  const tooOld = now.getTime() - operation.createdAt.getTime() > 24 * 60 * 60 * 1000;
  const saved = await dbSession.db.update(agentFinancialOperations).set({
    status: operation.status === "reserved" ? "unknown" : operation.status,
    reconciliationStatus: tooOld ? "manual_review" : "provider_unavailable",
    discrepancyCode: code,
    reconcileAttempts: attempt,
    nextReconcileAt: new Date(now.getTime() + reconciliationBackoffMs(attempt)),
    lastReconciledAt: now,
    reconcileLeaseOwner: null,
    reconcileLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(eq(agentFinancialOperations.id, operation.id),
    eq(agentFinancialOperations.reconcileLeaseOwner, workerId),
    gt(agentFinancialOperations.reconcileLeaseExpiresAt, now),
    eq(agentFinancialOperations.reconcileAttempts, operation.reconcileAttempts)));
  if (affectedRows(saved) !== 1) return;
  await appendFinancialEvent(dbSession, operation.id, operation.organizationId, tooOld ? "manual_review_required" : "reconciliation_deferred", await digestPayload(code), operation.externalTransactionId ?? undefined);
}

async function writeReconciliation(dbSession: DbSession,
  operation: FinancialOperationRecord,
  workerId: string,
  verdict: ReturnType<typeof compareFinancialState> | { status: "mismatch"; code: "external_transaction_not_found" },
  now: Date,
  externalTransactionId?: string
): Promise<boolean> {
  const attempt = operation.reconcileAttempts + 1;
  const pending = verdict.status === "pending";
  const operationStatus = "operationStatus" in verdict ? verdict.operationStatus : operation.status;
  const saved = await dbSession.db.update(agentFinancialOperations).set({
    status: operationStatus,
    reconciliationStatus: verdict.status,
    discrepancyCode: "code" in verdict ? verdict.code : null,
    reconcileAttempts: attempt,
    nextReconcileAt: new Date(now.getTime() + reconciliationBackoffMs(attempt)),
    lastReconciledAt: now,
    reconcileLeaseOwner: null,
    reconcileLeaseExpiresAt: null,
    updatedAt: now,
    ...(verdict.status === "matched" ? { settledAt: now } : {}),
  }).where(and(eq(agentFinancialOperations.id, operation.id),
    eq(agentFinancialOperations.reconcileLeaseOwner, workerId),
    gt(agentFinancialOperations.reconcileLeaseExpiresAt, now),
    eq(agentFinancialOperations.reconcileAttempts, operation.reconcileAttempts)));
  if (affectedRows(saved) !== 1) return false;
  await appendFinancialEvent(dbSession, operation.id, operation.organizationId, pending ? "reconciliation_pending" : `reconciliation_${verdict.status}`, await digestPayload(verdict), externalTransactionId);
  return true;
}

async function claimReconciliation(dbSession: DbSession, operation: FinancialOperationRecord, workerId: string, now: Date): Promise<boolean> {
  const result = await dbSession.db.update(agentFinancialOperations).set({
    reconcileLeaseOwner: workerId,
    reconcileLeaseExpiresAt: new Date(now.getTime() + 60_000),
    updatedAt: now,
  }).where(and(
    eq(agentFinancialOperations.id, operation.id),
    eq(agentFinancialOperations.reconciliationStatus, operation.reconciliationStatus),
    eq(agentFinancialOperations.reconcileAttempts, operation.reconcileAttempts),
    lte(agentFinancialOperations.nextReconcileAt, now),
    or(isNull(agentFinancialOperations.reconcileLeaseExpiresAt), lt(agentFinancialOperations.reconcileLeaseExpiresAt, now)),
  ));
  return affectedRows(result) === 1;
}

function affectedRows(result: unknown): number {
  const value = result as { rowCount?: number | null; rowsAffected?: number; meta?: { changes?: number }; changes?: number } | undefined;
  return value?.rowCount ?? value?.rowsAffected ?? value?.meta?.changes ?? value?.changes ?? -1;
}

async function appendFinancialEvent(dbSession: DbSession, operationId: string, organizationId: string, kind: string, payloadDigest: string, externalTransactionId?: string): Promise<void> {
  await dbSession.db.execute(sql`select id from ${agentFinancialOperations} where ${agentFinancialOperations.id} = ${operationId} for no key update`);
  const [head] = await dbSession.db.select({ sequence: agentFinancialEvents.sequence }).from(agentFinancialEvents)
    .where(eq(agentFinancialEvents.operationId, operationId))
    .orderBy(sql`${agentFinancialEvents.sequence} desc`).limit(1);
  await dbSession.db.insert(agentFinancialEvents).values({
    id: crypto.randomUUID(),
    operationId,
    organizationId,
    sequence: (head?.sequence ?? 0) + 1,
    kind,
    payloadDigest,
    externalTransactionId: externalTransactionId ?? null,
    createdAt: new Date(),
  });
}

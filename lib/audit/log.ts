/**
 * Persistence for the answer audit chain (see chain.ts for the hashing and
 * why only digests are stored).
 *
 * Two deliberate shapes here:
 *
 * - **One batched write per answer, not one per tool call.** The Ask Aval loop
 *   runs up to four rounds and several tools; writing a row inside each round
 *   would add database round-trips to the critical path of every question. Events
 *   are collected in memory and appended once when the answer resolves.
 *
 * - **The append shares the caller's transaction.** A transaction-scoped
 *   organization row lock serializes each organization's chain. If the append fails,
 *   the business mutation fails with it instead of leaving an unaudited gap.
 */

import { asc, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { answerAuditLog } from "@/db/postgres/schema";
import { GENESIS_HASH, chainEvents, verifyChain, type AuditEntry, type AuditEvent, type ChainVerdict } from "./chain";

/** Rows read back, newest last. */
async function readChain(dbSession: DbSession, organizationId: string, limit?: number): Promise<AuditEntry[]> {
  const db = dbSession.db;
  const query = db
    .select({
      sequence: answerAuditLog.sequence,
      kind: answerAuditLog.kind,
      label: answerAuditLog.label,
      payloadDigest: answerAuditLog.payloadDigest,
      count: answerAuditLog.count,
      previousHash: answerAuditLog.previousHash,
      entryHash: answerAuditLog.entryHash,
    })
    .from(answerAuditLog)
    .where(eq(answerAuditLog.organizationId, organizationId))
    .orderBy(asc(answerAuditLog.sequence));
  const rows = limit ? await query.limit(limit) : await query;
  return rows as AuditEntry[];
}

/** The chain's current end, so a new run continues it instead of restarting. */
async function readHead(dbSession: DbSession, organizationId: string): Promise<{ sequence: number; hash: string }> {
  const db = dbSession.db;
  const [row] = await db
    .select({ sequence: answerAuditLog.sequence, entryHash: answerAuditLog.entryHash })
    .from(answerAuditLog)
    .where(eq(answerAuditLog.organizationId, organizationId))
    .orderBy(sql`${answerAuditLog.sequence} desc`)
    .limit(1);
  return row ? { sequence: row.sequence, hash: row.entryHash } : { sequence: 0, hash: GENESIS_HASH };
}

/**
 * Appends a run's events to the org's chain. Returns the new head, or null if
 * nothing was written — callers must not treat null as an error worth failing
 * the request over (see the module comment).
 */
export async function appendAuditEvents(dbSession: DbSession, organizationId: string, events: AuditEvent[]): Promise<string | null> {
  if (events.length === 0) return null;
  await dbSession.db.execute(sql`select aval_private.lock_organization(${organizationId})`);
  const head = await readHead(dbSession, organizationId);
  const entries = await chainEvents(events, head.sequence + 1, head.hash);
  const now = new Date();
  await dbSession.db.insert(answerAuditLog).values(entries.map((entry) => ({
    id: crypto.randomUUID(),
    organizationId,
    sequence: entry.sequence,
    kind: entry.kind,
    label: entry.label,
    payloadDigest: entry.payloadDigest,
    count: entry.count,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    createdAt: now,
  })));
  return entries[entries.length - 1].entryHash;
}

export interface ChainReport extends Record<string, unknown> {
  verdict: ChainVerdict;
  /** Counts by kind, so a caller can show "47 answers, 190 tool calls, 0 gate failures". */
  totals: { answers: number; toolCalls: number; toolErrors: number; gatePassed: number; gateFailed: number };
}

/** Re-verifies an org's whole chain and summarizes it. */
export async function verifyOrganizationChain(dbSession: DbSession, organizationId: string): Promise<ChainReport> {
  const entries = await readChain(dbSession, organizationId);
  const verdict = await verifyChain(entries);
  const totals = {
    answers: entries.filter((entry) => entry.kind === "answer").length,
    toolCalls: entries.filter((entry) => entry.kind === "tool_call").length,
    toolErrors: entries.filter((entry) => entry.kind === "tool_error").length,
    gatePassed: entries.filter((entry) => entry.kind === "verdict" && entry.label === "pass").length,
    gateFailed: entries.filter((entry) => entry.kind === "verdict" && entry.label === "fail").length,
  };
  return { verdict, totals };
}

/** Recent entries for display. Digests only — there is no payload to show. */
export async function recentAuditEntries(dbSession: DbSession, organizationId: string, limit = 50): Promise<AuditEntry[]> {
  const entries = await readChain(dbSession, organizationId);
  return entries.slice(-limit).reverse();
}

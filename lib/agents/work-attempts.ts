/**
 * The durable record of what has already been tried.
 *
 * Budgets are counted from this table rather than from memory, so a crash or a
 * five-minute park cannot hand an employee a fresh allowance it has not earned.
 * The same rows are what a replan reads to choose differently: without them the
 * next planning pass can only guess, and guessing reproduces the strategy that
 * just failed.
 *
 * Named `recordWorkAttempt` rather than `recordAttempt` because
 * `lib/security/rate-limit.ts` already owns that name for a wholly different
 * kind of attempt.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { workAttempts } from "@/db/postgres/schema";
import { payloadHash } from "./canonical-payload.ts";
import type { AttemptKind, AttemptTrace } from "./attempt-policy.ts";

export type AttemptOutcome = "succeeded" | "failed" | "inconclusive" | "blocked";

export interface WorkAttemptInput {
  organizationId: string;
  taskId: string;
  kind: AttemptKind | "execution";
  outcome: AttemptOutcome;
  employeeId?: string | null;
  objectiveSnapshot?: string | null;
  strategy?: string | null;
  actions?: readonly unknown[];
  tools?: readonly string[];
  delegations?: readonly string[];
  observations?: string | null;
  result?: string | null;
  failureReason?: string | null;
  blockerReason?: string | null;
  transient?: boolean;
  progressed?: boolean;
  signature?: string | null;
  learned?: string | null;
  shouldChange?: string | null;
  nextStrategy?: string | null;
  costCents?: number | null;
  tokensUsed?: number | null;
  latencyMs?: number | null;
  externalEffects?: readonly string[];
  startedAt?: Date;
}

export interface WorkAttemptRecord {
  attemptNumber: number;
  kind: string;
  outcome: AttemptOutcome;
  startedAt: Date;
  strategy: string | null;
  tools: string[];
  observations: string | null;
  result: string | null;
  failureReason: string | null;
  blockerReason: string | null;
  transient: boolean;
  progressed: boolean;
  signature: string | null;
  learned: string | null;
  shouldChange: string | null;
  nextStrategy: string | null;
}

/**
 * A stable fingerprint of "what was tried and what came back".
 *
 * Two attempts sharing one of these did the same thing and got the same answer,
 * which is what makes a loop detectable without storing raw arguments — the
 * hash travels, the payload does not.
 */
export async function attemptSignature(
  toolName: string | null,
  args: unknown,
  failure: string | null,
): Promise<string> {
  return payloadHash({ tool: toolName ?? "", args: args ?? null, failure: failure ?? "" });
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

/**
 * Appends an attempt and returns its number.
 *
 * The number is allocated from what is already stored, under the unique index
 * on `(task, kind, attempt_number)`. A worker that dies after the provider call
 * but before this insert re-runs it on resume and collides rather than
 * silently spending a second attempt.
 */
export async function recordWorkAttempt(dbSession: DbSession, input: WorkAttemptInput): Promise<number> {
  const now = new Date();
  const [current] = await dbSession.db
    .select({ highest: sql<number | null>`max(${workAttempts.attemptNumber})` })
    .from(workAttempts)
    .where(and(eq(workAttempts.taskId, input.taskId), eq(workAttempts.kind, input.kind)));
  const attemptNumber = (current?.highest ?? 0) + 1;

  await dbSession.db.insert(workAttempts).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    taskId: input.taskId,
    employeeId: input.employeeId ?? null,
    attemptNumber,
    kind: input.kind,
    startedAt: input.startedAt ?? now,
    endedAt: now,
    objectiveSnapshot: input.objectiveSnapshot ?? null,
    strategy: input.strategy ?? null,
    actionsJson: JSON.stringify(input.actions ?? []),
    toolsJson: JSON.stringify(input.tools ?? []),
    delegationsJson: JSON.stringify(input.delegations ?? []),
    observations: input.observations ?? null,
    result: input.result ?? null,
    outcome: input.outcome,
    failureReason: input.failureReason ?? null,
    blockerReason: input.blockerReason ?? null,
    transient: input.transient ?? false,
    progressed: input.progressed ?? false,
    signature: input.signature ?? null,
    learned: input.learned ?? null,
    shouldChange: input.shouldChange ?? null,
    nextStrategy: input.nextStrategy ?? null,
    costCents: input.costCents ?? null,
    tokensUsed: input.tokensUsed ?? null,
    latencyMs: input.latencyMs ?? null,
    externalEffectsJson: JSON.stringify(input.externalEffects ?? []),
    createdAt: now,
  }).onConflictDoNothing();

  return attemptNumber;
}

/**
 * What a budget has already cost: how many attempts, and how long since the
 * first one.
 *
 * Both are read from storage, so they survive a restart — an employee cannot
 * win itself a fresh budget by crashing.
 */
export async function attemptSpend(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
  kind: AttemptKind | "execution",
  now: Date = new Date(),
): Promise<{ attempts: number; elapsedMs: number }> {
  const rows = await dbSession.db
    .select({ startedAt: workAttempts.startedAt })
    .from(workAttempts)
    .where(and(
      eq(workAttempts.organizationId, organizationId),
      eq(workAttempts.taskId, taskId),
      eq(workAttempts.kind, kind),
    ))
    .orderBy(asc(workAttempts.startedAt));

  if (rows.length === 0) return { attempts: 0, elapsedMs: 0 };
  return { attempts: rows.length, elapsedMs: Math.max(0, now.getTime() - rows[0].startedAt.getTime()) };
}

/** Recent attempts reduced to what stagnation detection reads. */
export async function attemptTraces(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
  kind?: AttemptKind | "execution",
): Promise<AttemptTrace[]> {
  const rows = await dbSession.db
    .select({ signature: workAttempts.signature, transient: workAttempts.transient, progressed: workAttempts.progressed })
    .from(workAttempts)
    .where(and(
      eq(workAttempts.organizationId, organizationId),
      eq(workAttempts.taskId, taskId),
      ...(kind ? [eq(workAttempts.kind, kind)] : []),
    ))
    .orderBy(asc(workAttempts.attemptNumber));
  return rows.map((row) => ({ signature: row.signature, transient: row.transient, progressed: row.progressed }));
}

/**
 * The structured history a replan is given.
 *
 * Ordered oldest first, because the interesting question is what has already
 * been ruled out, and that reads forwards.
 */
export async function attemptHistory(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
  kind?: AttemptKind | "execution",
): Promise<WorkAttemptRecord[]> {
  const rows = await dbSession.db
    .select()
    .from(workAttempts)
    .where(and(
      eq(workAttempts.organizationId, organizationId),
      eq(workAttempts.taskId, taskId),
      ...(kind ? [eq(workAttempts.kind, kind)] : []),
    ))
    .orderBy(asc(workAttempts.attemptNumber));

  return rows.map((row) => ({
    attemptNumber: row.attemptNumber,
    kind: row.kind,
    outcome: row.outcome as AttemptOutcome,
    startedAt: row.startedAt,
    strategy: row.strategy,
    tools: parseJson<string[]>(row.toolsJson, []),
    observations: row.observations,
    result: row.result,
    failureReason: row.failureReason,
    blockerReason: row.blockerReason,
    transient: row.transient,
    progressed: row.progressed,
    signature: row.signature,
    learned: row.learned,
    shouldChange: row.shouldChange,
    nextStrategy: row.nextStrategy,
  }));
}

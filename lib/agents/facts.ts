/**
 * Operational facts: what is true about an entity, who says so, and how far to
 * trust it.
 *
 * Two rules carry the design:
 *
 * 1. **A source never overwrites another source.** Writes are keyed on
 *    (entity, field, source), so a re-sync updates its own row and a different
 *    system gets its own. When two live rows disagree both are marked
 *    `conflicted` — the disagreement becomes visible instead of becoming the
 *    last writer's value.
 * 2. **Staleness is derived, never stored.** A stored `stale` flag is itself a
 *    fact that goes out of date. `expiresAt` is a horizon; whether the horizon
 *    has passed is answered at read time.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { operationalFacts } from "@/db/postgres/schema";

export const SOURCE_TYPES = ["provider", "aval_native", "human", "document", "inference"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const AUTHORITATIVENESS = ["authoritative", "reported", "inferred", "human_confirmed"] as const;
export type Authoritativeness = (typeof AUTHORITATIVENESS)[number];

export type ConflictState = "none" | "conflicted" | "superseded";

export interface FactInput {
  organizationId: string;
  entityType: string;
  entityId: string;
  factType: string;
  value: string | null;
  valueRef?: string | null;
  sourceType: SourceType;
  sourceProvider?: string | null;
  sourceRecordId?: string | null;
  observedAt?: Date | null;
  /** Defaults to now: Aval always knows when it looked. */
  syncedAt?: Date;
  expiresAt?: Date | null;
  freshnessPolicy?: string | null;
  confidence?: number | null;
  derivedFrom?: readonly string[];
}

export interface FactView {
  id: string;
  entityType: string;
  entityId: string;
  factType: string;
  value: string | null;
  sourceType: SourceType;
  sourceProvider: string | null;
  observedAt: Date | null;
  syncedAt: Date;
  expiresAt: Date | null;
  authoritativeness: Authoritativeness;
  confidence: number | null;
  conflictState: ConflictState;
  /** Derived at read time from `expiresAt`. */
  stale: boolean;
}

/**
 * The authority a source type carries.
 *
 * Deliberately a function of the source rather than something a caller passes:
 * a model that could label its own output `authoritative` would make the whole
 * distinction decorative.
 */
export function authoritativenessFor(sourceType: SourceType): Authoritativeness {
  switch (sourceType) {
    case "provider": return "authoritative";
    case "human": return "human_confirmed";
    case "inference": return "inferred";
    // A document or an email states something; it does not make it so.
    case "document": return "reported";
    case "aval_native": return "authoritative";
  }
}

function isStale(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

function viewOf(row: typeof operationalFacts.$inferSelect, now: Date): FactView {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    factType: row.factType,
    value: row.value,
    sourceType: row.sourceType as SourceType,
    sourceProvider: row.sourceProvider,
    observedAt: row.observedAt,
    syncedAt: row.syncedAt,
    expiresAt: row.expiresAt,
    authoritativeness: row.authoritativeness as Authoritativeness,
    confidence: row.confidence,
    conflictState: row.conflictState as ConflictState,
    stale: isStale(row.expiresAt, now),
  };
}

/**
 * Records one observation, then re-evaluates whether the live facts for that
 * field agree.
 *
 * Returns the stored fact's view. A caller that needs to know whether it
 * created a disagreement reads `conflictState`.
 */
export async function recordFact(dbSession: DbSession, input: FactInput): Promise<FactView> {
  const now = new Date();
  const authoritativeness = authoritativenessFor(input.sourceType);
  const confidence = input.sourceType === "inference" ? (input.confidence ?? 0.5) : null;

  await dbSession.db
    .insert(operationalFacts)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      factType: input.factType,
      value: input.value,
      valueRef: input.valueRef ?? null,
      sourceType: input.sourceType,
      sourceProvider: input.sourceProvider ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      observedAt: input.observedAt ?? null,
      syncedAt: input.syncedAt ?? now,
      expiresAt: input.expiresAt ?? null,
      freshnessPolicy: input.freshnessPolicy ?? null,
      authoritativeness,
      confidence,
      derivedFromJson: JSON.stringify(input.derivedFrom ?? []),
      conflictState: "none",
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        operationalFacts.organizationId, operationalFacts.entityType, operationalFacts.entityId,
        operationalFacts.factType, operationalFacts.sourceType, operationalFacts.sourceProvider,
      ],
      // A source correcting itself is an update, not a conflict.
      set: {
        value: input.value,
        valueRef: input.valueRef ?? null,
        sourceRecordId: input.sourceRecordId ?? null,
        observedAt: input.observedAt ?? null,
        syncedAt: input.syncedAt ?? now,
        expiresAt: input.expiresAt ?? null,
        freshnessPolicy: input.freshnessPolicy ?? null,
        authoritativeness,
        confidence,
        derivedFromJson: JSON.stringify(input.derivedFrom ?? []),
        updatedAt: now,
      },
    });

  await reconcile(dbSession, input, now);

  const [stored] = await dbSession.db
    .select()
    .from(operationalFacts)
    .where(and(
      eq(operationalFacts.organizationId, input.organizationId),
      eq(operationalFacts.entityType, input.entityType),
      eq(operationalFacts.entityId, input.entityId),
      eq(operationalFacts.factType, input.factType),
      eq(operationalFacts.sourceType, input.sourceType),
      input.sourceProvider ? eq(operationalFacts.sourceProvider, input.sourceProvider) : isNull(operationalFacts.sourceProvider),
    ))
    .limit(1);
  return viewOf(stored, now);
}

/** Marks every live fact for one field `conflicted` when the live values disagree, and clears it when they agree again. */
async function reconcile(dbSession: DbSession, input: FactInput, now: Date): Promise<void> {
  const live = await dbSession.db
    .select()
    .from(operationalFacts)
    .where(and(
      eq(operationalFacts.organizationId, input.organizationId),
      eq(operationalFacts.entityType, input.entityType),
      eq(operationalFacts.entityId, input.entityId),
      eq(operationalFacts.factType, input.factType),
      or(eq(operationalFacts.conflictState, "none"), eq(operationalFacts.conflictState, "conflicted")),
    ));

  if (live.length < 2) {
    if (live.length === 1 && live[0].conflictState === "conflicted") {
      await dbSession.db.update(operationalFacts)
        .set({ conflictState: "none", updatedAt: now })
        .where(eq(operationalFacts.id, live[0].id));
    }
    return;
  }

  const distinct = new Set(live.map((row) => row.value ?? "\u0000null"));
  const next: ConflictState = distinct.size > 1 ? "conflicted" : "none";
  for (const row of live) {
    if (row.conflictState === next) continue;
    await dbSession.db.update(operationalFacts)
      .set({ conflictState: next, updatedAt: now })
      .where(eq(operationalFacts.id, row.id));
  }
}

/**
 * Settles a disagreement by keeping one fact and superseding the rest.
 *
 * A person choosing between two sources is not a new observation of the world —
 * the other sources still reported what they reported. Superseding says "this
 * one stands" without rewriting or deleting what disagreed, which keeps the
 * trail of why the value is what it is. `reconcile` only looks at live facts,
 * so the survivor drops back to `none` on the next write.
 */
export async function settleFactConflict(dbSession: DbSession, organizationId: string, input: {
  entityType: string;
  entityId: string;
  factType: string;
  keepFactId: string;
}): Promise<boolean> {
  const now = new Date();
  const live = await dbSession.db
    .select()
    .from(operationalFacts)
    .where(and(
      eq(operationalFacts.organizationId, organizationId),
      eq(operationalFacts.entityType, input.entityType),
      eq(operationalFacts.entityId, input.entityId),
      eq(operationalFacts.factType, input.factType),
      or(eq(operationalFacts.conflictState, "none"), eq(operationalFacts.conflictState, "conflicted")),
    ));
  if (!live.some((row) => row.id === input.keepFactId)) return false;

  for (const row of live) {
    const keep = row.id === input.keepFactId;
    await dbSession.db.update(operationalFacts)
      .set({
        conflictState: keep ? "none" : "superseded",
        supersededBy: keep ? null : input.keepFactId,
        updatedAt: now,
      })
      .where(eq(operationalFacts.id, row.id));
  }
  return true;
}

/** Every live fact for one field, newest sync first, with freshness derived. */
export async function readFacts(
  dbSession: DbSession,
  organizationId: string,
  entityType: string,
  entityId: string,
  factType: string,
  now = new Date(),
): Promise<FactView[]> {
  const rows = await dbSession.db
    .select()
    .from(operationalFacts)
    .where(and(
      eq(operationalFacts.organizationId, organizationId),
      eq(operationalFacts.entityType, entityType),
      eq(operationalFacts.entityId, entityId),
      eq(operationalFacts.factType, factType),
    ));
  return rows
    .map((row) => viewOf(row, now))
    .sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime());
}

/**
 * The fact an agent should act on, or null when it must not act on any.
 *
 * Returns null when live sources disagree: a caller that wants a value anyway
 * can read them all and show the disagreement, but nothing gets a quiet answer
 * that hides it.
 */
export function actionableFact(facts: readonly FactView[]): FactView | null {
  if (facts.some((fact) => fact.conflictState === "conflicted")) return null;
  const usable = facts.filter((fact) => !fact.stale && fact.conflictState !== "superseded");
  const rank: Record<Authoritativeness, number> = {
    authoritative: 0, human_confirmed: 1, reported: 2, inferred: 3,
  };
  return usable.sort((a, b) => rank[a.authoritativeness] - rank[b.authoritativeness]
    || b.syncedAt.getTime() - a.syncedAt.getTime())[0] ?? null;
}

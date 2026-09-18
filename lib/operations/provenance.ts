/**
 * How a row changes when a connected system reports something about it.
 *
 * The premise of connecting a portfolio's whole stack is that the pieces
 * disagree. A PMS and an accounting system will not report the same rent for
 * the same unit forever, and the obvious implementation — write whatever
 * arrived most recently — produces a dashboard that is confidently wrong with
 * nothing on screen to indicate it. That is the same failure mode the
 * faithfulness gate and the audit chain exist to prevent, one layer further
 * down, so this module refuses it in the same way: keep both values, flag the
 * field, let a person decide.
 *
 * The decision itself — which of three rules applies to an incoming value —
 * lives in `merge.ts`, which has no database in it and is re-exported from
 * here so callers still import from one place. This module is the part that
 * touches storage: writing conflicts, listing them, resolving them.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { operationsConflicts } from "@/db/postgres/schema";
import { MANUAL_SOURCE, type ConflictEntityType } from "./types";

export { planMerge } from "./merge";
export type { FieldConflict, MergePlan } from "./merge";
import type { FieldConflict } from "./merge";

/**
 * Records conflicts for one entity, one row per contested field.
 *
 * Upserts on the unique `(org, entityType, entityId, field)` index rather than
 * inserting: a nightly sync against a field two systems permanently disagree
 * about would otherwise add an identical row every night and bury every other
 * finding. Re-detecting an already-open conflict refreshes its values and
 * timestamp; it does not reopen one a person has resolved, because resolving
 * it was a decision and re-flagging it every night would undo that decision by
 * attrition.
 */
export async function recordConflicts(dbSession: DbSession,
  organizationId: string,
  entityType: ConflictEntityType,
  entityId: string,
  conflicts: FieldConflict[]
): Promise<number> {
  if (conflicts.length === 0) return 0;
  const db = dbSession.db;
  const now = new Date();

  for (const conflict of conflicts) {
    await db
      .insert(operationsConflicts)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        entityType,
        entityId,
        field: conflict.field,
        valueA: conflict.storedValue,
        sourceA: conflict.storedSource,
        valueB: conflict.incomingValue,
        sourceB: conflict.incomingSource,
        status: "open",
        resolution: null,
        detectedAt: now,
        resolvedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          operationsConflicts.organizationId,
          operationsConflicts.entityType,
          operationsConflicts.entityId,
          operationsConflicts.field,
        ],
        set: { valueA: conflict.storedValue, valueB: conflict.incomingValue, sourceB: conflict.incomingSource, detectedAt: now },
        // Only refresh a conflict still open. A resolved one stays resolved.
        where: eq(operationsConflicts.status, "open"),
      });
  }

  return conflicts.length;
}

export interface ConflictRow {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  valueA: string;
  sourceA: string;
  valueB: string;
  sourceB: string;
  status: string;
  resolution: string | null;
  detectedAt: Date;
  resolvedAt: Date | null;
}

/** Open conflicts for a workspace, newest first. */
export async function listOpenConflicts(dbSession: DbSession, organizationId: string, limit = 100): Promise<ConflictRow[]> {
  return dbSession.db
    .select()
    .from(operationsConflicts)
    .where(and(eq(operationsConflicts.organizationId, organizationId), eq(operationsConflicts.status, "open")))
    .limit(limit);
}

/**
 * Marks a conflict resolved.
 *
 * Records *which* value was kept rather than only that it was settled, so the
 * trail says what a person decided. Note this does not itself write the chosen
 * value back onto the entity — the caller does that, because only it knows the
 * column's real type, and coercing a text value back into a typed column here
 * is exactly the kind of guess this module exists to avoid.
 */
export async function resolveConflict(dbSession: DbSession,
  organizationId: string,
  conflictId: string,
  resolution: "kept_a" | "kept_b" | "dismissed"
): Promise<boolean> {
  const db = dbSession.db;
  const [existing] = await db
    .select({ id: operationsConflicts.id })
    .from(operationsConflicts)
    .where(and(eq(operationsConflicts.organizationId, organizationId), eq(operationsConflicts.id, conflictId)))
    .limit(1);
  if (!existing) return false;

  await db
    .update(operationsConflicts)
    .set({ status: "resolved", resolution, resolvedAt: new Date() })
    .where(and(eq(operationsConflicts.organizationId, organizationId), eq(operationsConflicts.id, conflictId)));
  return true;
}

/** The provenance columns every operations entity carries. */
export interface SourceRef {
  sourceProvider: string;
  sourceConnectionId: string | null;
  externalId: string | null;
}

/** The provenance of a hand-entered row. */
export function manualSource(): SourceRef {
  return { sourceProvider: MANUAL_SOURCE, sourceConnectionId: null, externalId: null };
}

/**
 * Human-readable provenance for one row, for any surface that shows a figure
 * and has to be able to say where it came from.
 */
export function describeSource(ref: Pick<SourceRef, "sourceProvider" | "externalId">): string {
  if (ref.sourceProvider === MANUAL_SOURCE) return "Entered in Aval";
  return ref.externalId ? `${ref.sourceProvider} · ${ref.externalId}` : ref.sourceProvider;
}

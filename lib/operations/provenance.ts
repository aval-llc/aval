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

import { and, desc, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { operationalFacts } from "@/db/postgres/schema";
import { MANUAL_SOURCE, type ConflictEntityType } from "./types";
import { describeValue } from "./merge";
import { readFacts, recordFact, settleFactConflict } from "@/lib/agents/facts";

export { planMerge } from "./merge";
export type { FieldConflict, MergePlan } from "./merge";

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
/**
 * How long a synced value is treated as current before it is stale.
 *
 * Named rather than inlined so a change of policy is legible in the stored
 * fact: `operational_facts.freshness_policy` records which rule produced the
 * horizon, and staleness itself is derived at read time from `expires_at` so it
 * cannot itself go stale.
 */
export const SYNC_FRESHNESS_POLICY = "provider_sync_24h";
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Records what a source said about an entity's fields, with its provenance.
 *
 * This is the join that was missing. `operational_facts` carried source,
 * authority, observation time, freshness and conflict semantics, and nothing on
 * the real import path ever wrote to it — so a workspace could sync two systems
 * that disagreed and the fact layer would show nothing at all.
 *
 * Authority is derived from the source kind inside `recordFact`, never supplied
 * here: a caller cannot label its own value authoritative, and a value entered
 * by a person is `human_confirmed` rather than `authoritative` because a person
 * is not the system of record.
 */
export async function recordSyncedFacts(dbSession: DbSession,
  organizationId: string,
  entityType: ConflictEntityType,
  entityId: string,
  fields: Record<string, unknown>,
  source: SourceRef,
  observedAt: Date | null = null,
): Promise<void> {
  const syncedAt = new Date();
  const expiresAt = new Date(syncedAt.getTime() + SYNC_TTL_MS);
  const sourceType = source.sourceProvider === MANUAL_SOURCE ? "human" : "provider";

  for (const [factType, raw] of Object.entries(fields)) {
    if (raw === null || raw === undefined) continue;
    await recordFact(dbSession, {
      organizationId,
      entityType,
      entityId,
      factType,
      value: describeValue(raw),
      sourceType,
      sourceProvider: source.sourceProvider,
      sourceRecordId: source.externalId ?? null,
      // Null when the source does not say when it was true. An honest null
      // beats stamping "now" on something observed days ago.
      observedAt,
      syncedAt,
      expiresAt,
      freshnessPolicy: SYNC_FRESHNESS_POLICY,
    });
  }
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

/**
 * Open conflicts for a workspace, derived from the facts themselves.
 *
 * There is no separate conflict table to keep in step any more. A disagreement
 * is two live facts for one field whose values differ, which `recordFact`
 * already marks as it writes — so what a person is shown and what an agent is
 * refused an answer from are the same state, rather than two systems that have
 * to be kept honest with each other.
 *
 * The id is synthetic and stable: it names the field in dispute, so resolving
 * one is idempotent and a stale page cannot resolve the wrong row.
 */
export async function listOpenConflicts(dbSession: DbSession, organizationId: string, limit = 100): Promise<ConflictRow[]> {
  const rows = await dbSession.db
    .select()
    .from(operationalFacts)
    .where(and(
      eq(operationalFacts.organizationId, organizationId),
      eq(operationalFacts.conflictState, "conflicted"),
    ))
    .orderBy(desc(operationalFacts.syncedAt));

  const byField = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = conflictKey(row.entityType, row.entityId, row.factType);
    const group = byField.get(key);
    if (group) group.push(row); else byField.set(key, [row]);
  }

  const conflicts: ConflictRow[] = [];
  for (const [key, group] of byField) {
    if (group.length < 2) continue;
    const [a, b] = group;
    conflicts.push({
      id: key,
      entityType: a.entityType,
      entityId: a.entityId,
      field: a.factType,
      valueA: a.value ?? "",
      sourceA: a.sourceProvider ?? a.sourceType,
      valueB: b.value ?? "",
      sourceB: b.sourceProvider ?? b.sourceType,
      status: "open",
      resolution: null,
      detectedAt: a.syncedAt,
      resolvedAt: null,
    });
    if (conflicts.length >= limit) break;
  }
  return conflicts;
}

/** `entityType:entityId:field`, the field a disagreement is about. */
function conflictKey(entityType: string, entityId: string, field: string): string {
  return `${entityType}\u0000${entityId}\u0000${field}`;
}

/**
 * Settles a conflict by keeping one side.
 *
 * Recorded by superseding the facts that were not kept rather than by flipping
 * a status column, so the answer to "why is this value what it is" stays
 * readable: the losing observations are still there, marked as superseded by
 * the one that stands. `dismissed` keeps the newest side, which is the
 * "leave it alone" outcome expressed in the same terms.
 */
export async function resolveConflict(dbSession: DbSession,
  organizationId: string,
  conflictId: string,
  resolution: "kept_a" | "kept_b" | "dismissed"
): Promise<boolean> {
  const [entityType, entityId, factType] = conflictId.split("\u0000");
  if (!entityType || !entityId || !factType) return false;

  const facts = await readFacts(dbSession, organizationId, entityType, entityId, factType);
  const live = facts.filter((fact) => fact.conflictState === "conflicted");
  if (live.length < 2) return false;

  // `listOpenConflicts` orders by sync time, and so does `readFacts`, so A and B
  // mean the same two facts the person was shown.
  const keep = resolution === "kept_b" ? live[1] : live[0];
  return settleFactConflict(dbSession, organizationId, {
    entityType, entityId, factType, keepFactId: keep.id,
  });
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

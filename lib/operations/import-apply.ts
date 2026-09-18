/**
 * Applies a planned import batch to the database.
 *
 * The thin half of the pair: `import-plan.ts` decides *what* happens and holds
 * every rule with a sharp edge; this walks the resulting plan in order and
 * writes. Same split as `metrics/` against the repositories, for the same
 * reason — the decisions stay testable without a D1 binding.
 *
 * **Idempotent, in two layers.** Every row is keyed on
 * `(organizationId, sourceProvider, externalId)`. A unique index on that
 * triple is the backstop that makes duplication impossible; the existence
 * checks below (`loadIdMap` for entities other rows reference,
 * `loadExistingEventIds` for the append-only ones) are what make a re-send
 * report cleanly as `unchanged` instead of as a wall of index violations.
 * Both layers are needed: the index alone left a nightly re-send reporting
 * every row as a failure, which is how this was found. A connector re-sending
 * its last 30 days is the normal case, not an error, and an importer that
 * doubled a portfolio's rent roll on the second run would be worse than one
 * that never ran.
 *
 * **Application is atomic.** Planning rejects the complete batch when any row
 * is invalid or cannot resolve a reference. The accepted plan then runs behind
 * a PostgreSQL savepoint, so an insert, constraint, or repository failure
 * leaves canonical data exactly as it was before the batch.
 */

import { and, eq } from "drizzle-orm";
import { updateExistingImport } from "./import-existing";
import type { DbSession } from "@/db/postgres/session";
import {
  glAccounts,
  leases,
  leasingLeads,
  properties,
  residents,
  syncRuns,
  units,
  vendors,
  workOrders,
} from "@/db/postgres/schema";
import { createGlAccount, postGlTransaction, postLedgerEntry } from "./accounting";
import { attachResidentToLease, createLead, createLease, createResident } from "./leasing";
import { createVendor, createWorkOrder, linkCallback } from "./maintenance";
import { upsertPropertyFromSource, upsertUnitFromSource } from "./portfolio";
import type { SourceRef } from "./provenance";
import { ImportBatchRejectedError } from "./errors";
import {
  IMPORT_ORDER,
  planImport,
  type ImportBatch,
  type ImportEntity,
  type ImportGlAccount,
  type ImportGlTransaction,
  type ImportLead,
  type ImportLease,
  type ImportLedgerEntry,
  type ImportProperty,
  type ImportResident,
  type ImportUnit,
  type ImportVendor,
  type ImportWorkOrder,
  type SkippedRow,
} from "./import-plan.ts";
import type { LeaseStatus, PropertyType, ResidentStatus, UnitStatus, WorkOrderCategory, WorkOrderPriority, LedgerCategory, LedgerEntryType, GlAccountType } from "./types";

export interface ImportResult {
  applied: Record<ImportEntity, number>;
  updated: Record<ImportEntity, number>;
  /** Rows already present from this source, left as they were. */
  unchanged: Record<ImportEntity, number>;
  /** Field-level disagreements recorded against rows another source had written. */
  conflictsDetected: number;
  skipped: SkippedRow[];
  failed: { entity: ImportEntity; externalId: string; error: string }[];
}

const date = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

/** External ids this workspace already holds, per entity, so the planner can resolve references against the database as well as the batch. */
async function loadKnownExternalIds(dbSession: DbSession, organizationId: string, sourceProvider: string) {
  const db = dbSession.db;
  const scope = <T extends { organizationId: unknown; sourceProvider: unknown; externalId: unknown }>(table: T) =>
    and(
      eq(table.organizationId as never, organizationId),
      eq(table.sourceProvider as never, sourceProvider),
    );

  const [propertyRows, unitRows, residentRows, vendorRows, accountRows, leaseRows, workOrderRows] = await Promise.all([
    db.select({ externalId: properties.externalId }).from(properties).where(scope(properties)),
    db.select({ externalId: units.externalId }).from(units).where(scope(units)),
    db.select({ externalId: residents.externalId }).from(residents).where(scope(residents)),
    db.select({ externalId: vendors.externalId }).from(vendors).where(scope(vendors)),
    db.select({ externalId: glAccounts.externalId }).from(glAccounts).where(scope(glAccounts)),
    db.select({ externalId: leases.externalId }).from(leases).where(scope(leases)),
    db.select({ externalId: workOrders.externalId }).from(workOrders).where(scope(workOrders)),
  ]);

  const setOf = (rows: { externalId: string | null }[]) =>
    new Set(rows.map((row) => row.externalId).filter((id): id is string => id !== null));

  return {
    properties: setOf(propertyRows),
    units: setOf(unitRows),
    residents: setOf(residentRows),
    vendors: setOf(vendorRows),
    glAccounts: setOf(accountRows),
    leases: setOf(leaseRows),
    workOrders: setOf(workOrderRows),
  };
}

/**
 * Maps this source's external ids to the internal ids already stored, for
 * reference resolution during apply.
 *
 * Written out per table rather than through one generic helper: Drizzle's
 * table types do not unify into something a single query can be written
 * against, and the shapes that force a cast are exactly the ones where a
 * wrong column would fail silently at runtime.
 */
async function loadIdMap(dbSession: DbSession, organizationId: string, sourceProvider: string) {
  const db = dbSession.db;
  const scoped = <T extends { organizationId: never; sourceProvider: never }>(table: T) =>
    and(eq(table.organizationId, organizationId), eq(table.sourceProvider, sourceProvider));
  const toMap = (rows: { id: string; externalId: string | null }[]) =>
    new Map(rows.filter((row) => row.externalId !== null).map((row) => [row.externalId as string, row.id]));

  const [propertyRows, unitRows, residentRows, vendorRows, accountRows, leaseRows, workOrderRows] = await Promise.all([
    db.select({ id: properties.id, externalId: properties.externalId }).from(properties).where(scoped(properties as never)),
    db.select({ id: units.id, externalId: units.externalId }).from(units).where(scoped(units as never)),
    db.select({ id: residents.id, externalId: residents.externalId }).from(residents).where(scoped(residents as never)),
    db.select({ id: vendors.id, externalId: vendors.externalId }).from(vendors).where(scoped(vendors as never)),
    db.select({ id: glAccounts.id, externalId: glAccounts.externalId }).from(glAccounts).where(scoped(glAccounts as never)),
    db.select({ id: leases.id, externalId: leases.externalId }).from(leases).where(scoped(leases as never)),
    db.select({ id: workOrders.id, externalId: workOrders.externalId }).from(workOrders).where(scoped(workOrders as never)),
  ]);

  return {
    properties: toMap(propertyRows),
    units: toMap(unitRows),
    residents: toMap(residentRows),
    vendors: toMap(vendorRows),
    glAccounts: toMap(accountRows),
    leases: toMap(leaseRows),
    workOrders: toMap(workOrderRows),
  };
}

/**
 * Plans and applies a batch.
 *
 * `syncRunId`, when given, has its `countsJson` and status updated only after
 * the complete batch succeeds.
 */
export async function applyImport(dbSession: DbSession,
  organizationId: string,
  batch: ImportBatch,
  source: SourceRef,
  syncRunId?: string
): Promise<ImportResult> {
  const known = await loadKnownExternalIds(dbSession, organizationId, source.sourceProvider);
  const plan = planImport(batch, known);
  if (plan.skipped.length > 0) throw new ImportBatchRejectedError(plan.skipped);

  return dbSession.atomic(async () => {
  const ids = await loadIdMap(dbSession, organizationId, source.sourceProvider);

  const applied = Object.fromEntries(IMPORT_ORDER.map((entity) => [entity, 0])) as Record<ImportEntity, number>;
  const unchanged = Object.fromEntries(IMPORT_ORDER.map((entity) => [entity, 0])) as Record<ImportEntity, number>;
  const updated = Object.fromEntries(IMPORT_ORDER.map((entity) => [entity, 0])) as Record<ImportEntity, number>;
  const failed: ImportResult["failed"] = [];
  let conflictsDetected = 0;

  /** Provenance for one row of this batch. */
  const refFor = (externalId: string): SourceRef => ({ ...source, externalId });

  for (const step of plan.steps) {
    for (const row of step.rows) {
      const externalId = (row as { externalId: string }).externalId;
      const existing = await updateExistingImport(dbSession, organizationId, step.entity, row as Record<string, unknown>, source, ids);
      if (existing) {
        if (existing === "updated") updated[step.entity] += 1;
        else unchanged[step.entity] += 1;
        continue;
      }
        switch (step.entity) {
          case "properties": {
            const input = row as ImportProperty;
            const result = await upsertPropertyFromSource(dbSession,
              organizationId,
              {
                name: input.name,
                addressLine1: input.addressLine1,
                city: input.city,
                region: input.region,
                postalCode: input.postalCode,
                country: input.country,
                propertyType: input.propertyType as PropertyType | undefined,
                reportedUnitCount: input.reportedUnitCount,
                yearBuilt: input.yearBuilt,
                squareFeet: input.squareFeet,
              },
              refFor(externalId),
            );
            ids.properties.set(externalId, result.property.id);
            conflictsDetected += result.conflicts;
            if (result.created) applied.properties += 1;
            else if (result.updated) updated.properties += 1;
            else unchanged.properties += 1;
            break;
          }

          case "units": {
            const input = row as ImportUnit;
            const propertyId = ids.properties.get(input.propertyExternalId);
            if (!propertyId) throw new Error(`property "${input.propertyExternalId}" resolved in planning but not at apply time`);
            const result = await upsertUnitFromSource(dbSession,
              organizationId,
              {
                propertyId,
                unitNumber: input.unitNumber,
                bedrooms: input.bedrooms,
                bathrooms: input.bathrooms,
                squareFeet: input.squareFeet,
                marketRentCents: input.marketRentCents,
                status: input.status as UnitStatus | undefined,
                vacantSince: date(input.vacantSince),
              },
              refFor(externalId),
            );
            ids.units.set(externalId, result.unit.id);
            conflictsDetected += result.conflicts;
            if (result.created) applied.units += 1;
            else if (result.updated) updated.units += 1;
            else unchanged.units += 1;
            break;
          }

          case "residents": {
            const input = row as ImportResident;
            const created = await createResident(dbSession,
              organizationId,
              { displayName: input.displayName, email: input.email, phone: input.phone, status: input.status as ResidentStatus | undefined },
              refFor(externalId),
            );
            ids.residents.set(externalId, created.id);
            applied.residents += 1;
            break;
          }

          case "vendors": {
            const input = row as ImportVendor;
            const created = await createVendor(dbSession,
              organizationId,
              { name: input.name, trade: input.trade, email: input.email, phone: input.phone, insuranceExpiresAt: date(input.insuranceExpiresAt) },
              refFor(externalId),
            );
            ids.vendors.set(externalId, created.id);
            applied.vendors += 1;
            break;
          }

          case "glAccounts": {
            const input = row as ImportGlAccount;
            const created = await createGlAccount(dbSession,
              organizationId,
              { code: input.code, name: input.name, accountType: input.accountType as GlAccountType, isTrustAccount: input.isTrustAccount },
              refFor(externalId),
            );
            ids.glAccounts.set(externalId, created.id);
            applied.glAccounts += 1;
            break;
          }

          case "leases": {
            const input = row as ImportLease;
            const unitId = ids.units.get(input.unitExternalId);
            if (!unitId) throw new Error(`unit "${input.unitExternalId}" resolved in planning but not at apply time`);
            const created = await createLease(dbSession,
              organizationId,
              {
                unitId,
                status: input.status as LeaseStatus | undefined,
                startDate: new Date(input.startDate),
                endDate: date(input.endDate),
                isMonthToMonth: input.isMonthToMonth,
                rentCents: input.rentCents,
                depositCents: input.depositCents,
                rentDueDay: input.rentDueDay,
                renewalOfLeaseId: input.renewalOfExternalId ? ids.leases.get(input.renewalOfExternalId) ?? null : null,
              },
              refFor(externalId),
            );
            ids.leases.set(externalId, created.id);
            for (const residentExternalId of input.residentExternalIds ?? []) {
              const residentId = ids.residents.get(residentExternalId);
              if (residentId) await attachResidentToLease(dbSession, organizationId, created.id, residentId, "primary", refFor(externalId));
            }
            applied.leases += 1;
            break;
          }

          case "ledgerEntries": {
            const input = row as ImportLedgerEntry;
            const leaseId = ids.leases.get(input.leaseExternalId);
            if (!leaseId) throw new Error(`lease "${input.leaseExternalId}" resolved in planning but not at apply time`);
            await postLedgerEntry(dbSession,
              organizationId,
              {
                leaseId,
                entryType: input.entryType as LedgerEntryType,
                category: input.category as LedgerCategory,
                amountCents: input.amountCents,
                postedAt: new Date(input.postedAt),
                dueAt: date(input.dueAt),
                memo: input.memo,
              },
              refFor(externalId),
            );
            applied.ledgerEntries += 1;
            break;
          }

          case "workOrders": {
            const input = row as ImportWorkOrder;
            const propertyId = ids.properties.get(input.propertyExternalId);
            if (!propertyId) throw new Error(`property "${input.propertyExternalId}" resolved in planning but not at apply time`);
            const created = await createWorkOrder(dbSession,
              organizationId,
              {
                propertyId,
                unitId: input.unitExternalId ? ids.units.get(input.unitExternalId) ?? null : null,
                category: input.category as WorkOrderCategory | undefined,
                priority: input.priority as WorkOrderPriority | undefined,
                summary: input.summary,
                reportedAt: new Date(input.reportedAt),
                vendorId: input.vendorExternalId ? ids.vendors.get(input.vendorExternalId) ?? null : null,
                estimateCents: input.estimateCents,
              },
              refFor(externalId),
            );
            ids.workOrders.set(externalId, created.id);

            // Lifecycle timestamps and cost come from the source rather than
            // from this app's own transitions, so they are written directly —
            // going through assign/start/complete would stamp "now" and
            // destroy the very durations the maintenance metrics measure.
            const completedAt = date(input.completedAt);
            const assignedAt = date(input.assignedAt);
            if (completedAt || assignedAt || input.actualCostCents !== undefined || input.status !== undefined) {
              await dbSession.db
                .update(workOrders)
                .set({
                  assignedAt: assignedAt ?? undefined,
                  completedAt: completedAt ?? undefined,
                  actualCostCents: input.actualCostCents ?? undefined,
                  status: input.status ?? (completedAt ? "completed" : assignedAt ? "assigned" : undefined),
                  updatedAt: new Date(),
                })
                .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, created.id)));
            }
            if (input.callbackOfExternalId) {
              const originalId = ids.workOrders.get(input.callbackOfExternalId);
              // A callback link asserted by the source system is a human
              // assertion made there, which is exactly what firstTimeFixPct
              // requires — unlike Aval's own proximity suggestions.
              if (originalId) await linkCallback(dbSession, organizationId, created.id, originalId);
            }
            applied.workOrders += 1;
            break;
          }

          case "glTransactions": {
            const input = row as ImportGlTransaction;
            const accountId = ids.glAccounts.get(input.accountExternalId);
            if (!accountId) throw new Error(`GL account "${input.accountExternalId}" resolved in planning but not at apply time`);
            await postGlTransaction(dbSession,
              organizationId,
              {
                accountId,
                propertyId: input.propertyExternalId ? ids.properties.get(input.propertyExternalId) ?? null : null,
                amountCents: input.amountCents,
                postedAt: new Date(input.postedAt),
                memo: input.memo,
              },
              refFor(externalId),
            );
            applied.glTransactions += 1;
            break;
          }

          case "leads": {
            const input = row as ImportLead;
            const created = await createLead(dbSession,
              organizationId,
              {
                propertyId: input.propertyExternalId ? ids.properties.get(input.propertyExternalId) ?? null : null,
                unitId: input.unitExternalId ? ids.units.get(input.unitExternalId) ?? null : null,
                channel: input.channel,
                unitTypeLabel: input.unitTypeLabel,
                inquiredAt: new Date(input.inquiredAt),
              },
              refFor(externalId),
            );
            // Stage timestamps are written as the source recorded them. The
            // funnel's whole value is the real elapsed time between stages,
            // which advanceLead's "stamp now" behavior would erase.
            const stamps = {
              contactedAt: date(input.contactedAt),
              touredAt: date(input.touredAt),
              appliedAt: date(input.appliedAt),
              approvedAt: date(input.approvedAt),
              signedAt: date(input.signedAt),
              lostAt: date(input.lostAt),
            };
            const stage = stamps.signedAt
              ? "signed"
              : stamps.lostAt
                ? "lost"
                : stamps.approvedAt
                  ? "approved"
                  : stamps.appliedAt
                    ? "applied"
                    : stamps.touredAt
                      ? "toured"
                      : stamps.contactedAt
                        ? "contacted"
                        : "inquiry";
            await dbSession.db
              .update(leasingLeads)
              .set({ ...stamps, stage, lostReason: input.lostReason ?? null, updatedAt: new Date() })
              .where(and(eq(leasingLeads.organizationId, organizationId), eq(leasingLeads.id, created.id)));
            applied.leads += 1;
            break;
          }
        }
    }
  }

  const result: ImportResult = { applied, updated, unchanged, conflictsDetected, skipped: plan.skipped, failed };

  if (syncRunId) {
    await dbSession.db
      .update(syncRuns)
      .set({
        status: "completed",
        countsJson: JSON.stringify({ applied, unchanged, skipped: plan.skipped.length, failed: failed.length, conflicts: conflictsDetected }),
        error: null,
        completedAt: new Date(),
      })
      .where(and(eq(syncRuns.organizationId, organizationId), eq(syncRuns.id, syncRunId)));
  }

  return result;
  });
}

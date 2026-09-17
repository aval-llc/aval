/**
 * Properties and units: the spine everything else in the operations model
 * hangs off.
 *
 * Every query is org-scoped, and every write that takes a caller-supplied id
 * (a `propertyId` on a new unit, say) looks that id up within the org first
 * rather than trusting it — the same cross-tenant discipline
 * `lib/infrastructure/meters.ts` applies to meter ids, for the same reason:
 * an id in a request body is input, not a fact.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { leases, properties, units } from "@/db/postgres/schema";
import { manualSource, planMerge, recordConflicts, type SourceRef } from "./provenance";
import {
  summarizeOccupancy,
  summarizeRentPosition,
  summarizeUnitMix,
  summarizeVacancyDuration,
  type OccupancySummary,
  type RentPositionSummary,
  type UnitMixRow,
  type VacancyDurationSummary,
} from "./metrics/occupancy";
import { OCCUPIED_UNIT_STATUSES, type PropertyType, type UnitStatus } from "./types";

// Re-exported so the repositories stay the obvious import site for callers,
// while the class itself lives in errors.ts — see the note there on why the
// error types must not drag `@/db` into route paths.
export { EntityNotFoundError } from "./errors";
import { EntityNotFoundError } from "./errors";

/* ── properties ─────────────────────────────────────────────────────────── */

export interface PropertyInput {
  name: string;
  addressLine1?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string;
  propertyType?: PropertyType;
  reportedUnitCount?: number | null;
  yearBuilt?: number | null;
  squareFeet?: number | null;
  acquisitionCostCents?: number | null;
  currentValueCents?: number | null;
  status?: "active" | "inactive";
}

/** Fields a connected source may write. Explicit so adding a column can't silently become syncable — see `planMerge`. */
const PROPERTY_SYNCABLE_FIELDS = [
  "name",
  "addressLine1",
  "city",
  "region",
  "postalCode",
  "country",
  "propertyType",
  "reportedUnitCount",
  "yearBuilt",
  "squareFeet",
  "acquisitionCostCents",
  "currentValueCents",
  "status",
] as const;

export async function createProperty(dbSession: DbSession, organizationId: string, input: PropertyInput, source: SourceRef = manualSource()) {
  const db = dbSession.db;
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    name: input.name,
    addressLine1: input.addressLine1 ?? null,
    city: input.city ?? null,
    region: input.region ?? null,
    postalCode: input.postalCode ?? null,
    country: input.country ?? "US",
    propertyType: input.propertyType ?? "multifamily",
    reportedUnitCount: input.reportedUnitCount ?? null,
    yearBuilt: input.yearBuilt ?? null,
    squareFeet: input.squareFeet ?? null,
    acquisitionCostCents: input.acquisitionCostCents ?? null,
    currentValueCents: input.currentValueCents ?? null,
    status: input.status ?? "active",
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(properties).values(row);
  return row;
}

export async function listProperties(dbSession: DbSession, organizationId: string) {
  return dbSession.db.select().from(properties).where(eq(properties.organizationId, organizationId)).orderBy(properties.name);
}

export async function getProperty(dbSession: DbSession, organizationId: string, propertyId: string) {
  const [row] = await dbSession.db
    .select()
    .from(properties)
    .where(and(eq(properties.organizationId, organizationId), eq(properties.id, propertyId)))
    .limit(1);
  return row ?? null;
}

/**
 * Writes a property from a connected source, matching an existing row by that
 * source's own external id first and by name second.
 *
 * The name fallback is what lets a property already entered by hand, or synced
 * from a different system, be recognized rather than duplicated — which is the
 * whole point of a canonical model. It is also a heuristic, and a weak one for
 * portfolios with repeated building names, so it matches on an exact trimmed
 * name only. A near-miss creates a second property, which is visible and
 * fixable; a wrong merge silently combines two buildings' figures, which is
 * neither.
 */
export async function upsertPropertyFromSource(dbSession: DbSession, organizationId: string, input: PropertyInput, source: SourceRef) {
  const db = dbSession.db;
  const existing = await findPropertyMatch(dbSession, organizationId, input.name, source);
  if (!existing) return { property: await createProperty(dbSession, organizationId, input, source), created: true, conflicts: 0 };

  const plan = planMerge(existing, existing.sourceProvider, input as Partial<typeof existing>, source.sourceProvider, PROPERTY_SYNCABLE_FIELDS);
  if (Object.keys(plan.updates).length > 0) {
    await db
      .update(properties)
      .set({ ...plan.updates, updatedAt: new Date() })
      .where(and(eq(properties.organizationId, organizationId), eq(properties.id, existing.id)));
  }
  await recordConflicts(dbSession, organizationId, "property", existing.id, plan.conflicts);
  return { property: { ...existing, ...plan.updates }, created: false, updated: Object.keys(plan.updates).length > 0, conflicts: plan.conflicts.length };
}

async function findPropertyMatch(dbSession: DbSession, organizationId: string, name: string, source: SourceRef) {
  const db = dbSession.db;
  if (source.externalId) {
    const [byExternal] = await db
      .select()
      .from(properties)
      .where(
        and(
          eq(properties.organizationId, organizationId),
          eq(properties.sourceProvider, source.sourceProvider),
          eq(properties.externalId, source.externalId),
        ),
      )
      .limit(1);
    if (byExternal) return byExternal;
  }
  const [byName] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.organizationId, organizationId), eq(properties.name, name.trim())))
    .limit(1);
  return byName ?? null;
}

/* ── units ──────────────────────────────────────────────────────────────── */

export interface UnitInput {
  propertyId: string;
  unitNumber: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFeet?: number | null;
  marketRentCents?: number | null;
  status?: UnitStatus;
  vacantSince?: Date | null;
}

const UNIT_SYNCABLE_FIELDS = [
  "unitNumber",
  "bedrooms",
  "bathrooms",
  "squareFeet",
  "marketRentCents",
  "status",
  "vacantSince",
] as const;

export async function createUnit(dbSession: DbSession, organizationId: string, input: UnitInput, source: SourceRef = manualSource()) {
  const property = await getProperty(dbSession, organizationId, input.propertyId);
  if (!property) throw new EntityNotFoundError("Property", input.propertyId);

  const status = input.status ?? "vacant_ready";
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    propertyId: input.propertyId,
    unitNumber: input.unitNumber,
    bedrooms: input.bedrooms ?? null,
    bathrooms: input.bathrooms ?? null,
    squareFeet: input.squareFeet ?? null,
    marketRentCents: input.marketRentCents ?? null,
    status,
    // A unit created vacant is vacant as of now unless the caller knows
    // better. Left null for an occupied unit rather than backfilled, so
    // days-vacant is never measured from a date nobody observed.
    vacantSince: input.vacantSince ?? (OCCUPIED_UNIT_STATUSES.includes(status) ? null : now),
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(units).values(row);
  return row;
}

export async function listUnits(dbSession: DbSession, organizationId: string, filters: { propertyId?: string; status?: UnitStatus } = {}) {
  const conditions = [eq(units.organizationId, organizationId)];
  if (filters.propertyId) conditions.push(eq(units.propertyId, filters.propertyId));
  if (filters.status) conditions.push(eq(units.status, filters.status));
  return dbSession.db.select().from(units).where(and(...conditions)).orderBy(units.unitNumber);
}

export async function getUnit(dbSession: DbSession, organizationId: string, unitId: string) {
  const [row] = await dbSession.db
    .select()
    .from(units)
    .where(and(eq(units.organizationId, organizationId), eq(units.id, unitId)))
    .limit(1);
  return row ?? null;
}

/**
 * Changes a unit's status, maintaining `vacantSince` as a side effect.
 *
 * The bookkeeping matters more than it looks: `vacantSince` is what every
 * days-vacant figure is measured from, and a status change that left it stale
 * would keep reporting a re-leased unit as vacant for months. Moving *into* a
 * vacant status stamps the date; moving out of one clears it.
 */
export async function setUnitStatus(dbSession: DbSession, organizationId: string, unitId: string, status: UnitStatus, asOf = new Date()) {
  const unit = await getUnit(dbSession, organizationId, unitId);
  if (!unit) throw new EntityNotFoundError("Unit", unitId);

  const wasOccupied = OCCUPIED_UNIT_STATUSES.includes(unit.status as UnitStatus);
  const isOccupied = OCCUPIED_UNIT_STATUSES.includes(status);
  let vacantSince = unit.vacantSince;
  if (isOccupied) vacantSince = null;
  else if (wasOccupied || unit.vacantSince === null) vacantSince = asOf;

  await dbSession.db
    .update(units)
    .set({ status, vacantSince, updatedAt: new Date() })
    .where(and(eq(units.organizationId, organizationId), eq(units.id, unitId)));
  return { ...unit, status, vacantSince };
}

export async function upsertUnitFromSource(dbSession: DbSession, organizationId: string, input: UnitInput, source: SourceRef) {
  const db = dbSession.db;
  const property = await getProperty(dbSession, organizationId, input.propertyId);
  if (!property) throw new EntityNotFoundError("Property", input.propertyId);

  let existing = null;
  if (source.externalId) {
    const [byExternal] = await db
      .select()
      .from(units)
      .where(
        and(
          eq(units.organizationId, organizationId),
          eq(units.sourceProvider, source.sourceProvider),
          eq(units.externalId, source.externalId),
        ),
      )
      .limit(1);
    existing = byExternal ?? null;
  }
  if (!existing) {
    // Within a property, a unit number is the natural key operators use, and
    // the one every source has.
    const [byNumber] = await db
      .select()
      .from(units)
      .where(
        and(
          eq(units.organizationId, organizationId),
          eq(units.propertyId, input.propertyId),
          eq(units.unitNumber, input.unitNumber.trim()),
        ),
      )
      .limit(1);
    existing = byNumber ?? null;
  }

  if (!existing) return { unit: await createUnit(dbSession, organizationId, input, source), created: true, conflicts: 0 };

  const plan = planMerge(existing, existing.sourceProvider, input as Partial<typeof existing>, source.sourceProvider, UNIT_SYNCABLE_FIELDS);
  if (Object.keys(plan.updates).length > 0) {
    await db
      .update(units)
      .set({ ...plan.updates, updatedAt: new Date() })
      .where(and(eq(units.organizationId, organizationId), eq(units.id, existing.id)));
  }
  await recordConflicts(dbSession, organizationId, "unit", existing.id, plan.conflicts);
  return { unit: { ...existing, ...plan.updates }, created: false, updated: Object.keys(plan.updates).length > 0, conflicts: plan.conflicts.length };
}

/* ── read models ────────────────────────────────────────────────────────── */

export interface PortfolioSummary {
  propertyCount: number;
  occupancy: OccupancySummary;
  vacancy: VacancyDurationSummary;
  rentPosition: RentPositionSummary;
  unitMix: UnitMixRow[];
  /**
   * Properties whose source-reported unit count differs from the number of
   * unit rows actually present. A live signal that a sync is incomplete, kept
   * visible rather than reconciled away — see `properties.reportedUnitCount`.
   */
  unitCountMismatches: { propertyId: string; propertyName: string; reported: number; actual: number }[];
}

export async function summarizePortfolio(dbSession: DbSession, organizationId: string, asOf = new Date()): Promise<PortfolioSummary> {
  const db = dbSession.db;
  const [propertyRows, unitRows] = await Promise.all([
    listProperties(dbSession, organizationId),
    db.select().from(units).where(eq(units.organizationId, organizationId)),
  ]);

  const activeLeases = await db
    .select({ unitId: leases.unitId, rentCents: leases.rentCents })
    .from(leases)
    .where(and(eq(leases.organizationId, organizationId), eq(leases.status, "active")));

  const unitLikes = unitRows.map((unit) => ({
    id: unit.id,
    propertyId: unit.propertyId,
    status: unit.status as UnitStatus,
    marketRentCents: unit.marketRentCents,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    vacantSince: unit.vacantSince,
  }));

  const actualByProperty = new Map<string, number>();
  for (const unit of unitRows) actualByProperty.set(unit.propertyId, (actualByProperty.get(unit.propertyId) ?? 0) + 1);

  return {
    propertyCount: propertyRows.length,
    occupancy: summarizeOccupancy(unitLikes),
    vacancy: summarizeVacancyDuration(unitLikes, asOf),
    rentPosition: summarizeRentPosition(unitLikes, activeLeases),
    unitMix: summarizeUnitMix(unitLikes),
    unitCountMismatches: propertyRows
      .filter((property) => property.reportedUnitCount !== null && property.reportedUnitCount !== (actualByProperty.get(property.id) ?? 0))
      .map((property) => ({
        propertyId: property.id,
        propertyName: property.name,
        reported: property.reportedUnitCount as number,
        actual: actualByProperty.get(property.id) ?? 0,
      })),
  };
}

/** Units per property, for metrics that normalize by unit count (NOI per unit, maintenance cost per unit). */
export async function unitCountsByProperty(dbSession: DbSession, organizationId: string): Promise<Map<string, number>> {
  const rows = await dbSession.db
    .select({ propertyId: units.propertyId })
    .from(units)
    .where(eq(units.organizationId, organizationId));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.propertyId, (counts.get(row.propertyId) ?? 0) + 1);
  return counts;
}

/** Property names by id, for read models that report per-property figures without joining in every query. */
export async function propertyNames(dbSession: DbSession, organizationId: string, propertyIds: string[]): Promise<Map<string, string>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await dbSession.db
    .select({ id: properties.id, name: properties.name })
    .from(properties)
    .where(and(eq(properties.organizationId, organizationId), inArray(properties.id, propertyIds)));
  return new Map(rows.map((row) => [row.id, row.name]));
}

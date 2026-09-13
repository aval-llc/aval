/**
 * Work orders and vendors.
 *
 * The lifecycle transitions here stamp timestamps rather than only changing a
 * status, because every maintenance metric an operator uses is a difference
 * between two of those stamps (see `metrics/maintenance.ts`). A status field
 * that moves without a timestamp can say work is done but never how long it
 * took, which is the number that actually costs money.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { InvalidWorkOrderTransitionError } from "./errors";
import type { DbSession } from "@/db/postgres/session";
import { units, vendors, workOrders } from "@/db/postgres/schema";
import { EntityNotFoundError, getProperty, getUnit, propertyNames, unitCountsByProperty } from "./portfolio";
import { manualSource, type SourceRef } from "./provenance";
import {
  buildVendorScorecards,
  costPerUnitCents,
  firstTimeFixPct,
  suggestCallbacks,
  summarizeByCategory,
  summarizeMaintenance,
  summarizeSlaCompliance,
  type CallbackSuggestion,
  type CategoryRow,
  type MaintenanceSummary,
  type SlaComplianceRow,
  type VendorScorecardRow,
  type WorkOrderLike,
} from "./metrics/maintenance";
import {
  CALLBACK_SUGGESTION_WINDOW_DAYS,
  DEFAULT_SLA_TARGET_HOURS,
  OPEN_WORK_ORDER_STATUSES,
  type WorkOrderCategory,
  type WorkOrderPriority,
  type WorkOrderStatus,
} from "./types";

/* ── vendors ────────────────────────────────────────────────────────────── */

export interface VendorInput {
  name: string;
  trade?: string | null;
  email?: string | null;
  phone?: string | null;
  insuranceExpiresAt?: Date | null;
  isActive?: boolean;
}

export async function createVendor(dbSession: DbSession, organizationId: string, input: VendorInput, source: SourceRef = manualSource()) {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    name: input.name,
    trade: input.trade ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    insuranceExpiresAt: input.insuranceExpiresAt ?? null,
    isActive: input.isActive ?? true,
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(vendors).values(row);
  return row;
}

export async function listVendors(dbSession: DbSession, organizationId: string, activeOnly = false) {
  const conditions = [eq(vendors.organizationId, organizationId)];
  if (activeOnly) conditions.push(eq(vendors.isActive, true));
  return dbSession.db.select().from(vendors).where(and(...conditions)).orderBy(vendors.name);
}

export async function getVendor(dbSession: DbSession, organizationId: string, vendorId: string) {
  const [row] = await dbSession.db
    .select()
    .from(vendors)
    .where(and(eq(vendors.organizationId, organizationId), eq(vendors.id, vendorId)))
    .limit(1);
  return row ?? null;
}

/* ── work orders ────────────────────────────────────────────────────────── */

export interface WorkOrderInput {
  propertyId: string;
  unitId?: string | null;
  leaseId?: string | null;
  category?: WorkOrderCategory;
  priority?: WorkOrderPriority;
  summary: string;
  reportedAt?: Date;
  vendorId?: string | null;
  estimateCents?: number | null;
  callbackOfWorkOrderId?: string | null;
}

export async function createWorkOrder(dbSession: DbSession, organizationId: string, input: WorkOrderInput, source: SourceRef = manualSource()) {
  const property = await getProperty(dbSession, organizationId, input.propertyId);
  if (!property) throw new EntityNotFoundError("Property", input.propertyId);

  // Every caller-supplied id is verified inside the org before it is stored —
  // an id in a request body is input, not a fact.
  if (input.unitId) {
    const unit = await getUnit(dbSession, organizationId, input.unitId);
    if (!unit) throw new EntityNotFoundError("Unit", input.unitId);
    if (unit.propertyId !== input.propertyId) {
      throw new EntityNotFoundError("Unit", `${input.unitId} (belongs to a different property)`);
    }
  }
  if (input.vendorId) {
    const vendor = await getVendor(dbSession, organizationId, input.vendorId);
    if (!vendor) throw new EntityNotFoundError("Vendor", input.vendorId);
  }
  if (input.callbackOfWorkOrderId) {
    const original = await getWorkOrder(dbSession, organizationId, input.callbackOfWorkOrderId);
    if (!original) throw new EntityNotFoundError("Work order", input.callbackOfWorkOrderId);
  }

  const now = new Date();
  const assigned = Boolean(input.vendorId);
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    propertyId: input.propertyId,
    unitId: input.unitId ?? null,
    leaseId: input.leaseId ?? null,
    category: input.category ?? "general",
    priority: input.priority ?? "routine",
    status: (assigned ? "assigned" : "reported") as WorkOrderStatus,
    summary: input.summary,
    reportedAt: input.reportedAt ?? now,
    // Stamped only when a vendor is named at creation. A work order created
    // unassigned has genuinely not been assigned yet, and back-dating that to
    // the report time would report a zero response time for work nobody has
    // touched — flattering exactly the metric that matters most.
    assignedAt: assigned ? now : null,
    startedAt: null as Date | null,
    completedAt: null as Date | null,
    vendorId: input.vendorId ?? null,
    estimateCents: input.estimateCents ?? null,
    actualCostCents: null as number | null,
    callbackOfWorkOrderId: input.callbackOfWorkOrderId ?? null,
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(workOrders).values(row);
  return row;
}

export async function getWorkOrder(dbSession: DbSession, organizationId: string, workOrderId: string) {
  const [row] = await dbSession.db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, workOrderId)))
    .limit(1);
  return row ?? null;
}

export async function listWorkOrders(dbSession: DbSession,
  organizationId: string,
  filters: { status?: WorkOrderStatus; openOnly?: boolean; propertyId?: string; vendorId?: string; since?: Date } = {}
) {
  const conditions = [eq(workOrders.organizationId, organizationId)];
  if (filters.status) conditions.push(eq(workOrders.status, filters.status));
  if (filters.propertyId) conditions.push(eq(workOrders.propertyId, filters.propertyId));
  if (filters.vendorId) conditions.push(eq(workOrders.vendorId, filters.vendorId));

  const rows = await dbSession.db
    .select()
    .from(workOrders)
    .where(and(...conditions))
    .orderBy(desc(workOrders.reportedAt));

  return rows.filter(
    (row) =>
      (!filters.openOnly || OPEN_WORK_ORDER_STATUSES.includes(row.status as WorkOrderStatus)) &&
      (!filters.since || row.reportedAt >= filters.since),
  );
}

export async function assignWorkOrder(dbSession: DbSession, organizationId: string, workOrderId: string, vendorId: string, at = new Date()) {
  const order = await getWorkOrder(dbSession, organizationId, workOrderId);
  if (!order) throw new EntityNotFoundError("Work order", workOrderId);
  const vendor = await getVendor(dbSession, organizationId, vendorId);
  if (!vendor) throw new EntityNotFoundError("Vendor", vendorId);

  const [updated] = await dbSession.db
    .update(workOrders)
    // `assignedAt` keeps its original value on reassignment. Response time is
    // measured to the *first* assignment; restamping it would let a work order
    // passed between three vendors report the last handoff as its response.
    .set({ vendorId, status: "assigned", assignedAt: sql`coalesce(${workOrders.assignedAt}, ${at})`, updatedAt: new Date() })
    .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, workOrderId), inArray(workOrders.status, [...OPEN_WORK_ORDER_STATUSES])))
    .returning();
  if (!updated) throw new InvalidWorkOrderTransitionError();
  return updated;
}

export async function startWorkOrder(dbSession: DbSession, organizationId: string, workOrderId: string, at = new Date()) {
  const order = await getWorkOrder(dbSession, organizationId, workOrderId);
  if (!order) throw new EntityNotFoundError("Work order", workOrderId);
  const [updated] = await dbSession.db
    .update(workOrders)
    .set({ status: "in_progress", startedAt: sql`coalesce(${workOrders.startedAt}, ${at})`, updatedAt: new Date() })
    .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, workOrderId), inArray(workOrders.status, [...OPEN_WORK_ORDER_STATUSES])))
    .returning();
  if (!updated) throw new InvalidWorkOrderTransitionError();
  return updated;
}

export async function completeWorkOrder(dbSession: DbSession,
  organizationId: string,
  workOrderId: string,
  options: { at?: Date; actualCostCents?: number | null } = {}
) {
  const order = await getWorkOrder(dbSession, organizationId, workOrderId);
  if (!order) throw new EntityNotFoundError("Work order", workOrderId);

  const completedAt = options.at ?? new Date();
  const [updated] = await dbSession.db
    .update(workOrders)
    .set({
      status: "completed",
      completedAt,
      actualCostCents: options.actualCostCents ?? sql`${workOrders.actualCostCents}`,
      updatedAt: new Date(),
    })
    .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, workOrderId), inArray(workOrders.status, [...OPEN_WORK_ORDER_STATUSES])))
    .returning();
  if (!updated) throw new InvalidWorkOrderTransitionError();
  return updated;
}

/**
 * Links a work order to the earlier one it is a return visit for.
 *
 * Only ever called on a human's say-so — including from
 * `suggestCallbacks`'s output after someone confirms it. Nothing in this
 * module writes the link automatically, because first-time-fix rate feeds
 * vendor renewals and an inferred callback is a guess with a vendor's contract
 * attached to it.
 */
export async function linkCallback(dbSession: DbSession, organizationId: string, workOrderId: string, originalWorkOrderId: string) {
  const [order, original] = await Promise.all([
    getWorkOrder(dbSession, organizationId, workOrderId),
    getWorkOrder(dbSession, organizationId, originalWorkOrderId),
  ]);
  if (!order) throw new EntityNotFoundError("Work order", workOrderId);
  if (!original) throw new EntityNotFoundError("Work order", originalWorkOrderId);
  if (workOrderId === originalWorkOrderId) throw new Error("A work order cannot be a callback of itself");

  await dbSession.db
    .update(workOrders)
    .set({ callbackOfWorkOrderId: originalWorkOrderId, updatedAt: new Date() })
    .where(and(eq(workOrders.organizationId, organizationId), eq(workOrders.id, workOrderId)));
  return { ...order, callbackOfWorkOrderId: originalWorkOrderId };
}

/* ── read model ─────────────────────────────────────────────────────────── */

export interface VendorScorecardWithName extends VendorScorecardRow {
  vendorName: string;
  trade: string | null;
  /** True when the vendor's certificate of insurance has lapsed as of the report date. Compliance, not trivia. */
  insuranceExpired: boolean;
  insuranceExpiresAt: Date | null;
}

export interface MaintenanceReport {
  summary: MaintenanceSummary;
  sla: SlaComplianceRow[];
  byCategory: CategoryRow[];
  vendors: VendorScorecardWithName[];
  firstTimeFixPct: number | null;
  /** Portfolio maintenance spend per unit, over the window. Null when no units are on file to divide by. */
  costPerUnitCents: number | null;
  /** Possible unlogged callbacks for a human to confirm. Never counted in any metric above. */
  callbackSuggestions: CallbackSuggestion[];
  /** Properties ranked by spend, so a portfolio-level figure can be traced to where it came from. */
  spendByProperty: { propertyId: string; propertyName: string; workOrderCount: number; totalCostCents: number; costPerUnitCents: number | null }[];
  /** The SLA targets every compliance figure above was measured against. Aval defaults, not the workspace's contracts. */
  slaTargetHours: Record<WorkOrderPriority, number>;
  periodStart: Date;
  periodEnd: Date;
}

export async function summarizeMaintenanceOperations(dbSession: DbSession,
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  asOf = new Date()
): Promise<MaintenanceReport> {
  const db = dbSession.db;
  const rows = await db.select().from(workOrders).where(eq(workOrders.organizationId, organizationId));
  const inPeriod = rows.filter((row) => row.reportedAt >= periodStart && row.reportedAt <= periodEnd);

  const likes: WorkOrderLike[] = inPeriod.map((row) => ({
    id: row.id,
    propertyId: row.propertyId,
    unitId: row.unitId,
    vendorId: row.vendorId,
    category: row.category as WorkOrderCategory,
    priority: row.priority as WorkOrderPriority,
    status: row.status as WorkOrderStatus,
    reportedAt: row.reportedAt,
    assignedAt: row.assignedAt,
    completedAt: row.completedAt,
    estimateCents: row.estimateCents,
    actualCostCents: row.actualCostCents,
    callbackOfWorkOrderId: row.callbackOfWorkOrderId,
  }));

  const [vendorRows, unitCounts] = await Promise.all([
    listVendors(dbSession, organizationId),
    unitCountsByProperty(dbSession, organizationId),
  ]);
  const vendorById = new Map(vendorRows.map((vendor) => [vendor.id, vendor]));

  const totalUnits = [...unitCounts.values()].reduce((total, count) => total + count, 0);

  const spendByPropertyMap = new Map<string, { workOrderCount: number; totalCostCents: number }>();
  for (const order of likes) {
    const entry = spendByPropertyMap.get(order.propertyId) ?? { workOrderCount: 0, totalCostCents: 0 };
    entry.workOrderCount += 1;
    entry.totalCostCents += order.actualCostCents ?? 0;
    spendByPropertyMap.set(order.propertyId, entry);
  }
  const names = await propertyNames(dbSession, organizationId, [...spendByPropertyMap.keys()]);

  return {
    summary: summarizeMaintenance(likes, asOf),
    sla: summarizeSlaCompliance(likes, asOf),
    byCategory: summarizeByCategory(likes),
    vendors: buildVendorScorecards(likes).map((scorecard) => {
      const vendor = vendorById.get(scorecard.vendorId);
      return {
        ...scorecard,
        vendorName: vendor?.name ?? "Unknown vendor",
        trade: vendor?.trade ?? null,
        insuranceExpired: vendor?.insuranceExpiresAt ? vendor.insuranceExpiresAt < asOf : false,
        insuranceExpiresAt: vendor?.insuranceExpiresAt ?? null,
      };
    }),
    firstTimeFixPct: firstTimeFixPct(likes),
    costPerUnitCents: costPerUnitCents(likes, totalUnits),
    // Run over the whole history, not just the window: a callback in October
    // for work completed in September is exactly the case worth catching, and
    // clipping to the window would hide every cross-boundary one.
    callbackSuggestions: suggestCallbacks(
      rows.map((row) => ({
        id: row.id,
        propertyId: row.propertyId,
        unitId: row.unitId,
        vendorId: row.vendorId,
        category: row.category as WorkOrderCategory,
        priority: row.priority as WorkOrderPriority,
        status: row.status as WorkOrderStatus,
        reportedAt: row.reportedAt,
        assignedAt: row.assignedAt,
        completedAt: row.completedAt,
        estimateCents: row.estimateCents,
        actualCostCents: row.actualCostCents,
        callbackOfWorkOrderId: row.callbackOfWorkOrderId,
      })),
      CALLBACK_SUGGESTION_WINDOW_DAYS,
    ),
    spendByProperty: [...spendByPropertyMap.entries()]
      .map(([propertyId, entry]) => ({
        propertyId,
        propertyName: names.get(propertyId) ?? "Unknown property",
        workOrderCount: entry.workOrderCount,
        totalCostCents: entry.totalCostCents,
        costPerUnitCents:
          (unitCounts.get(propertyId) ?? 0) > 0
            ? Math.round(entry.totalCostCents / (unitCounts.get(propertyId) as number))
            : null,
      }))
      .sort((a, b) => b.totalCostCents - a.totalCostCents),
    slaTargetHours: DEFAULT_SLA_TARGET_HOURS,
    periodStart,
    periodEnd,
  };
}

/** Units with an open work order, for the Properties tab's "why is this unit not rent-ready" question. */
export async function unitsWithOpenWork(dbSession: DbSession, organizationId: string) {
  const rows = await dbSession.db
    .select({
      workOrderId: workOrders.id,
      unitId: workOrders.unitId,
      unitNumber: units.unitNumber,
      summary: workOrders.summary,
      priority: workOrders.priority,
      status: workOrders.status,
      reportedAt: workOrders.reportedAt,
    })
    .from(workOrders)
    .innerJoin(units, eq(workOrders.unitId, units.id))
    .where(
      and(
        eq(workOrders.organizationId, organizationId),
        inArray(workOrders.status, [...OPEN_WORK_ORDER_STATUSES]),
      ),
    )
    .orderBy(desc(workOrders.reportedAt));
  return rows;
}

/**
 * Residents, leases and leasing leads.
 *
 * Org-scoped like every other operations module, with the extra care residents
 * warrant: this is the one table here holding personal contact data, so it is
 * never copied into `learned_preferences` or `answer_audit_log` (which store
 * tags and digests precisely so they cannot become a second copy of it), and
 * the list endpoints return whole rows only to the workspace that owns them.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { leaseResidents, leases, leasingLeads, residents, units } from "@/db/postgres/schema";
import { EntityNotFoundError, getUnit, setUnitStatus } from "./portfolio";
import { manualSource, type SourceRef } from "./provenance";
import {
  summarizeByChannel,
  summarizeByUnitType,
  summarizeExpirations,
  summarizeFunnel,
  summarizeFunnelHealth,
  summarizeLostReasons,
  summarizeRenewals,
  type FunnelHealth,
  type FunnelStageRow,
  type LeadLike,
  type LostReasonRow,
  type RenewalSummary,
  type SegmentPerformance,
} from "./metrics/funnel";
import { unitTypeLabel } from "./metrics/occupancy";
import { LEAD_STAGES, type LeadStage, type LeaseResidentRole, type LeaseStatus, type ResidentStatus } from "./types";

/* ── residents ──────────────────────────────────────────────────────────── */

export interface ResidentInput {
  displayName: string;
  email?: string | null;
  phone?: string | null;
  status?: ResidentStatus;
}

export async function createResident(dbSession: DbSession, organizationId: string, input: ResidentInput, source: SourceRef = manualSource()) {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    displayName: input.displayName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    status: input.status ?? "current",
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(residents).values(row);
  return row;
}

export async function listResidents(dbSession: DbSession, organizationId: string, status?: ResidentStatus) {
  const conditions = [eq(residents.organizationId, organizationId)];
  if (status) conditions.push(eq(residents.status, status));
  return dbSession.db.select().from(residents).where(and(...conditions)).orderBy(residents.displayName);
}

/* ── leases ─────────────────────────────────────────────────────────────── */

export interface LeaseInput {
  unitId: string;
  status?: LeaseStatus;
  startDate: Date;
  endDate?: Date | null;
  isMonthToMonth?: boolean;
  moveInDate?: Date | null;
  moveOutDate?: Date | null;
  rentCents: number;
  depositCents?: number;
  rentDueDay?: number;
  renewalOfLeaseId?: string | null;
}

/**
 * Creates a lease and, when it is active, moves its unit to occupied.
 *
 * The status change is done here rather than left to the caller because the
 * two facts are the same fact: a unit with a signed active lease is occupied,
 * and letting them drift apart puts a contradiction into the data every
 * occupancy figure is computed from. `setUnitStatus` also clears
 * `vacantSince`, so days-vacant stops accruing on a unit that has been leased.
 */
export async function createLease(dbSession: DbSession, organizationId: string, input: LeaseInput, source: SourceRef = manualSource()) {
  const unit = await getUnit(dbSession, organizationId, input.unitId);
  if (!unit) throw new EntityNotFoundError("Unit", input.unitId);

  if (input.renewalOfLeaseId) {
    const prior = await getLease(dbSession, organizationId, input.renewalOfLeaseId);
    if (!prior) throw new EntityNotFoundError("Lease", input.renewalOfLeaseId);
  }

  const status = input.status ?? "active";
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    unitId: input.unitId,
    propertyId: unit.propertyId,
    status,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    isMonthToMonth: input.isMonthToMonth ?? false,
    moveInDate: input.moveInDate ?? null,
    moveOutDate: input.moveOutDate ?? null,
    rentCents: input.rentCents,
    depositCents: input.depositCents ?? 0,
    rentDueDay: input.rentDueDay ?? 1,
    renewalOfLeaseId: input.renewalOfLeaseId ?? null,
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(leases).values(row);

  if (status === "active") await setUnitStatus(dbSession, organizationId, input.unitId, "occupied", input.startDate);
  return row;
}

export async function getLease(dbSession: DbSession, organizationId: string, leaseId: string) {
  const [row] = await dbSession.db
    .select()
    .from(leases)
    .where(and(eq(leases.organizationId, organizationId), eq(leases.id, leaseId)))
    .limit(1);
  return row ?? null;
}

export async function listLeases(dbSession: DbSession,
  organizationId: string,
  filters: { status?: LeaseStatus; propertyId?: string; unitId?: string } = {}
) {
  const conditions = [eq(leases.organizationId, organizationId)];
  if (filters.status) conditions.push(eq(leases.status, filters.status));
  if (filters.propertyId) conditions.push(eq(leases.propertyId, filters.propertyId));
  if (filters.unitId) conditions.push(eq(leases.unitId, filters.unitId));
  return dbSession.db.select().from(leases).where(and(...conditions)).orderBy(desc(leases.startDate));
}

/**
 * Ends a lease and returns its unit to the vacant pool.
 *
 * Defaults the unit to `vacant_not_ready`, not `vacant_ready`: a unit a
 * resident just moved out of has not been turned yet, and defaulting it to
 * rent-ready would report inventory as available that nobody has walked. The
 * caller can say otherwise when it knows better.
 */
export async function endLease(dbSession: DbSession,
  organizationId: string,
  leaseId: string,
  options: { status?: Extract<LeaseStatus, "expired" | "terminated" | "renewed">; moveOutDate?: Date; unitStatus?: "vacant_ready" | "vacant_not_ready" } = {}
) {
  const lease = await getLease(dbSession, organizationId, leaseId);
  if (!lease) throw new EntityNotFoundError("Lease", leaseId);

  const moveOutDate = options.moveOutDate ?? new Date();
  await dbSession.db
    .update(leases)
    .set({ status: options.status ?? "expired", moveOutDate, updatedAt: new Date() })
    .where(and(eq(leases.organizationId, organizationId), eq(leases.id, leaseId)));

  // A renewal keeps the same resident in place; the unit never goes vacant.
  if (options.status !== "renewed") {
    await setUnitStatus(dbSession, organizationId, lease.unitId, options.unitStatus ?? "vacant_not_ready", moveOutDate);
  }
  return { ...lease, status: options.status ?? "expired", moveOutDate };
}

export async function attachResidentToLease(dbSession: DbSession,
  organizationId: string,
  leaseId: string,
  residentId: string,
  role: LeaseResidentRole = "primary",
  source?: SourceRef
) {
  const [lease] = await dbSession.db
    .select({ id: leases.id })
    .from(leases)
    .where(and(eq(leases.organizationId, organizationId), eq(leases.id, leaseId)))
    .limit(1);
  if (!lease) throw new EntityNotFoundError("Lease", leaseId);

  const [resident] = await dbSession.db
    .select({ id: residents.id })
    .from(residents)
    .where(and(eq(residents.organizationId, organizationId), eq(residents.id, residentId)))
    .limit(1);
  if (!resident) throw new EntityNotFoundError("Resident", residentId);

  const row = { id: crypto.randomUUID(), organizationId, leaseId, residentId, role, sourceProvider: source?.sourceProvider ?? null, sourceConnectionId: source?.sourceConnectionId ?? null, createdAt: new Date() };
  await dbSession.db.insert(leaseResidents).values(row).onConflictDoNothing();
  return row;
}

/** Residents on each of the given leases, for collections and inbox surfaces that need a name and a channel. */
export async function residentsForLeases(dbSession: DbSession, organizationId: string, leaseIds: string[]) {
  if (leaseIds.length === 0) return new Map<string, { id: string; displayName: string; email: string | null; phone: string | null; role: string }[]>();
  const rows = await dbSession.db
    .select({
      leaseId: leaseResidents.leaseId,
      role: leaseResidents.role,
      id: residents.id,
      displayName: residents.displayName,
      email: residents.email,
      phone: residents.phone,
    })
    .from(leaseResidents)
    .innerJoin(residents, eq(leaseResidents.residentId, residents.id))
    .where(and(eq(leaseResidents.organizationId, organizationId), inArray(leaseResidents.leaseId, leaseIds)));

  const byLease = new Map<string, { id: string; displayName: string; email: string | null; phone: string | null; role: string }[]>();
  for (const row of rows) {
    const list = byLease.get(row.leaseId) ?? [];
    list.push({ id: row.id, displayName: row.displayName, email: row.email, phone: row.phone, role: row.role });
    byLease.set(row.leaseId, list);
  }
  return byLease;
}

/* ── leads ──────────────────────────────────────────────────────────────── */

export interface LeadInput {
  propertyId?: string | null;
  unitId?: string | null;
  residentId?: string | null;
  channel?: string | null;
  unitTypeLabel?: string | null;
  inquiredAt?: Date;
}

export async function createLead(dbSession: DbSession, organizationId: string, input: LeadInput, source: SourceRef = manualSource()) {
  // A lead pointing at a unit inherits that unit's type label when the caller
  // didn't supply one, so days-to-lease by unit type stays populated without
  // asking every connector to compute the same string.
  let label = input.unitTypeLabel ?? null;
  if (!label && input.unitId) {
    const unit = await getUnit(dbSession, organizationId, input.unitId);
    if (unit) label = unitTypeLabel(unit);
  }

  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    propertyId: input.propertyId ?? null,
    unitId: input.unitId ?? null,
    residentId: input.residentId ?? null,
    channel: input.channel ?? null,
    unitTypeLabel: label,
    stage: "inquiry" as string,
    inquiredAt: input.inquiredAt ?? now,
    contactedAt: null as Date | null,
    touredAt: null as Date | null,
    appliedAt: null as Date | null,
    approvedAt: null as Date | null,
    signedAt: null as Date | null,
    lostAt: null as Date | null,
    lostReason: null as string | null,
    ...source,
    createdAt: now,
    updatedAt: now,
  };
  await dbSession.db.insert(leasingLeads).values(row);
  return row;
}

/** Column each stage's timestamp lives in. Typed against the table so a renamed column fails the build rather than silently stopping the funnel from advancing. */
const STAGE_COLUMN = {
  inquiry: "inquiredAt",
  contacted: "contactedAt",
  toured: "touredAt",
  applied: "appliedAt",
  approved: "approvedAt",
  signed: "signedAt",
} as const;

/**
 * Advances a lead to a stage, stamping that stage's timestamp.
 *
 * Stamps every *earlier* unstamped stage too, at the same moment. A lead that
 * walks in and applies on the spot genuinely passed through "contacted" and
 * "toured", and leaving those null would drop it out of the denominator of
 * every conversion rate before that point — making the funnel look narrower
 * at the top than it was. The timestamps are honest about being simultaneous
 * rather than invented spread over days.
 */
export async function advanceLead(dbSession: DbSession, organizationId: string, leadId: string, stage: LeadStage, at = new Date()) {
  const [lead] = await dbSession.db
    .select()
    .from(leasingLeads)
    .where(and(eq(leasingLeads.organizationId, organizationId), eq(leasingLeads.id, leadId)))
    .limit(1);
  if (!lead) throw new EntityNotFoundError("Lead", leadId);

  const updates: Record<string, unknown> = { stage, updatedAt: new Date() };
  if (stage === "lost") {
    updates.lostAt = at;
  } else {
    const targetIndex = LEAD_STAGES.indexOf(stage);
    for (const earlier of LEAD_STAGES.slice(0, targetIndex + 1)) {
      const column = STAGE_COLUMN[earlier];
      if (lead[column] === null) updates[column] = at;
    }
  }

  await dbSession.db
    .update(leasingLeads)
    .set(updates)
    .where(and(eq(leasingLeads.organizationId, organizationId), eq(leasingLeads.id, leadId)));
  return { ...lead, ...updates };
}

export async function markLeadLost(dbSession: DbSession, organizationId: string, leadId: string, reason: string, at = new Date()) {
  const [lead] = await dbSession.db
    .select({ id: leasingLeads.id })
    .from(leasingLeads)
    .where(and(eq(leasingLeads.organizationId, organizationId), eq(leasingLeads.id, leadId)))
    .limit(1);
  if (!lead) throw new EntityNotFoundError("Lead", leadId);

  await dbSession.db
    .update(leasingLeads)
    .set({ stage: "lost", lostAt: at, lostReason: reason.trim().slice(0, 200) || null, updatedAt: new Date() })
    .where(and(eq(leasingLeads.organizationId, organizationId), eq(leasingLeads.id, leadId)));
}

export async function listLeads(dbSession: DbSession, organizationId: string, since?: Date) {
  const conditions = [eq(leasingLeads.organizationId, organizationId)];
  return dbSession.db
    .select()
    .from(leasingLeads)
    .where(and(...conditions))
    .orderBy(desc(leasingLeads.inquiredAt))
    .then((rows) => (since ? rows.filter((row) => row.inquiredAt >= since) : rows));
}

/* ── read model ─────────────────────────────────────────────────────────── */

export interface LeasingSummary {
  /** Null when this workspace has no leads at all — the tab has nothing to report, which is different from a funnel of zeroes. */
  funnel: FunnelStageRow[] | null;
  health: FunnelHealth | null;
  byChannel: SegmentPerformance[];
  byUnitType: SegmentPerformance[];
  lostReasons: LostReasonRow[];
  renewals: RenewalSummary | null;
  expirations: { schedule: { month: string; leaseCount: number; rentAtRiskCents: number }[]; monthToMonthCount: number };
  activeLeaseCount: number;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Everything the Leasing tab shows, over a window.
 *
 * `funnel` and `health` are null rather than empty for a workspace with no
 * leads: a funnel of zeroes reads as "we contacted nobody and converted
 * nobody", which is a performance claim, while null is the accurate "no
 * connected source has provided leasing data".
 */
export async function summarizeLeasing(dbSession: DbSession,
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
  asOf = new Date()
): Promise<LeasingSummary> {
  const db = dbSession.db;
  const [leadRows, leaseRows] = await Promise.all([
    db.select().from(leasingLeads).where(eq(leasingLeads.organizationId, organizationId)),
    db.select().from(leases).where(eq(leases.organizationId, organizationId)),
  ]);

  const inPeriod: LeadLike[] = leadRows
    .filter((lead) => lead.inquiredAt >= periodStart && lead.inquiredAt <= periodEnd)
    .map((lead) => ({
      id: lead.id,
      channel: lead.channel,
      unitTypeLabel: lead.unitTypeLabel,
      inquiredAt: lead.inquiredAt,
      contactedAt: lead.contactedAt,
      touredAt: lead.touredAt,
      appliedAt: lead.appliedAt,
      approvedAt: lead.approvedAt,
      signedAt: lead.signedAt,
      lostAt: lead.lostAt,
      lostReason: lead.lostReason,
    }));

  const hasLeads = inPeriod.length > 0;

  return {
    funnel: hasLeads ? summarizeFunnel(inPeriod) : null,
    health: hasLeads ? summarizeFunnelHealth(inPeriod) : null,
    byChannel: hasLeads ? summarizeByChannel(inPeriod) : [],
    byUnitType: hasLeads ? summarizeByUnitType(inPeriod) : [],
    lostReasons: hasLeads ? summarizeLostReasons(inPeriod) : [],
    renewals: leaseRows.length > 0 ? summarizeRenewals(leaseRows, periodStart, periodEnd) : null,
    expirations: summarizeExpirations(leaseRows, asOf),
    activeLeaseCount: leaseRows.filter((lease) => lease.status === "active").length,
    periodStart,
    periodEnd,
  };
}

/** Units with no active lease, for the "what can we actually rent" question the Leasing tab opens on. */
export async function availableUnits(dbSession: DbSession, organizationId: string) {
  return dbSession.db
    .select()
    .from(units)
    .where(and(eq(units.organizationId, organizationId), eq(units.status, "vacant_ready")))
    .orderBy(units.unitNumber);
}

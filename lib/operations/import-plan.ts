/**
 * The canonical import batch, and the pure planner that decides what a batch
 * would do before any of it touches the database.
 *
 * **Why this layer exists.** The operations tables landed with no way to get
 * data into them: `POST /api/sync` queues a `sync_runs` row and says the work
 * is "queued for the provider worker", and there is no provider worker. Real
 * connectors are also not something that can be written blind — RealPage is
 * gated behind its Exchange partner program, Entrata behind a signed agreement
 * and IP allowlisting — so the piece worth building first is the one every
 * connector eventually funnels into: take records already normalized to Aval's
 * vocabulary and apply them correctly.
 *
 * It is immediately useful on its own, too. The market research is blunt that
 * operators live in spreadsheet exports; a workspace can load its portfolio
 * through this today without waiting on a partner-program key.
 *
 * **References are by external id, never internal id.** A source system knows
 * its own ids and nothing about Aval's. So a unit names its property by that
 * property's id *in the source*, and resolution happens here.
 *
 * **This module is pure.** It takes the batch plus the set of external ids the
 * database already knows, and returns an ordered plan plus the rows it cannot
 * place. Nothing is written, nothing is fetched. That keeps the ordering and
 * reference-resolution rules — the part with all the sharp edges — testable
 * under `node --test`, the same split `metrics/` uses.
 */

import {
  GL_ACCOUNT_TYPES,
  LEASE_STATUSES,
  LEDGER_CATEGORIES,
  LEDGER_ENTRY_TYPES,
  PROPERTY_TYPES,
  RESIDENT_STATUSES,
  UNIT_STATUSES,
  WORK_ORDER_CATEGORIES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
} from "./types.ts";

/* ── the batch ───────────────────────────────────────────────────────────── */

/** Every importable row carries the id it has in the system it came from. */
interface ExternallyKeyed {
  externalId: string;
}

export interface ImportProperty extends ExternallyKeyed {
  name: string;
  addressLine1?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string;
  propertyType?: string;
  reportedUnitCount?: number | null;
  yearBuilt?: number | null;
  squareFeet?: number | null;
}

export interface ImportUnit extends ExternallyKeyed {
  propertyExternalId: string;
  unitNumber: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFeet?: number | null;
  marketRentCents?: number | null;
  status?: string;
  vacantSince?: string | null;
}

export interface ImportResident extends ExternallyKeyed {
  displayName: string;
  email?: string | null;
  phone?: string | null;
  status?: string;
}

export interface ImportLease extends ExternallyKeyed {
  unitExternalId: string;
  residentExternalIds?: string[];
  status?: string;
  startDate: string;
  endDate?: string | null;
  isMonthToMonth?: boolean;
  rentCents: number;
  depositCents?: number;
  rentDueDay?: number;
  renewalOfExternalId?: string | null;
}

export interface ImportLedgerEntry extends ExternallyKeyed {
  leaseExternalId: string;
  entryType: string;
  category: string;
  amountCents: number;
  postedAt: string;
  dueAt?: string | null;
  memo?: string | null;
}

export interface ImportVendor extends ExternallyKeyed {
  name: string;
  trade?: string | null;
  email?: string | null;
  phone?: string | null;
  insuranceExpiresAt?: string | null;
}

export interface ImportWorkOrder extends ExternallyKeyed {
  status?: string;
  propertyExternalId: string;
  unitExternalId?: string | null;
  vendorExternalId?: string | null;
  category?: string;
  priority?: string;
  summary: string;
  reportedAt: string;
  assignedAt?: string | null;
  completedAt?: string | null;
  estimateCents?: number | null;
  actualCostCents?: number | null;
  callbackOfExternalId?: string | null;
}

export interface ImportGlAccount extends ExternallyKeyed {
  code: string;
  name: string;
  accountType: string;
  isTrustAccount?: boolean;
}

export interface ImportGlTransaction extends ExternallyKeyed {
  accountExternalId: string;
  propertyExternalId?: string | null;
  amountCents: number;
  postedAt: string;
  memo?: string | null;
}

export interface ImportLead extends ExternallyKeyed {
  propertyExternalId?: string | null;
  unitExternalId?: string | null;
  channel?: string | null;
  unitTypeLabel?: string | null;
  inquiredAt: string;
  contactedAt?: string | null;
  touredAt?: string | null;
  appliedAt?: string | null;
  approvedAt?: string | null;
  signedAt?: string | null;
  lostAt?: string | null;
  lostReason?: string | null;
}

export interface ImportBatch {
  properties?: ImportProperty[];
  units?: ImportUnit[];
  residents?: ImportResident[];
  vendors?: ImportVendor[];
  glAccounts?: ImportGlAccount[];
  leases?: ImportLease[];
  ledgerEntries?: ImportLedgerEntry[];
  workOrders?: ImportWorkOrder[];
  glTransactions?: ImportGlTransaction[];
  leads?: ImportLead[];
}

/**
 * The order rows must be applied in, so a row's references already exist by
 * the time it is written.
 *
 * Declared once, here, rather than implied by the order of `if` blocks in the
 * applier. A dependency order that lives in control flow is one refactor away
 * from silently becoming wrong, and the failure mode — leases applied before
 * their units — looks like a partially-successful import rather than a bug.
 */
export const IMPORT_ORDER = [
  "properties",
  "units",
  "residents",
  "vendors",
  "glAccounts",
  "leases",
  "ledgerEntries",
  "workOrders",
  "glTransactions",
  "leads",
] as const;
export type ImportEntity = (typeof IMPORT_ORDER)[number];

/* ── the plan ────────────────────────────────────────────────────────────── */

export interface SkippedRow {
  entity: ImportEntity;
  externalId: string;
  /** Machine-readable, from a closed set — a UI groups on this rather than parsing prose. */
  reason: "missing_reference" | "invalid_field" | "duplicate_in_batch";
  detail: string;
}

export interface ImportPlan {
  /** Rows to apply, in dependency order, with their references validated. */
  steps: { entity: ImportEntity; rows: unknown[] }[];
  /** Rows that cannot be applied, each with why. Never silently dropped. */
  skipped: SkippedRow[];
  /** Per-entity count of rows that will be applied. */
  counts: Record<ImportEntity, number>;
}

/** External ids the database already holds, per entity — the caller supplies these. */
export type KnownExternalIds = Partial<Record<ImportEntity, ReadonlySet<string>>>;

const DATE_FIELDS_OK = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIntOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isInteger(value));
}

/**
 * Works out what a batch would do.
 *
 * Three rules, and the reason for each:
 *
 * - **A row referencing something that does not exist is skipped, with the
 *   missing id named.** Not dropped, and not applied with a null reference.
 *   A work order silently detached from its property still counts toward
 *   maintenance spend but disappears from that property's figures, which is
 *   worse than not importing it.
 * - **A reference may resolve inside the batch or in the database.** A nightly
 *   delta sends only what changed; requiring the whole portfolio in every
 *   batch would make incremental sync impossible.
 * - **A duplicate external id within one batch is skipped rather than
 *   last-one-wins.** Two rows claiming the same id means the source export is
 *   wrong, and picking one would hide that.
 */
export function planImport(batch: ImportBatch, known: KnownExternalIds = {}): ImportPlan {
  const skipped: SkippedRow[] = [];
  const counts = Object.fromEntries(IMPORT_ORDER.map((entity) => [entity, 0])) as Record<ImportEntity, number>;
  const steps: { entity: ImportEntity; rows: unknown[] }[] = [];

  // Ids that will exist once this batch is applied: what the database already
  // has, plus what this batch is about to add. Built up in dependency order,
  // so a unit can point at a property earlier in the same batch.
  const resolvable: Record<ImportEntity, Set<string>> = Object.fromEntries(
    IMPORT_ORDER.map((entity) => [entity, new Set(known[entity] ?? [])]),
  ) as Record<ImportEntity, Set<string>>;

  const skip = (entity: ImportEntity, externalId: string, reason: SkippedRow["reason"], detail: string) => {
    skipped.push({ entity, externalId, reason, detail });
  };

  for (const entity of IMPORT_ORDER) {
    const rows = (batch[entity] ?? []) as ExternallyKeyed[];
    const accepted: unknown[] = [];
    const seenInBatch = new Set<string>();

    for (const row of rows) {
      if (typeof row?.externalId !== "string" || row.externalId.trim() === "") {
        skip(entity, String((row as { externalId?: unknown })?.externalId ?? ""), "invalid_field", "externalId is required");
        continue;
      }
      const externalId = row.externalId;
      if (seenInBatch.has(externalId)) {
        skip(entity, externalId, "duplicate_in_batch", `${entity} externalId "${externalId}" appears more than once in this batch`);
        continue;
      }

      const problem = validateRow(entity, row, resolvable);
      if (problem) {
        skip(entity, externalId, problem.reason, problem.detail);
        continue;
      }

      seenInBatch.add(externalId);
      // Registered before the next entity is processed, so later rows in the
      // same batch can reference this one.
      resolvable[entity].add(externalId);
      accepted.push(row);
    }

    counts[entity] = accepted.length;
    if (accepted.length > 0) steps.push({ entity, rows: accepted });
  }

  return { steps, skipped, counts };
}

interface RowProblem {
  reason: SkippedRow["reason"];
  detail: string;
}

function requireRef(
  resolvable: Record<ImportEntity, Set<string>>,
  entity: ImportEntity,
  value: unknown,
  label: string,
): RowProblem | null {
  if (typeof value !== "string" || value.trim() === "") {
    return { reason: "invalid_field", detail: `${label} is required` };
  }
  if (!resolvable[entity].has(value)) {
    return { reason: "missing_reference", detail: `${label} "${value}" was not found in this batch or in the workspace` };
  }
  return null;
}

function optionalRef(
  resolvable: Record<ImportEntity, Set<string>>,
  entity: ImportEntity,
  value: unknown,
  label: string,
): RowProblem | null {
  if (value === undefined || value === null || value === "") return null;
  return requireRef(resolvable, entity, value, label);
}

function enumProblem(value: unknown, allowed: readonly string[], label: string): RowProblem | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    return { reason: "invalid_field", detail: `${label} must be one of: ${allowed.join(", ")}` };
  }
  return null;
}

/** The per-entity reference and field rules. Returns the first problem found, or null. */
function validateRow(
  entity: ImportEntity,
  row: ExternallyKeyed,
  resolvable: Record<ImportEntity, Set<string>>,
): RowProblem | null {
  switch (entity) {
    case "properties": {
      const property = row as unknown as ImportProperty;
      if (typeof property.name !== "string" || property.name.trim() === "") {
        return { reason: "invalid_field", detail: "name is required" };
      }
      return enumProblem(property.propertyType, PROPERTY_TYPES, "propertyType");
    }

    case "units": {
      const unit = row as unknown as ImportUnit;
      if (typeof unit.unitNumber !== "string" || unit.unitNumber.trim() === "") {
        return { reason: "invalid_field", detail: "unitNumber is required" };
      }
      return (
        requireRef(resolvable, "properties", unit.propertyExternalId, "propertyExternalId") ??
        enumProblem(unit.status, UNIT_STATUSES, "status") ??
        (DATE_FIELDS_OK(unit.vacantSince) ? null : { reason: "invalid_field", detail: "vacantSince is not a valid date" })
      );
    }

    case "residents": {
      const resident = row as unknown as ImportResident;
      if (typeof resident.displayName !== "string" || resident.displayName.trim() === "") {
        return { reason: "invalid_field", detail: "displayName is required" };
      }
      return enumProblem(resident.status, RESIDENT_STATUSES, "status");
    }

    case "vendors": {
      const vendor = row as unknown as ImportVendor;
      if (typeof vendor.name !== "string" || vendor.name.trim() === "") {
        return { reason: "invalid_field", detail: "name is required" };
      }
      return DATE_FIELDS_OK(vendor.insuranceExpiresAt)
        ? null
        : { reason: "invalid_field", detail: "insuranceExpiresAt is not a valid date" };
    }

    case "glAccounts": {
      const account = row as unknown as ImportGlAccount;
      if (typeof account.code !== "string" || account.code.trim() === "") {
        return { reason: "invalid_field", detail: "code is required" };
      }
      if (typeof account.name !== "string" || account.name.trim() === "") {
        return { reason: "invalid_field", detail: "name is required" };
      }
      return enumProblem(account.accountType, GL_ACCOUNT_TYPES, "accountType") ??
        (account.accountType === undefined ? { reason: "invalid_field", detail: "accountType is required" } : null);
    }

    case "leases": {
      const lease = row as unknown as ImportLease;
      if (!DATE_FIELDS_OK(lease.startDate) || typeof lease.startDate !== "string") {
        return { reason: "invalid_field", detail: "startDate is required and must be a date" };
      }
      if (!isPositiveInt(lease.rentCents)) {
        return { reason: "invalid_field", detail: "rentCents must be a positive integer" };
      }
      const unitProblem = requireRef(resolvable, "units", lease.unitExternalId, "unitExternalId");
      if (unitProblem) return unitProblem;
      // A renewal points at a lease that must already exist — the prior term.
      const renewalProblem = optionalRef(resolvable, "leases", lease.renewalOfExternalId, "renewalOfExternalId");
      if (renewalProblem) return renewalProblem;
      for (const residentId of lease.residentExternalIds ?? []) {
        const problem = requireRef(resolvable, "residents", residentId, "residentExternalIds entry");
        if (problem) return problem;
      }
      return (
        enumProblem(lease.status, LEASE_STATUSES, "status") ??
        (DATE_FIELDS_OK(lease.endDate) ? null : { reason: "invalid_field", detail: "endDate is not a valid date" })
      );
    }

    case "ledgerEntries": {
      const entry = row as unknown as ImportLedgerEntry;
      if (!isPositiveInt(entry.amountCents)) {
        // Direction lives in entryType; a signed amount says it twice.
        return { reason: "invalid_field", detail: "amountCents must be a positive integer" };
      }
      if (typeof entry.postedAt !== "string" || !DATE_FIELDS_OK(entry.postedAt)) {
        return { reason: "invalid_field", detail: "postedAt is required and must be a date" };
      }
      return (
        requireRef(resolvable, "leases", entry.leaseExternalId, "leaseExternalId") ??
        enumProblem(entry.entryType, LEDGER_ENTRY_TYPES, "entryType") ??
        (entry.entryType === undefined ? { reason: "invalid_field", detail: "entryType is required" } : null) ??
        enumProblem(entry.category, LEDGER_CATEGORIES, "category") ??
        (entry.category === undefined ? { reason: "invalid_field", detail: "category is required" } : null) ??
        (DATE_FIELDS_OK(entry.dueAt) ? null : { reason: "invalid_field", detail: "dueAt is not a valid date" })
      );
    }

    case "workOrders": {
      const order = row as unknown as ImportWorkOrder;
      if (typeof order.summary !== "string" || order.summary.trim() === "") {
        return { reason: "invalid_field", detail: "summary is required" };
      }
      if (typeof order.reportedAt !== "string" || !DATE_FIELDS_OK(order.reportedAt)) {
        return { reason: "invalid_field", detail: "reportedAt is required and must be a date" };
      }
      return (
        requireRef(resolvable, "properties", order.propertyExternalId, "propertyExternalId") ??
        optionalRef(resolvable, "units", order.unitExternalId, "unitExternalId") ??
        optionalRef(resolvable, "vendors", order.vendorExternalId, "vendorExternalId") ??
        optionalRef(resolvable, "workOrders", order.callbackOfExternalId, "callbackOfExternalId") ??
        enumProblem(order.category, WORK_ORDER_CATEGORIES, "category") ??
        enumProblem(order.priority, WORK_ORDER_PRIORITIES, "priority") ??
        enumProblem(order.status, WORK_ORDER_STATUSES, "status") ??
        (isIntOrAbsent(order.estimateCents) ? null : { reason: "invalid_field", detail: "estimateCents must be an integer" }) ??
        (isIntOrAbsent(order.actualCostCents) ? null : { reason: "invalid_field", detail: "actualCostCents must be an integer" }) ??
        (DATE_FIELDS_OK(order.completedAt) ? null : { reason: "invalid_field", detail: "completedAt is not a valid date" })
      );
    }

    case "glTransactions": {
      const entry = row as unknown as ImportGlTransaction;
      // Negative is allowed here and only here: a credit note or reversal
      // against an income or expense account is a real posting.
      if (typeof entry.amountCents !== "number" || !Number.isInteger(entry.amountCents)) {
        return { reason: "invalid_field", detail: "amountCents must be an integer" };
      }
      if (typeof entry.postedAt !== "string" || !DATE_FIELDS_OK(entry.postedAt)) {
        return { reason: "invalid_field", detail: "postedAt is required and must be a date" };
      }
      return (
        requireRef(resolvable, "glAccounts", entry.accountExternalId, "accountExternalId") ??
        optionalRef(resolvable, "properties", entry.propertyExternalId, "propertyExternalId")
      );
    }

    case "leads": {
      const lead = row as unknown as ImportLead;
      if (typeof lead.inquiredAt !== "string" || !DATE_FIELDS_OK(lead.inquiredAt)) {
        return { reason: "invalid_field", detail: "inquiredAt is required and must be a date" };
      }
      for (const [field, value] of [
        ["contactedAt", lead.contactedAt],
        ["touredAt", lead.touredAt],
        ["appliedAt", lead.appliedAt],
        ["approvedAt", lead.approvedAt],
        ["signedAt", lead.signedAt],
        ["lostAt", lead.lostAt],
      ] as const) {
        if (!DATE_FIELDS_OK(value)) return { reason: "invalid_field", detail: `${field} is not a valid date` };
      }
      return (
        optionalRef(resolvable, "properties", lead.propertyExternalId, "propertyExternalId") ??
        optionalRef(resolvable, "units", lead.unitExternalId, "unitExternalId")
      );
    }
  }
}

/** Total rows a plan will apply, across every entity. */
export function plannedRowCount(plan: ImportPlan): number {
  return Object.values(plan.counts).reduce((total, count) => total + count, 0);
}

import { getTableColumns, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { residents, vendors, leases, units, workOrders, leasingLeads, glAccounts, glTransactions, ledgerEntries } from "@/db/postgres/schema";
import type { SourceRef } from "./provenance";
import type { ImportEntity } from "./import-plan";
import { attachResidentToLease } from "./leasing";

const tables = { residents, vendors, leases, workOrders, leads: leasingLeads, glAccounts, glTransactions, ledgerEntries };
type Entity = keyof typeof tables;
// Only these source-owned fields may change. Aval notes, approvals, manually
// maintained resident associations and audit records are never copied.
const fields: Record<Entity, string[]> = {
  residents: ["displayName", "email", "phone", "status"],
  vendors: ["name", "trade", "email", "phone", "insuranceExpiresAt"],
  leases: ["status", "startDate", "endDate", "isMonthToMonth", "rentCents", "depositCents", "rentDueDay"],
  workOrders: ["category", "priority", "summary", "reportedAt", "assignedAt", "completedAt", "estimateCents", "actualCostCents", "status"],
  leads: ["channel", "unitTypeLabel", "inquiredAt", "contactedAt", "touredAt", "appliedAt", "approvedAt", "signedAt", "lostAt", "lostReason"],
  glAccounts: ["code", "name", "accountType", "isTrustAccount"],
  glTransactions: ["amountCents", "postedAt", "memo"],
  ledgerEntries: ["entryType", "category", "amountCents", "postedAt", "dueAt", "memo"],
};
const dates = new Set(["startDate", "endDate", "insuranceExpiresAt", "reportedAt", "assignedAt", "completedAt", "inquiredAt", "contactedAt", "touredAt", "appliedAt", "approvedAt", "signedAt", "lostAt", "postedAt", "dueAt"]);
const dateOnly = new Set(["startDate", "endDate", "insuranceExpiresAt", "dueAt"]);
const columnName = (key: string) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const equivalent = (key: string, a: unknown, b: unknown) => {
  if (a == null || b == null) return a == null && b == null;
  if (dates.has(key)) return dateOnly.has(key)
    ? new Date(String(a)).toISOString().slice(0, 10) === new Date(String(b)).toISOString().slice(0, 10)
    : new Date(String(a)).getTime() === new Date(String(b)).getTime();
  return typeof b === "number" ? Number(a) === b : a === b;
};

export function changedSourceFields(stored: Record<string, unknown>, incoming: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(incoming).filter(([key, value]) => value !== undefined && !equivalent(key, stored[columnName(key)], value)));
}

/** Returns null for a new row. Immutable financial differences reject the atomic batch. */
export async function updateExistingImport(session: DbSession, org: string, entity: ImportEntity, input: Record<string, unknown>, source: SourceRef,
  ids: Record<string, Map<string, string>>): Promise<"updated" | "unchanged" | null> {
  if (!(entity in tables)) return null;
  const key = entity as Entity, table = tables[key];
  const result = await session.db.execute<Record<string, unknown>>(sql`select * from ${table}
    where organization_id = ${org} and source_provider = ${source.sourceProvider} and external_id = ${input.externalId} for update`);
  const old = result.rows[0];
  if (!old) return null;
  if (old.source_connection_id !== (source.sourceConnectionId ?? null)) throw new Error("Source connection changed. Reconcile this import before resuming.");
  const patch = Object.fromEntries(fields[key].filter(field => input[field] !== undefined).map(field => [field, input[field]]));
  const refs: Record<string, [string, string]> = {
    propertyExternalId: ["propertyId", "properties"], unitExternalId: ["unitId", "units"], vendorExternalId: ["vendorId", "vendors"],
    accountExternalId: ["accountId", "glAccounts"], leaseExternalId: ["leaseId", "leases"],
    renewalOfExternalId: ["renewalOfLeaseId", "leases"], callbackOfExternalId: ["callbackOfWorkOrderId", "workOrders"],
  };
  for (const [external, [field, collection]] of Object.entries(refs)) {
    if (input[external] !== undefined) {
      patch[field] = input[external] === null ? null : ids[collection]?.get(String(input[external]));
      if (patch[field] === undefined) throw new Error("Imported reference unavailable");
    }
  }
  if (key === "leases" && patch.unitId) {
    const unit = await session.db.execute<{ property_id: string }>(sql`select property_id from ${units} where organization_id = ${org} and id = ${patch.unitId}`);
    if (!unit.rows[0]) throw new Error("Imported lease unit unavailable");
    patch.propertyId = unit.rows[0].property_id;
  }
  if (["workOrders", "leads"].includes(key)) {
    const unitId = patch.unitId === undefined ? old.unit_id : patch.unitId;
    const propertyId = patch.propertyId === undefined ? old.property_id : patch.propertyId;
    if (unitId && propertyId) {
      const unit = await session.db.execute<{ property_id: string }>(sql`select property_id from ${units} where organization_id = ${org} and id = ${unitId}`);
      if (unit.rows[0]?.property_id !== propertyId) throw new Error("Imported unit belongs to a different property");
    }
  }
  // Link changes also carry provenance; do not delete Aval-owned associations.
  let associationsChanged = false;
  if (key === "leases" && Array.isArray(input.residentExternalIds)) {
    const requested = new Set(input.residentExternalIds.map(external => {
      const id = ids.residents.get(String(external));
      if (!id) throw new Error("Imported resident unavailable");
      return id;
    }));
    const links = await session.db.execute<{ id: string; resident_id: string; source_provider: string | null; source_connection_id: string | null; resident_provider: string | null }>(sql`
      select lr.id, lr.resident_id, lr.source_provider, lr.source_connection_id, r.source_provider as resident_provider
      from lease_residents lr join residents r on r.id = lr.resident_id and r.organization_id = lr.organization_id
      where lr.organization_id = ${org} and lr.lease_id = ${old.id} for update of lr`);
    for (const link of links.rows) {
      if (requested.has(link.resident_id)) continue;
      if (!link.source_provider && link.resident_provider === source.sourceProvider) throw new Error("Legacy imported resident association changed. Reconcile its ownership before resuming.");
      if (link.source_provider === source.sourceProvider && link.source_connection_id === (source.sourceConnectionId ?? null)) {
        await session.db.execute(sql`delete from lease_residents where organization_id = ${org} and id = ${link.id}`);
        associationsChanged = true;
      }
    }
    for (const id of requested) if (!links.rows.some(link => link.resident_id === id)) {
      await attachResidentToLease(session, org, String(old.id), id, "primary", source);
      associationsChanged = true;
    }
  }
  if (key === "workOrders" && input.status === undefined && (input.completedAt || input.assignedAt)) patch.status = input.completedAt ? "completed" : "assigned";
  if (key === "leads") {
    const stages = [["signedAt", "signed"], ["lostAt", "lost"], ["approvedAt", "approved"], ["appliedAt", "applied"], ["touredAt", "toured"], ["contactedAt", "contacted"]];
    patch.stage = stages.find(([field]) => input[field] === undefined ? old[columnName(field)] : input[field])?.[1] ?? "inquiry";
  }
  const changes = changedSourceFields(old, patch);
  if (Object.keys(changes).length === 0) return associationsChanged ? "updated" : "unchanged";
  if (key === "glTransactions" || key === "ledgerEntries" || (key === "glAccounts" && ("accountType" in changes || "isTrustAccount" in changes))) {
    throw new Error("A previously imported financial record changed. Reconcile it before resuming.");
  }
  // Map only allowlisted schema columns; never interpolate client identifiers.
  const columns = getTableColumns(table);
  const assignments = Object.entries(changes).map(([field, value]) => {
    if (!(field in columns)) throw new Error("Unsupported imported field");
    return sql`${sql.identifier(columnName(field))} = ${value}`;
  });
  await session.db.execute(sql`update ${table} set ${sql.join(assignments, sql`, `)}, updated_at = now()
    where organization_id = ${org} and id = ${old.id}`);
  return "updated";
}

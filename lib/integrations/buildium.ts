import type { ImportBatch, ImportWorkOrder } from "@/lib/operations/import-plan";
import { providerJson, record, requiredString, safeSegment } from "./http";

export const BUILDIUM_PATHS = ["rentals", "rentals/units", "leases/tenants", "leases", "workorders"] as const;
export type BuildiumCursor = { entity: number; offset: number };
export const BUILDIUM_PAGE_SIZE = 20;
export function buildiumBase(environment: unknown): string {
  if (environment === "sandbox") return "https://apisandbox.buildium.com/v1";
  if (environment === "production") return "https://api.buildium.com/v1";
  throw new Error("Choose Buildium environment: sandbox or production. Existing credentials must be reconnected with an explicit environment.");
}
export function buildiumCursor(value: string): BuildiumCursor {
  const c = JSON.parse(value) as Partial<BuildiumCursor>;
  if (Object.keys(c).length === 0) return { entity: 0, offset: 0 };
  if (!Number.isInteger(c.entity) || c.entity! < 0 || c.entity! >= BUILDIUM_PATHS.length || !Number.isInteger(c.offset) || c.offset! < 0) throw new Error("Invalid Buildium checkpoint");
  return c as BuildiumCursor;
}
const optionalText = (value: unknown) => typeof value === "string" ? value : null;
const optionalNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const cents = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) throw new Error("Buildium returned an unsupported monetary value");
  return Math.round(value * 100);
};
const id = (value: unknown) => requiredString(value, "Buildium identifier");
const status = (value: unknown, mapping: Record<string, string>) => {
  const mapped = mapping[String(value)];
  if (!mapped) throw new Error("Buildium returned an unsupported status; review the source record");
  return mapped;
};

/** Whitelist data needed for operations. Never retain TaxId, DOB or raw tenant payloads. */
export function normalizeBuildium(entity: number, values: unknown[]): ImportBatch {
  const rows = values.map(record);
  if (entity === 0) return { properties: rows.map(r => {
    const a = r.Address ? record(r.Address) : {};
    if (a.Country && a.Country !== "UnitedStates") throw new Error("The pilot supports US Buildium portfolios only");
    return { externalId: id(r.Id), name: requiredString(r.Name, "property name"), addressLine1: optionalText(a.AddressLine1), city: optionalText(a.City), region: optionalText(a.State), postalCode: optionalText(a.PostalCode), country: "US", reportedUnitCount: optionalNumber(r.NumberUnits), yearBuilt: optionalNumber(r.YearBuilt) };
  }) };
  if (entity === 1) return { units: rows.map(r => ({ externalId: id(r.Id), propertyExternalId: id(r.PropertyId), unitNumber: requiredString(r.UnitNumber, "unit number"), squareFeet: optionalNumber(r.UnitSize), marketRentCents: r.MarketRent == null ? null : cents(r.MarketRent), ...(typeof r.IsUnitOccupied === "boolean" ? { status: r.IsUnitOccupied ? "occupied" : "vacant_ready" } : {}) })) };
  if (entity === 2) return { residents: rows.map(r => ({ externalId: id(r.Id), displayName: requiredString([r.FirstName, r.LastName].filter(Boolean).join(" "), "resident name"), email: optionalText(r.Email), phone: Array.isArray(r.PhoneNumbers) && r.PhoneNumbers.length ? optionalText(record(r.PhoneNumbers[0]).Number) : null })) };
  if (entity === 3) return { leases: rows.map(r => {
    const account = record(r.AccountDetails);
    return { externalId: id(r.Id), unitExternalId: id(r.UnitId), startDate: requiredString(r.LeaseFromDate, "lease start date"), endDate: optionalText(r.LeaseToDate), rentCents: cents(account.Rent), ...(account.SecurityDeposit == null ? {} : { depositCents: cents(account.SecurityDeposit) }), rentDueDay: typeof r.PaymentDueDay === "number" ? r.PaymentDueDay : undefined, isMonthToMonth: r.TermType === "MonthToMonth" || r.LeaseType === "AtWill", status: status(r.LeaseStatus, { Active: "active", Past: "expired", Future: "pending" }), residentExternalIds: Array.isArray(r.CurrentTenants) ? r.CurrentTenants.map(t => id(record(t).Id)) : undefined };
  }) };
  if (entity === 4) return { workOrders: rows.map(r => {
    const task = record(r.taskDetails), property = record(task.Property);
    if (property.Type && property.Type !== "Rental") throw new Error("Only rental work orders are supported in this pilot");
    return { externalId: id(r.Id), propertyExternalId: id(property.Id), unitExternalId: task.UnitId == null ? null : id(task.UnitId), summary: requiredString(r.Title ?? task.Title, "work-order title"), reportedAt: requiredString(task.CreatedDateTime, "task creation date"), priority: status(r.Priority, { Low: "routine", Normal: "routine", High: "urgent" }), status: status(r.Status, { New: "reported", InProgress: "in_progress", Completed: "completed", Closed: "completed", Deferred: "reported" }) } satisfies ImportWorkOrder;
  }) };
  throw new Error("Unknown Buildium entity");
}

export async function fetchBuildiumPage(credentials: Record<string, string>, cursor: BuildiumCursor) {
  const base = buildiumBase(credentials.environment);
  const headers = { "x-buildium-client-id": credentials.clientId, "x-buildium-client-secret": credentials.clientSecret };
  const data = await providerJson(`${base}/${BUILDIUM_PATHS[cursor.entity]}?limit=${BUILDIUM_PAGE_SIZE}&offset=${cursor.offset}&orderby=Id`, { headers });
  if (!Array.isArray(data)) throw new Error("Buildium returned an invalid page");
  if (cursor.entity === 4) {
    for (const item of data) {
      const row = record(item), task = record(row.Task);
      await new Promise(resolve => setTimeout(resolve, 125));
      row.taskDetails = await providerJson(`${base}/tasks/${safeSegment(id(task.Id))}`, { headers });
    }
  }
  const end = data.length < BUILDIUM_PAGE_SIZE;
  const complete = end && cursor.entity === BUILDIUM_PATHS.length - 1;
  return { batch: normalizeBuildium(cursor.entity, data), complete,
    next: complete ? { entity: 0, offset: 0 } : end ? { entity: cursor.entity + 1, offset: 0 } : { ...cursor, offset: cursor.offset + data.length } };
}

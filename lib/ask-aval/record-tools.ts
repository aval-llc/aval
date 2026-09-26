import type { DbSession } from "@/db/postgres/session";
/**
 * Entity reads over this workspace's own records, for the Specialists whose
 * work starts with "which vendor", "which leases", "which leads".
 *
 * Same discipline as operations-tools.ts: every read is scoped to the
 * workspace by the caller's organization and by row-level security, returns
 * `noDataAvailable` when there are no rows rather than an empty shape that
 * reads like a measurement, and exposes only what the work needs — no
 * credentials, no email addresses, no raw provider payloads.
 *
 * These are reads, so they add no authority: each declares a permission the
 * reading actors already hold, and the capability map (organization/
 * capabilities.ts) is what brings them to the Specialists that need them.
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { ToolSchema } from "./model-types";
import { noDataAvailable } from "./portfolio-data";
import { integrationConnections, leases, organizationMembers, units, users } from "@/db/postgres/schema";
import { listVendors } from "@/lib/operations/maintenance";
import { listLeads, availableUnits } from "@/lib/operations/leasing";
import { listBills, listMeters } from "@/lib/infrastructure/meters";

export const RECORD_TOOLS: ToolSchema[] = [
  {
    name: "get_vendors",
    description: "This workspace's vendors: trade, whether active, and certificate-of-insurance expiry with a lapsed flag. Use before dispatching, bidding or checking vendor compliance.",
    input_schema: { type: "object", properties: { trade: { type: "string", maxLength: 60 }, include_inactive: { type: "boolean" } } },
  },
  {
    name: "get_expiring_leases",
    description: "Active leases ending within a window: end date, rent, deposit, month-to-month flag, unit and property. Use for renewals, expirations, notices and deposits.",
    input_schema: { type: "object", properties: { within_days: { type: "integer", minimum: 1, maximum: 365 } } },
  },
  {
    name: "get_leads",
    description: "Leasing leads with their current stage, channel, unit type and stage dates, newest first. Use for lead follow-up, qualification and CRM hygiene.",
    input_schema: { type: "object", properties: { stage: { type: "string", maxLength: 30 }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
  },
  {
    name: "get_available_units",
    description: "Units that are vacant and ready to lease, with market rent and how long each has been vacant. Use for listings, unit matching and vacancy marketing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_utility_bills",
    description: "Utility meters and their recorded bills: usage, cost, period and whether a figure was machine-extracted. Use for bill audits, usage anomalies and utility setup.",
    input_schema: { type: "object", properties: { utility_type: { type: "string", enum: ["electricity", "water", "gas"] }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
  },
  {
    name: "get_connection_health",
    description: "Each connected system's status and when it last synced. No credentials. Use for provider/API health and synchronization questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_workspace_staff",
    description: "The people in this workspace and their roles (display names only). Use for routing staff work, on-call and access reviews.",
    input_schema: { type: "object", properties: {} },
  },
];

const RECORD_TOOL_NAMES = new Set(RECORD_TOOLS.map((tool) => tool.name));
const DAY = 86_400_000;
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

export async function runRecordTool(dbSession: DbSession, name: string, input: Record<string, unknown>, organizationId: string | undefined): Promise<{ json: unknown; numbers: number[] } | null> {
  if (!RECORD_TOOL_NAMES.has(name)) return null;
  if (!organizationId) return { json: noDataAvailable("workspace records"), numbers: [] };
  const now = new Date();
  switch (name) {
    case "get_vendors": {
      const trade = typeof input.trade === "string" ? input.trade.toLowerCase() : null;
      const rows = (await listVendors(dbSession, organizationId, input.include_inactive !== true)).filter((row) => !trade || (row.trade ?? "").toLowerCase().includes(trade));
      if (!rows.length) return { json: noDataAvailable("vendor records"), numbers: [] };
      return { json: { available: true, vendors: rows.map((row) => ({ id: row.id, name: row.name, trade: row.trade, active: row.isActive, insurance_expires_on: iso(row.insuranceExpiresAt), insurance_lapsed: row.insuranceExpiresAt ? row.insuranceExpiresAt < now : null })) }, numbers: [] };
    }
    case "get_expiring_leases": {
      const within = Math.min(Math.max(Number(input.within_days) || 90, 1), 365);
      const rows = await dbSession.db.select().from(leases).where(and(eq(leases.organizationId, organizationId), eq(leases.status, "active"), gte(leases.endDate, now), lte(leases.endDate, new Date(now.getTime() + within * DAY)))).orderBy(leases.endDate).limit(100);
      if (!rows.length) return { json: { available: true, expiring_leases: [], note: `No active lease ends within ${within} days.` }, numbers: [] };
      const out = rows.map((row) => ({ id: row.id, unit_id: row.unitId, property_id: row.propertyId, ends_on: iso(row.endDate), days_left: row.endDate ? Math.ceil((row.endDate.getTime() - now.getTime()) / DAY) : null, rent_cents: row.rentCents, deposit_cents: row.depositCents, month_to_month: row.isMonthToMonth }));
      return { json: { available: true, within_days: within, expiring_leases: out }, numbers: out.flatMap((row) => [row.rent_cents, row.deposit_cents, row.days_left].filter((value): value is number => typeof value === "number")) };
    }
    case "get_leads": {
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
      const stage = typeof input.stage === "string" ? input.stage : null;
      const rows = (await listLeads(dbSession, organizationId)).filter((row) => !stage || row.stage === stage).slice(0, limit);
      if (!rows.length) return { json: noDataAvailable("leasing leads"), numbers: [] };
      return { json: { available: true, leads: rows.map((row) => ({ id: row.id, stage: row.stage, channel: row.channel, unit_type: row.unitTypeLabel, property_id: row.propertyId, inquired_on: iso(row.inquiredAt), contacted_on: iso(row.contactedAt), toured_on: iso(row.touredAt), applied_on: iso(row.appliedAt), lost_reason: row.lostReason })) }, numbers: [] };
    }
    case "get_available_units": {
      const rows = await availableUnits(dbSession, organizationId);
      if (!rows.length) return { json: { available: true, units: [], note: "No unit is vacant and ready to lease." }, numbers: [] };
      const out = rows.map((row: typeof units.$inferSelect) => ({ id: row.id, property_id: row.propertyId, unit: row.unitNumber, bedrooms: row.bedrooms, market_rent_cents: row.marketRentCents, days_vacant: row.vacantSince ? Math.floor((now.getTime() - row.vacantSince.getTime()) / DAY) : null }));
      return { json: { available: true, units: out }, numbers: out.flatMap((row) => [row.market_rent_cents, row.days_vacant].filter((value): value is number => typeof value === "number")) };
    }
    case "get_utility_bills": {
      const type = input.utility_type === "electricity" || input.utility_type === "water" || input.utility_type === "gas" ? input.utility_type : undefined;
      const [meters, bills] = await Promise.all([listMeters(dbSession, organizationId, type), listBills(dbSession, organizationId, { utilityType: type })]);
      if (!meters.length) return { json: noDataAvailable("utility meters"), numbers: [] };
      const limit = Math.min(Math.max(Number(input.limit) || 24, 1), 50);
      const out = bills.slice(0, limit).map((bill) => ({ meter_id: bill.meterId, period_start: iso(bill.periodStart as Date), period_end: iso(bill.periodEnd as Date), usage: bill.usageAmount, cost_cents: bill.costCents, currency: bill.currency, extracted: bill.source === "ai_extracted", extraction_note: bill.extractionNote }));
      return { json: { available: true, meters: meters.map((meter) => ({ id: meter.id, type: meter.utilityType, property: meter.propertyLabel, unit: meter.unitLabel, unit_of_measure: meter.unitOfMeasure })), bills: out }, numbers: out.flatMap((row) => [row.usage, row.cost_cents].filter((value): value is number => typeof value === "number")) };
    }
    case "get_connection_health": {
      const rows = await dbSession.db.select({ provider: integrationConnections.provider, category: integrationConnections.category, status: integrationConnections.status, lastSyncAt: integrationConnections.lastSyncAt }).from(integrationConnections).where(eq(integrationConnections.organizationId, organizationId));
      if (!rows.length) return { json: { available: true, connections: [], note: "Nothing is connected to this workspace." }, numbers: [] };
      return { json: { available: true, connections: rows.map((row) => ({ provider: row.provider, category: row.category, status: row.status, last_sync: row.lastSyncAt?.toISOString() ?? null })) }, numbers: [] };
    }
    case "get_workspace_staff": {
      const rows = await dbSession.db.select({ name: users.displayName, role: organizationMembers.role }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(eq(organizationMembers.organizationId, organizationId)).orderBy(desc(organizationMembers.createdAt));
      return { json: { available: true, staff: rows }, numbers: [] };
    }
  }
  return null;
}

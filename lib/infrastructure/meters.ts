/**
 * DB access for utility meters and bills — every query scoped to
 * `organizationId`, including `recordBill`'s explicit check that the
 * `meterId` it's attaching a bill to actually belongs to the caller's org
 * (the same cross-tenant-isolation discipline as the rest of this app's
 * integration/webhook code — a meter id is caller-supplied input, never
 * trusted without a scoped lookup first).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { utilityBills, utilityMeters } from "@/db/postgres/schema";
import type { UnitOfMeasure, UtilityType } from "./types";

export interface CreateMeterInput {
  utilityType: UtilityType;
  propertyLabel: string;
  unitLabel?: string;
  meterNumber?: string;
  provider?: string;
  unitOfMeasure: UnitOfMeasure;
}

export async function createMeter(dbSession: DbSession, organizationId: string, input: CreateMeterInput) {
  const db = dbSession.db;
  const now = new Date();
  const meter = {
    id: crypto.randomUUID(),
    organizationId,
    utilityType: input.utilityType,
    propertyLabel: input.propertyLabel,
    unitLabel: input.unitLabel ?? null,
    meterNumber: input.meterNumber ?? null,
    provider: input.provider ?? null,
    unitOfMeasure: input.unitOfMeasure,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(utilityMeters).values(meter);
  return meter;
}

export async function listMeters(dbSession: DbSession, organizationId: string, utilityType?: UtilityType) {
  const db = dbSession.db;
  const conditions = [eq(utilityMeters.organizationId, organizationId)];
  if (utilityType) conditions.push(eq(utilityMeters.utilityType, utilityType));
  return db
    .select()
    .from(utilityMeters)
    .where(and(...conditions))
    .orderBy(desc(utilityMeters.createdAt));
}

export interface RecordBillInput {
  meterId: string;
  periodStart: Date;
  periodEnd: Date;
  usageAmount: number;
  costCents: number;
  currency: "USD" | "MXN";
  source: "manual" | "ai_extracted";
  extractionConfidence?: "high" | "low";
  extractionNote?: string;
}

export class MeterNotFoundError extends Error {
  constructor(meterId: string) {
    super(`Meter ${meterId} was not found in this organization`);
    this.name = "MeterNotFoundError";
  }
}

export async function recordBill(dbSession: DbSession, organizationId: string, input: RecordBillInput) {
  const db = dbSession.db;
  const [meter] = await db
    .select({ id: utilityMeters.id })
    .from(utilityMeters)
    .where(and(eq(utilityMeters.id, input.meterId), eq(utilityMeters.organizationId, organizationId)))
    .limit(1);
  if (!meter) throw new MeterNotFoundError(input.meterId);

  const bill = {
    id: crypto.randomUUID(),
    organizationId,
    meterId: input.meterId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    usageAmount: input.usageAmount,
    costCents: input.costCents,
    currency: input.currency,
    source: input.source,
    extractionConfidence: input.extractionConfidence ?? null,
    extractionNote: input.extractionNote ?? null,
    createdAt: new Date(),
  };
  await db.insert(utilityBills).values(bill);
  return bill;
}

export async function listBills(dbSession: DbSession, organizationId: string, filters: { meterId?: string; utilityType?: UtilityType } = {}) {
  const db = dbSession.db;

  let meterIds: string[] | undefined;
  if (filters.utilityType) {
    const meters = await listMeters(dbSession, organizationId, filters.utilityType);
    meterIds = meters.map((meter) => meter.id);
    if (meterIds.length === 0) return [];
  }

  const conditions = [eq(utilityBills.organizationId, organizationId)];
  if (filters.meterId) conditions.push(eq(utilityBills.meterId, filters.meterId));
  if (meterIds) conditions.push(inArray(utilityBills.meterId, meterIds));

  return db
    .select()
    .from(utilityBills)
    .where(and(...conditions))
    .orderBy(desc(utilityBills.periodStart));
}

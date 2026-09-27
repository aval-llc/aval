import { and, eq, sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { utilitySites, utilityMeters, properties } from "@/db/postgres/schema";
import { UtilityError, textField } from "./validation";

export async function lockUtilityWorkspace(s: DbSession, org: string) {
  await s.db.execute(sql`SELECT id FROM organizations WHERE id=${org} FOR UPDATE`);
}
export async function listSites(s: DbSession, org: string) {
  return s.db.select().from(utilitySites).where(eq(utilitySites.organizationId,org)).orderBy(utilitySites.name,utilitySites.id);
}
export async function createSite(s: DbSession, org: string, input: { name: unknown; propertyId?: unknown }) {
  const name = textField(input.name,"name");
  const propertyId = input.propertyId ? textField(input.propertyId,"propertyId") : null;
  if (propertyId) {
    const [property] = await s.db.select({id:properties.id}).from(properties).where(and(eq(properties.organizationId,org),eq(properties.id,propertyId)));
    if (!property) throw new UtilityError("Property not found",404);
  }
  const [row] = await s.db.insert(utilitySites).values({id:crypto.randomUUID(),organizationId:org,propertyId,name,createdAt:new Date()}).returning();
  return row;
}
export async function validateMeterSite(s: DbSession, org: string, siteId: string, parentMeterId?: string | null, utilityType?: string) {
  const [site] = await s.db.select().from(utilitySites).where(and(eq(utilitySites.organizationId,org),eq(utilitySites.id,siteId)));
  if (!site) throw new UtilityError("Site not found",404);
  if (parentMeterId) {
    const [parent] = await s.db.select().from(utilityMeters).where(and(eq(utilityMeters.organizationId,org),eq(utilityMeters.id,parentMeterId),eq(utilityMeters.siteId,siteId)));
    if (!parent) throw new UtilityError("Parent meter must belong to the same site",400);
    if (utilityType && parent.utilityType !== utilityType) throw new UtilityError("Parent meter must measure the same utility type",400);
  }
  return site;
}
/** Backfill is explicit: labels are evidence for a human, never join keys. */
export async function mapMeter(s: DbSession, org: string, meterId: string, siteId: string, parentMeterId: string | null) {
  await lockUtilityWorkspace(s,org);
  const [meter] = await s.db.select().from(utilityMeters).where(and(eq(utilityMeters.organizationId,org),eq(utilityMeters.id,meterId)));
  if (!meter) throw new UtilityError("Meter not found",404);
  await validateMeterSite(s,org,siteId,parentMeterId,meter.utilityType);
  if (meter.siteId && meter.siteId !== siteId) throw new UtilityError("Mapped site cannot be reassigned",409);
  let ancestor = parentMeterId;
  const seen = new Set([meterId]);
  while (ancestor) {
    if (seen.has(ancestor)) throw new UtilityError("Meter hierarchy cycle",409);
    seen.add(ancestor);
    const [parent] = await s.db.select().from(utilityMeters).where(and(eq(utilityMeters.organizationId,org),eq(utilityMeters.id,ancestor)));
    ancestor = parent?.parentMeterId ?? null;
  }
  const [saved] = await s.db.update(utilityMeters).set({siteId,parentMeterId,updatedAt:new Date()}).where(and(eq(utilityMeters.organizationId,org),eq(utilityMeters.id,meterId))).returning();
  return saved;
}

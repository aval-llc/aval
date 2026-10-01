import { eq } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { communicationSettings } from '@/db/postgres/schema';
import { resolveMaintenancePolicy } from './maintenance-policy';

export async function maintenancePolicy(session: DbSession, org: string, propertyId: string) {
  const [row] = await session.db.select().from(communicationSettings).where(eq(communicationSettings.organizationId, org)).limit(1);
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row?.configJson ?? '{}'); } catch { return resolveMaintenancePolicy({}, propertyId); }
  return resolveMaintenancePolicy(config?.maintenancePolicy, propertyId);
}

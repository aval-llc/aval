import type { DbSession } from "@/db/postgres/session";
import { listBills, listMeters } from "./meters";
import { summarizeUtilityRecords } from "./utility-analysis";
import { formatMoney, type SupportedCurrency } from "@/lib/finance/money";

export async function summarizeOrganizationUtilities(session: DbSession, organizationId: string) {
  const meters = await listMeters(session, organizationId);
  const bills = await listBills(session, organizationId);
  return summarizeUtilityRecords(meters, bills).map(row => ({ ...row,
    totalCostFormatted: formatMoney(row.totalCostCents, row.currency as SupportedCurrency),
  }));
}

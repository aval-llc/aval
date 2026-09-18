import type { DbSession } from "@/db/postgres/session";
/**
 * Per-organization utility KPI rollup — the read side the
 * GET /api/infrastructure/summary route exposes to the dashboard.
 */

import { listBills, listMeters } from "./meters";
import { compareBaselineToReporting, costPerUsageUnit } from "./usage-metrics";
import { formatMoney, type SupportedCurrency } from "@/lib/finance/money";
import type { UtilityType } from "./types";

export interface UtilityTypeSummary {
  utilityType: UtilityType;
  meterCount: number;
  billCount: number;
  totalUsage: number;
  totalCostCents: number;
  currency: SupportedCurrency;
  totalCostFormatted: string;
  /** Bills recorded in a different currency than `currency` (the type's most common one), excluded from totalCostCents rather than silently converted. */
  otherCurrencyBillCount: number;
  averageCostPerUnit: number | null;
  /** Most recent bill's daily-average usage vs. the one before it — see usage-metrics.ts's CalTRACK-lite caveat. Null with fewer than two bills. */
  usageVariancePct: number | null;
}

function primaryCurrency(bills: { currency: string }[]): SupportedCurrency {
  const counts = new Map<string, number>();
  for (const bill of bills) counts.set(bill.currency, (counts.get(bill.currency) ?? 0) + 1);
  const [mostCommon] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (mostCommon?.[0] as SupportedCurrency) ?? "USD";
}

export async function summarizeOrganizationUtilities(dbSession: DbSession, organizationId: string): Promise<UtilityTypeSummary[]> {
  const utilityTypes: UtilityType[] = ["electricity", "water", "gas"];
  const summaries: UtilityTypeSummary[] = [];

  for (const utilityType of utilityTypes) {
    const meters = await listMeters(dbSession, organizationId, utilityType);
    if (meters.length === 0) continue;

    const bills = await listBills(dbSession, organizationId, { utilityType });
    if (bills.length === 0) {
      summaries.push({
        utilityType,
        meterCount: meters.length,
        billCount: 0,
        totalUsage: 0,
        totalCostCents: 0,
        currency: "USD",
        totalCostFormatted: formatMoney(0, "USD"),
        otherCurrencyBillCount: 0,
        averageCostPerUnit: null,
        usageVariancePct: null,
      });
      continue;
    }

    const currency = primaryCurrency(bills);
    const sameCurrencyBills = bills.filter((bill) => bill.currency === currency);
    const totalCostCents = sameCurrencyBills.reduce((total, bill) => total + bill.costCents, 0);
    const totalUsage = bills.reduce((total, bill) => total + bill.usageAmount, 0);
    const averageCostPerUnit = sameCurrencyBills.length > 0 ? costPerUsageUnit({ costCents: totalCostCents, usageAmount: sameCurrencyBills.reduce((t, b) => t + b.usageAmount, 0) }) : null;

    // listBills returns newest-period-first (see meters.ts) — [0] is the most recent bill.
    const usageVariancePct =
      bills.length >= 2 ? compareBaselineToReporting(bills[1], bills[0]).variancePct : null;

    summaries.push({
      utilityType,
      meterCount: meters.length,
      billCount: bills.length,
      totalUsage,
      totalCostCents,
      currency,
      totalCostFormatted: formatMoney(totalCostCents, currency),
      otherCurrencyBillCount: bills.length - sameCurrencyBills.length,
      averageCostPerUnit,
      usageVariancePct,
    });
  }

  return summaries;
}

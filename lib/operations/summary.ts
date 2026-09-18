import type { DbSession } from "@/db/postgres/session";
/**
 * The one call that produces everything the Operations module shows, and the
 * insight run over it.
 *
 * Composed here rather than in the API routes so the four tab summaries, the
 * insight rules and Ask Aval's tools all read the same figures. A metric
 * computed twice in two places is a metric that will eventually disagree with
 * itself, and this app's whole claim is that its numbers are checkable.
 */

import { summarizeAccounting, type AccountingReport } from "./accounting";
import { summarizeLeasing, type LeasingSummary } from "./leasing";
import { summarizeMaintenanceOperations, type MaintenanceReport } from "./maintenance";
import { summarizePortfolio, type PortfolioSummary } from "./portfolio";
import { listOpenConflicts, type ConflictRow } from "./provenance";
import { deriveInsights, type OperationsInsight } from "./insights";
import { economicOccupancyPct } from "./metrics/occupancy";
import { MS_PER_DAY } from "./types";

export interface OperationsPeriod {
  start: Date;
  end: Date;
}

/**
 * The default reporting window: the current calendar month to date.
 *
 * Calendar months rather than a rolling 30 days because rent is billed on
 * calendar months — a rolling window would cut a month's rent charge in half
 * and report a collection rate nobody could reconcile against their own
 * accounting system.
 */
export function currentMonthPeriod(asOf = new Date()): OperationsPeriod {
  const start = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  return { start, end: asOf };
}

/** The full calendar month before `period.start`, for period-over-period comparison. */
export function priorMonthPeriod(period: OperationsPeriod): OperationsPeriod {
  const start = new Date(Date.UTC(period.start.getUTCFullYear(), period.start.getUTCMonth() - 1, 1));
  const end = new Date(period.start.getTime() - 1);
  return { start, end };
}

export interface OperationsOverview {
  period: OperationsPeriod;
  portfolio: PortfolioSummary;
  leasing: LeasingSummary;
  maintenance: MaintenanceReport;
  accounting: AccountingReport;
  conflicts: ConflictRow[];
  insights: OperationsInsight[];
  /**
   * The handful of figures the Overview tiles show. Every one is null when its
   * inputs are absent — see `headline` below for why that matters more here
   * than anywhere else in the module.
   */
  headline: HeadlineMetrics;
  /** True when this workspace has no operations records at all. */
  isEmpty: boolean;
}

export interface HeadlineMetrics {
  properties: number;
  units: number;
  physicalOccupancyPct: number | null;
  /** Collected rent over gross potential rent. Needs both a ledger and market rents; null without either. */
  economicOccupancyPct: number | null;
  noiCents: number | null;
  collectionRatePct: number | null;
  openWorkOrders: number;
  emergencyOpenWorkOrders: number;
  leadToLeaseConversionPct: number | null;
  medianDaysToLease: number | null;
  renewalRatePct: number | null;
  pastDueCents: number | null;
}

/**
 * Every Operations figure for one workspace and window.
 *
 * The four summaries are gathered in parallel and then handed to the insight
 * rules, so a finding is always derived from the same numbers the tabs are
 * showing — an insight that disagreed with the tile above it would be worse
 * than no insight at all.
 */
export async function buildOperationsOverview(dbSession: DbSession,
  organizationId: string,
  period: OperationsPeriod = currentMonthPeriod(),
  asOf = new Date(),
): Promise<OperationsOverview> {
  const [portfolio, leasing, maintenance, accounting, conflicts] = await Promise.all([
    summarizePortfolio(dbSession, organizationId, asOf),
    summarizeLeasing(dbSession, organizationId, period.start, period.end, asOf),
    summarizeMaintenanceOperations(dbSession, organizationId, period.start, period.end, asOf),
    summarizeAccounting(dbSession, organizationId, period.start, period.end, asOf),
    listOpenConflicts(dbSession, organizationId),
  ]);

  const insights = deriveInsights({ portfolio, leasing, maintenance, accounting, conflicts });

  const headline: HeadlineMetrics = {
    properties: portfolio.propertyCount,
    units: portfolio.occupancy.totalUnits,
    physicalOccupancyPct: portfolio.occupancy.physicalOccupancyPct,
    economicOccupancyPct:
      accounting.collections && portfolio.rentPosition.grossPotentialRentCents > 0
        ? economicOccupancyPct(accounting.collections.collectedCents, portfolio.rentPosition.grossPotentialRentCents)
        : null,
    noiCents: accounting.profitAndLoss?.noiCents ?? null,
    collectionRatePct: accounting.collections?.collectionRatePct ?? null,
    openWorkOrders: maintenance.summary.openCount,
    emergencyOpenWorkOrders: maintenance.summary.emergencyOpenCount,
    leadToLeaseConversionPct: leasing.health?.leadToLeaseConversionPct ?? null,
    medianDaysToLease: leasing.health?.medianDaysToLease ?? null,
    renewalRatePct: leasing.renewals?.renewalRatePct ?? null,
    pastDueCents: accounting.aging?.totalPastDueCents ?? null,
  };

  return {
    period,
    portfolio,
    leasing,
    maintenance,
    accounting,
    conflicts,
    insights,
    headline,
    isEmpty:
      portfolio.propertyCount === 0 &&
      portfolio.occupancy.totalUnits === 0 &&
      maintenance.summary.totalWorkOrders === 0 &&
      leasing.activeLeaseCount === 0 &&
      accounting.profitAndLoss === null,
  };
}

/**
 * Parses a `?period=` query parameter into a window.
 *
 * Accepts only named windows rather than arbitrary date strings: the named set
 * is what the tabs offer, and a caller-supplied range would silently produce
 * partial-month collection rates that look like whole-month ones. `YYYY-MM`
 * is the one exception, since a specific calendar month is unambiguous.
 */
export function parsePeriod(value: string | null, asOf = new Date()): OperationsPeriod {
  const current = currentMonthPeriod(asOf);
  switch (value) {
    case null:
    case "":
    case "month_to_date":
      return current;
    case "prior_month":
      return priorMonthPeriod(current);
    case "last_30_days":
      return { start: new Date(asOf.getTime() - 30 * MS_PER_DAY), end: asOf };
    case "last_90_days":
      return { start: new Date(asOf.getTime() - 90 * MS_PER_DAY), end: asOf };
    case "year_to_date":
      return { start: new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1)), end: asOf };
    default: {
      const match = /^(\d{4})-(\d{2})$/.exec(value);
      if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        if (month >= 0 && month <= 11) {
          return {
            start: new Date(Date.UTC(year, month, 1)),
            // Day 0 of the next month is the last day of this one.
            end: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
          };
        }
      }
      return current;
    }
  }
}

export const PERIOD_OPTIONS = ["month_to_date", "prior_month", "last_30_days", "last_90_days", "year_to_date"] as const;

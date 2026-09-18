import type { DbSession } from "@/db/postgres/session";
/**
 * Ask Aval's tools over the operations record layer.
 *
 * Split from `tools.ts` because these read a different kind of thing. The
 * tools there read `portfolio_snapshots` — pre-aggregated metrics a connector
 * pushed — and can only report what was pushed. These read the records
 * themselves (`lib/operations/`), so they can answer the questions an operator
 * actually asks: which units, which vendor, which accounts, how long.
 *
 * Same discipline as `portfolio-data.ts`, which matters more here rather than
 * less: every executor returns `noDataAvailable` when the workspace has no
 * rows, never an empty shape that reads like a measurement. A funnel of zeroes
 * is a performance claim; "no leasing data has been provided" is the truth.
 *
 * On the faithfulness gate: the numbers these tools expose are computed from
 * this workspace's own rows by the metric functions in `lib/operations/metrics/`,
 * so they are exactly what the gate should be verifying answers against —
 * unlike a document's contents, which are a counterparty's assertions and are
 * deliberately withheld from it (see `read_document`).
 */

import type { ToolSchema } from "./model-types";
import { noDataAvailable } from "./portfolio-data";
import { summarizeAccounting } from "@/lib/operations/accounting";
import { summarizeLeasing } from "@/lib/operations/leasing";
import { summarizeMaintenanceOperations } from "@/lib/operations/maintenance";
import { residentsForLeases } from "@/lib/operations/leasing";
import { summarizePortfolio } from "@/lib/operations/portfolio";
import { listOpenConflicts } from "@/lib/operations/provenance";
import { deriveInsights } from "@/lib/operations/insights";
import { currentMonthPeriod, parsePeriod, PERIOD_OPTIONS } from "@/lib/operations/summary";

/** The period argument every tool below accepts, described once. */
const PERIOD_PROPERTY = {
  type: "string",
  enum: [...PERIOD_OPTIONS],
  description: "Reporting window. Defaults to month_to_date. Calendar months, because rent is billed on calendar months.",
} as const;

export const OPERATIONS_TOOLS: ToolSchema[] = [
  {
    name: "get_property_breakdown",
    description:
      "Per-property and per-unit-type occupancy from this workspace's own property and unit records: unit counts, " +
      "occupied/vacant/notice/down, days vacant, market rent against in-place rent (loss to lease). " +
      "Use for any question about a specific property, unit type, or where vacancy is concentrated.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_delinquent_accounts",
    description:
      "Past-due resident accounts from the receivables ledger: balance owed, days past due, aging bucket, and the " +
      "residents on the lease with their contact channel. Ordered oldest-first, since collections work is driven by age. " +
      "Use for collections, delinquency, or 'who owes us' questions.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 20, max 50." } },
    },
  },
  {
    name: "get_operating_statement",
    description:
      "Profit and loss for a period from the general ledger: income, operating expenses, NOI, operating expense ratio, " +
      "expense lines against the prior period, plus AR aging and collection rate. " +
      "Use for NOI, margin, budget, expense or collection questions.",
    input_schema: { type: "object", properties: { period: PERIOD_PROPERTY } },
  },
  {
    name: "get_maintenance_performance",
    description:
      "Work-order performance: open counts, SLA compliance by priority (with the target hours each was measured against), " +
      "median time to assign and complete, cost by trade, and per-vendor scorecards including first-time-fix rate and " +
      "billing against estimate. Use for maintenance, turnaround-time or vendor questions.",
    input_schema: { type: "object", properties: { period: PERIOD_PROPERTY } },
  },
  {
    name: "get_leasing_velocity",
    description:
      "Lead-to-lease funnel from per-lead stage timestamps: conversion at each step, median days between steps, " +
      "performance by acquisition channel and unit type, why leads were lost, the lease expiration schedule, and renewal rate. " +
      "Use for leasing, conversion, days-to-lease, marketing-channel or renewal questions.",
    input_schema: { type: "object", properties: { period: PERIOD_PROPERTY } },
  },
  {
    name: "get_operations_insights",
    description:
      "The findings the current data supports — delinquency, SLA breaches, expiration concentration, vendor performance, " +
      "expense variance, and fields where two connected systems disagree — each with the row ids it was computed from. " +
      "Call this for open-ended questions like 'what should I look at' or 'what's wrong', rather than assembling one yourself.",
    input_schema: { type: "object", properties: { period: PERIOD_PROPERTY } },
  },
  {
    name: "get_data_conflicts",
    description:
      "Fields where two connected systems report different values for the same record. Aval keeps the stored value and " +
      "changes nothing until a person resolves it. Use when asked whether a figure can be trusted, or why two systems disagree.",
    input_schema: { type: "object", properties: {} },
  },
];

/** Tool names this module executes. `tools.ts` routes on this set. */
export const OPERATIONS_TOOL_NAMES = new Set(OPERATIONS_TOOLS.map((tool) => tool.name));

export interface OperationsToolResult {
  json: unknown;
  numbers: number[];
}

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectNumbers(item, out));
  return out;
}

function periodFrom(input: Record<string, unknown>) {
  return typeof input.period === "string" ? parsePeriod(input.period) : currentMonthPeriod();
}

/**
 * Runs one operations tool.
 *
 * Returns `null` in two cases, and `tools.ts` falls through to its own
 * executor for both:
 *
 * - a tool name this module does not own; and
 * - `get_property_breakdown` / `get_delinquent_accounts` on a workspace with no
 *   operations records. Those two names predate this module and already had
 *   executors reading `portfolio_snapshots`. A workspace whose connector only
 *   pushes aggregates should keep getting that answer rather than being told
 *   there is no data, so the record-based path takes over only where records
 *   actually exist. Every other tool here is new and answers for itself.
 */
export async function runOperationsTool(dbSession: DbSession,
  name: string,
  input: Record<string, unknown>,
  organizationId: string | undefined,
): Promise<OperationsToolResult | null> {
  if (!OPERATIONS_TOOL_NAMES.has(name)) return null;
  if (!organizationId) return { json: noDataAvailable("operations data"), numbers: [] };

  switch (name) {
    case "get_property_breakdown": {
      const portfolio = await summarizePortfolio(dbSession, organizationId);
      // No unit records: let the snapshot-based executor answer instead.
      if (portfolio.occupancy.totalUnits === 0) return null;

      const json = {
        available: true,
        properties: portfolio.propertyCount,
        occupancy: portfolio.occupancy,
        vacancy: portfolio.vacancy,
        rent_position: portfolio.rentPosition,
        unit_mix: portfolio.unitMix,
        // Surfaced to the model, not buried: an answer built over an
        // incomplete sync should say so rather than quietly under-report.
        incomplete_sync: portfolio.unitCountMismatches.length > 0 ? portfolio.unitCountMismatches : undefined,
      };
      return { json, numbers: collectNumbers(json) };
    }

    case "get_delinquent_accounts": {
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
      const period = currentMonthPeriod();
      const accounting = await summarizeAccounting(dbSession, organizationId, period.start, period.end);
      // No ledger: fall through, so the answer comes from one place rather
      // than two paths that could word "no data" differently.
      if (!accounting.aging) return null;
      if (accounting.delinquents.length === 0) {
        return {
          json: { available: true, delinquent_accounts: [], note: "The ledger has entries and none of them are past due." },
          numbers: [],
        };
      }

      const top = accounting.delinquents.slice(0, limit);
      const residents = await residentsForLeases(dbSession, organizationId, top.map((account) => account.leaseId));
      const json = {
        available: true,
        aging_totals_cents: accounting.aging.totals,
        total_past_due_cents: accounting.aging.totalPastDueCents,
        delinquent_lease_count: accounting.aging.delinquentLeaseCount,
        showing: top.length,
        delinquent_accounts: top.map((account) => ({
          lease_id: account.leaseId,
          property: account.propertyName,
          balance_cents: account.balanceCents,
          days_past_due: account.oldestDaysPastDue,
          bucket: account.worstBucket,
          months_of_rent_owed: account.monthsOfRentOwed,
          residents: (residents.get(account.leaseId) ?? []).map((resident) => ({
            name: resident.displayName,
            // The channel to reach them on, so a collections answer can name
            // one. Present only where the record actually has it.
            email: resident.email ?? undefined,
            phone: resident.phone ?? undefined,
            role: resident.role,
          })),
        })),
      };
      return { json, numbers: collectNumbers(json) };
    }

    case "get_operating_statement": {
      const period = periodFrom(input);
      const accounting = await summarizeAccounting(dbSession, organizationId, period.start, period.end);
      if (!accounting.profitAndLoss && !accounting.collections) {
        return { json: noDataAvailable("general-ledger or resident-ledger data"), numbers: [] };
      }
      const json = {
        available: true,
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        profit_and_loss: accounting.profitAndLoss ?? undefined,
        annualized_noi_cents: accounting.annualizedNoiCents ?? undefined,
        by_property: accounting.byProperty,
        expense_lines: accounting.expenseLines,
        collections: accounting.collections ?? undefined,
        aging: accounting.aging ?? undefined,
        deposits_held_cents: accounting.depositsHeldCents,
        utility_reconciliation: accounting.utilityReconciliation ?? undefined,
        // Caveats travel with the figures rather than being dropped, so an
        // answer can repeat what the statement could not see.
        notes: accounting.notes,
      };
      return { json, numbers: collectNumbers(json) };
    }

    case "get_maintenance_performance": {
      const period = periodFrom(input);
      const report = await summarizeMaintenanceOperations(dbSession, organizationId, period.start, period.end);
      if (report.summary.totalWorkOrders === 0) return { json: noDataAvailable("work-order records"), numbers: [] };

      const json = {
        available: true,
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        summary: report.summary,
        sla: report.sla,
        sla_targets_are_aval_defaults:
          "The target hours shown are Aval's defaults, not this workspace's contracted SLAs. Say so if you quote a compliance figure.",
        by_category: report.byCategory,
        vendors: report.vendors,
        first_time_fix_pct: report.firstTimeFixPct,
        cost_per_unit_cents: report.costPerUnitCents,
        spend_by_property: report.spendByProperty,
        unconfirmed_callback_suggestions: report.callbackSuggestions.length,
        callback_note:
          "Callback suggestions are unconfirmed and are NOT included in any first-time-fix figure above. Do not present them as callbacks.",
      };
      return { json, numbers: collectNumbers(json) };
    }

    case "get_leasing_velocity": {
      const period = periodFrom(input);
      const leasing = await summarizeLeasing(dbSession, organizationId, period.start, period.end);
      if (!leasing.health && leasing.activeLeaseCount === 0) {
        return { json: noDataAvailable("leasing lead or lease records"), numbers: [] };
      }
      const json = {
        available: true,
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        funnel: leasing.funnel ?? undefined,
        health: leasing.health ?? undefined,
        by_channel: leasing.byChannel,
        by_unit_type: leasing.byUnitType,
        lost_reasons: leasing.lostReasons,
        renewals: leasing.renewals ?? undefined,
        expirations: leasing.expirations,
        active_leases: leasing.activeLeaseCount,
      };
      return { json, numbers: collectNumbers(json) };
    }

    case "get_operations_insights": {
      const period = periodFrom(input);
      const [portfolio, leasing, maintenance, accounting, conflicts] = await Promise.all([
        summarizePortfolio(dbSession, organizationId),
        summarizeLeasing(dbSession, organizationId, period.start, period.end),
        summarizeMaintenanceOperations(dbSession, organizationId, period.start, period.end),
        summarizeAccounting(dbSession, organizationId, period.start, period.end),
        listOpenConflicts(dbSession, organizationId),
      ]);
      const insights = deriveInsights({ portfolio, leasing, maintenance, accounting, conflicts });
      if (insights.length === 0) {
        return {
          json: {
            available: true,
            insights: [],
            note:
              "No finding met a threshold for this period. If this workspace has little or no operations data, say that rather than reporting that everything is healthy.",
          },
          numbers: [],
        };
      }
      const json = {
        available: true,
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        insights: insights.map((item) => ({
          kind: item.kind,
          severity: item.severity,
          module: item.module,
          title: item.title,
          detail: item.detail,
          suggested_action: item.suggestedAction,
          evidence: item.evidence,
        })),
      };
      // Figures come from each insight's own `figures` array rather than from
      // scraping the text, so the gate verifies against what the rules
      // computed instead of against whatever numerals a sentence happens to
      // contain.
      return { json, numbers: insights.flatMap((item) => item.figures) };
    }

    case "get_data_conflicts": {
      const conflicts = await listOpenConflicts(dbSession, organizationId);
      if (conflicts.length === 0) {
        return { json: { available: true, conflicts: [], note: "No connected systems currently disagree about a stored field." }, numbers: [] };
      }
      const json = {
        available: true,
        open_conflicts: conflicts.length,
        conflicts: conflicts.map((conflict) => ({
          entity: `${conflict.entityType}:${conflict.entityId}`,
          field: conflict.field,
          stored_value: conflict.valueA,
          stored_source: conflict.sourceA,
          conflicting_value: conflict.valueB,
          conflicting_source: conflict.sourceB,
          detected_at: conflict.detectedAt.toISOString(),
        })),
        note: "Aval kept the stored value in every case and changed nothing. Figures built on these fields are contested until resolved.",
      };
      // Only the count is a figure about the business. The conflicting values
      // themselves are two systems' unreconciled claims, and admitting them
      // would let the gate vouch for a number nobody has verified.
      return { json, numbers: [conflicts.length] };
    }

    default:
      return null;
  }
}

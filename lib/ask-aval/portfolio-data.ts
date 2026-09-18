/**
 * Reads the real figures a workspace's connected sources have actually
 * delivered, for Ask Aval's data tools.
 *
 * Every function here returns `null` — never a placeholder, an estimate, or a
 * demo figure — when nothing has been synced. The tools turn that null into an
 * explicit "no connected source has provided this" for the model, which then
 * has to say so. That is the entire point: a confident answer built from
 * fabricated numbers is worse than no answer, because the user cannot tell the
 * difference by looking at it.
 *
 * The dashboard still renders a sample portfolio for a workspace with nothing
 * connected — that is a demonstration surface. The assistant is not, because
 * an answer is a claim about *your* business in a way a marketing screen isn't.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { funnelSnapshots, portfolioSnapshots } from "@/db/postgres/schema";

/** Metric keys the sync layer writes into `portfolio_snapshots`. */
export const METRIC_KEYS = [
  "noi",
  "rent_billed",
  "rent_collected",
  "economic_occupancy_pct",
  "open_work_orders",
  "urgent_work_orders",
  "avg_work_order_close_days",
  "total_units",
  "total_properties",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface MetricPoint {
  value: number;
  capturedAt: Date;
  source: string;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * The two most recent readings for each requested metric — current and prior —
 * so a tool can report change over time only where a real prior reading
 * exists. A metric with a single reading reports no delta rather than
 * comparing against zero, which would render as a fictitious +100%.
 */
export async function readMetrics(dbSession: DbSession, organizationId: string, keys: readonly MetricKey[] = METRIC_KEYS): Promise<Map<MetricKey, { current: MetricPoint; prior: MetricPoint | null }>> {
  const rows = await dbSession.db
    .select({
      metricKey: portfolioSnapshots.metricKey,
      numericValue: portfolioSnapshots.numericValue,
      capturedAt: portfolioSnapshots.capturedAt,
      source: portfolioSnapshots.source,
      periodStart: portfolioSnapshots.periodStart,
      periodEnd: portfolioSnapshots.periodEnd,
    })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), inArray(portfolioSnapshots.metricKey, [...keys])))
    .orderBy(desc(portfolioSnapshots.capturedAt));

  const byKey = new Map<MetricKey, { current: MetricPoint; prior: MetricPoint | null }>();
  for (const row of rows) {
    if (row.numericValue === null) continue;
    const key = row.metricKey as MetricKey;
    const point: MetricPoint = {
      value: row.numericValue,
      capturedAt: row.capturedAt,
      source: row.source,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    };
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { current: point, prior: null });
    else if (!existing.prior) existing.prior = point;
  }
  return byKey;
}

/** A metric's full history, newest first, for trend questions. */
export async function readMetricSeries(dbSession: DbSession, organizationId: string, key: string, limit = 24): Promise<MetricPoint[]> {
  const rows = await dbSession.db
    .select({
      numericValue: portfolioSnapshots.numericValue,
      capturedAt: portfolioSnapshots.capturedAt,
      source: portfolioSnapshots.source,
      periodStart: portfolioSnapshots.periodStart,
      periodEnd: portfolioSnapshots.periodEnd,
    })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), eq(portfolioSnapshots.metricKey, key)))
    .orderBy(desc(portfolioSnapshots.capturedAt))
    .limit(limit);
  return rows
    .filter((row) => row.numericValue !== null)
    .map((row) => ({
      value: row.numericValue as number,
      capturedAt: row.capturedAt,
      source: row.source,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    }));
}

export interface FunnelStageCount { stage: string; count: number; capturedAt: Date; source: string }

/** The most recent reading per funnel stage. */
export async function readFunnel(dbSession: DbSession, organizationId: string): Promise<FunnelStageCount[]> {
  const rows = await dbSession.db
    .select({
      stage: funnelSnapshots.stage,
      count: funnelSnapshots.count,
      capturedAt: funnelSnapshots.capturedAt,
      source: funnelSnapshots.source,
    })
    .from(funnelSnapshots)
    .where(eq(funnelSnapshots.organizationId, organizationId))
    .orderBy(desc(funnelSnapshots.capturedAt));

  const seen = new Set<string>();
  const latest: FunnelStageCount[] = [];
  for (const row of rows) {
    if (seen.has(row.stage)) continue;
    seen.add(row.stage);
    latest.push(row);
  }
  return latest;
}

/**
 * The standard shape for "this workspace has no data for that".
 *
 * Carries `available: false` and a plain instruction rather than an error, so
 * the model treats it as a fact to report instead of a failure to retry or
 * work around. The wording tells it explicitly not to substitute an estimate,
 * because a tool returning nothing is the exact moment a model is most tempted
 * to fill the gap from prior knowledge.
 */
export function noDataAvailable(what: string): { available: false; detail: string } {
  return {
    available: false,
    detail: `No connected source has provided ${what} for this workspace yet. Say so plainly. Do not estimate, infer, or use any figure from outside these tools.`,
  };
}

/** Percent change between two readings, or null when there is no real prior. */
export function deltaPct(current: number, prior: number | null | undefined): number | null {
  if (prior === null || prior === undefined || prior === 0) return null;
  return Math.round(((current - prior) / prior) * 10000) / 100;
}

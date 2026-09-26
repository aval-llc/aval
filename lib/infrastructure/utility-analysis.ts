/** Deterministic calculations: no inferred units, tariff rates or causal claims. */
export interface AnalysisMeter { id: string; utilityType: string; unitOfMeasure: string; siteId?: string | null }
export interface AnalysisBill {
  id: string; meterId: string; periodStart: Date; periodEnd: Date;
  usageAmount: number; costCents: number; currency: string;
  unitOfMeasure?: string | null; readingKind?: string | null;
}
export function summarizeUtilityRecords(meters: AnalysisMeter[], bills: AnalysisBill[], asOf = new Date()) {
  return [...new Set(meters.map(m => m.utilityType))].sort().map(utilityType => {
    const selected = meters.filter(m => m.utilityType === utilityType).sort((a,b) => a.id.localeCompare(b.id));
    const meterMap = new Map(selected.map(m => [m.id, m]));
    const rows = bills.filter(b => meterMap.has(b.meterId)).sort((a,b) => a.id.localeCompare(b.id));
    const usage = new Map<string, number>();
    const costs = new Map<string, { count: number; costCents: number }>();
    for (const b of rows) {
      const unit = b.unitOfMeasure ?? meterMap.get(b.meterId)!.unitOfMeasure;
      usage.set(unit, (usage.get(unit) ?? 0) + b.usageAmount);
      const cost = costs.get(b.currency) ?? { count: 0, costCents: 0 };
      costs.set(b.currency, { count: cost.count + 1, costCents: cost.costCents + b.costCents });
    }
    const currency = [...costs].sort((a,b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0]?.[0] ?? "USD";
    const money = costs.get(currency);
    const sameCurrencyUsage = rows.filter(b => b.currency === currency).reduce((n,b) => n + b.usageAmount, 0);
    const meterComparisons = selected.map(m => {
      const history = rows.filter(b => b.meterId === m.id).sort((a,b) => b.periodStart.getTime() - a.periodStart.getTime() || a.id.localeCompare(b.id));
      const [current, prior] = history;
      let reason: string | null = null;
      if (!m.siteId) reason = "unmapped_meter";
      else if (!current || !prior) reason = "insufficient_history";
      else if (current.periodEnd > asOf) reason = "incomplete_period";
      else if (current.periodEnd <= current.periodStart || prior.periodEnd <= prior.periodStart) reason = "invalid_period";
      else if (prior.periodEnd > current.periodStart) reason = "overlapping_periods";
      else if (prior.periodEnd.getTime() !== current.periodStart.getTime()) reason = "gap_between_periods";
      else if ((current.unitOfMeasure ?? m.unitOfMeasure) !== (prior.unitOfMeasure ?? m.unitOfMeasure)) reason = "unit_changed";
      else if ([current, prior].some(b => b.readingKind === "estimated" || b.readingKind === "unknown")) reason = "estimated_reading";
      else if (prior.usageAmount <= 0) reason = "zero_baseline";
      const daily = (b: AnalysisBill) => b.usageAmount / ((b.periodEnd.getTime() - b.periodStart.getTime()) / 86400000);
      return { meterId: m.id, siteId: m.siteId ?? null, currentBillId: current?.id ?? null, priorBillId: prior?.id ?? null,
        variancePct: reason ? null : (daily(current) / daily(prior) - 1) * 100, reason };
    });
    return { utilityType, meterCount: selected.length, billCount: rows.length, periodScope: "all_recorded" as const,
      totalUsage: usage.size === 1 ? [...usage.values()][0] : rows.length === 0 ? 0 : null,
      unitOfMeasure: usage.size === 1 ? [...usage.keys()][0] : null,
      usageByUnit: [...usage].sort((a,b) => a[0].localeCompare(b[0])).map(([unitOfMeasure, usageAmount]) => ({ unitOfMeasure, usageAmount })),
      costsByCurrency: [...costs].sort((a,b) => a[0].localeCompare(b[0])).map(([currency,cost]) => ({ currency, ...cost })),
      totalCostCents: money?.costCents ?? 0, currency, otherCurrencyBillCount: rows.length - (money?.count ?? 0),
      averageCostPerUnit: usage.size === 1 && sameCurrencyUsage > 0 ? (money?.costCents ?? 0) / sameCurrencyUsage : null,
      costBasis: "blended_invoice_total" as const,
      usageVariancePct: meterComparisons.length === 1 ? meterComparisons[0].variancePct : null,
      meterComparisons, unmappedMeterCount: selected.filter(m => !m.siteId).length };
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUtilityRecords, type AnalysisBill } from "../lib/infrastructure/utility-analysis.ts";
import { meters, bills } from "./fixtures/utility-pilot.ts";
const analyze = (rows: AnalysisBill[] = bills) => summarizeUtilityRecords(meters, rows, new Date("2026-09-01"))[0];
test("pilot: mixed units never form one usage total or rate; currencies stay separate", () => {
  const r = analyze();
  assert.equal(r.totalUsage, null); assert.equal(r.averageCostPerUnit, null);
  assert.deepEqual(r.usageByUnit, [{ unitOfMeasure: "gal", usageAmount: 900 }, { unitOfMeasure: "m3", usageAmount: 750 }]);
  assert.equal(r.totalCostCents, 150000); assert.equal(r.otherCurrencyBillCount, 1);
});
test("pilot: variance compares the same meter, never the latest two organization bills", () => {
  const r = analyze(); assert.equal(r.usageVariancePct, null);
  assert.equal(r.meterComparisons[0].variancePct, 50);
  assert.equal(r.meterComparisons[1].reason, "insufficient_history");
});
test("pilot: unequal periods use daily consumption", () => {
  assert.equal(analyze([bills[0], { ...bills[1], periodEnd: new Date("2026-04-01"), usageAmount: 600 }]).meterComparisons[0].variancePct, 0);
});
test("pilot: zero baseline, overlaps, estimated readings and changed units block comparisons", () => {
  for (const [patch, reason] of [
    [{ usageAmount: 0 }, "zero_baseline"], [{ periodEnd: new Date("2026-02-02") }, "overlapping_periods"],
    [{ readingKind: "estimated" }, "estimated_reading"], [{ unitOfMeasure: "gal" }, "unit_changed"],
  ] as const) {
    const r = analyze([{ ...bills[0], ...patch }, bills[1]]).meterComparisons[0];
    assert.equal(r.variancePct, null); assert.equal(r.reason, reason);
  }
});
test("pilot: zero usage is safe; ordering is deterministic", () => {
  assert.equal(analyze([{ ...bills[0], usageAmount: 0 }]).averageCostPerUnit, null);
  assert.deepEqual(analyze([...bills].reverse()), analyze());
});
test("pilot: incomplete periods and unmapped meters cannot produce findings", () => {
  assert.equal(summarizeUtilityRecords(meters,bills,new Date("2026-02-01"))[0].meterComparisons[0].reason,"incomplete_period");
  assert.equal(summarizeUtilityRecords([{ ...meters[0], siteId: null }],bills)[0].meterComparisons[0].reason,"unmapped_meter");
});

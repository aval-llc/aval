import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUtilityRecords, type AnalysisBill } from "../lib/infrastructure/utility-analysis.ts";
import { meters, bills } from "./fixtures/utility-pilot.ts";
import { parseUtilityCsv } from "../lib/infrastructure/import-format.ts";
import { validateBill } from "../lib/infrastructure/validation.ts";
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
test("pilot: parent and submeter consumption is not counted twice", () => {
  const r=summarizeUtilityRecords([meters[0],{...meters[0],id:'child',parentMeterId:'astra'}],[bills[0],{...bills[0],id:'child-bill',meterId:'child'}])[0];
  assert.equal(r.totalUsage,300);assert.equal(r.totalCostCents,60000);
  assert.equal(r.meterComparisons.length,2);
});
test("pilot: CSV preserves identifiers and rejects malformed or unexpected input", () => {
  assert.deepEqual(parseUtilityCsv('sourceSystem,externalId,usageAmount,costCents\r\n"SAP, export",0001,1.5,200\r\n'),[{sourceSystem:'SAP, export',externalId:'0001',usageAmount:1.5,costCents:200}]);
  for(const csv of ['meterId,meterId\na,b','meterId\n"unfinished','costCents\n=1+1','tenantName\nPerson','meterId\n"id"extra'])assert.throws(()=>parseUtilityCsv(csv));
});
test("pilot: strict dates, explicit currency, exact money and invoice tax reconciliation", () => {
  const b={...bills[0],periodStart:'2026-01-01',periodEnd:'2026-01-31',unitOfMeasure:'m3'};
  assert.equal(validateBill({...b,subtotalCents:50000,taxCents:10000}).costCents,60000);
  for(const patch of [{periodStart:'2026-02-30'},{currency:'EUR'},{currency:undefined},{costCents:2.4},{usageAmount:Infinity},{subtotalCents:50000,taxCents:9999},{subtotalCents:0}])assert.throws(()=>validateBill({...b,...patch}));
});

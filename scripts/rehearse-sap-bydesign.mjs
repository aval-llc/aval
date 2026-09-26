#!/usr/bin/env node
/** Offline rehearsal only. No environment credentials, external SAP calls or DB writes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareByDesignUtilityImport } from '../lib/integrations/sap-bydesign/prepare-import.ts';
import { summarizeUtilityRecords } from '../lib/infrastructure/utility-analysis.ts';
import { syntheticCredentials, syntheticProfile, syntheticReadConfig } from '../tests/fixtures/sap-bydesign/synthetic.ts';
import { startByDesignSimulator } from '../tests/fixtures/sap-bydesign/simulator.mjs';

const simulator = await startByDesignSimulator();
try {
  const prepared = await prepareByDesignUtilityImport(syntheticReadConfig, syntheticCredentials, syntheticProfile, simulator.fetch);
  const bills = prepared.rows.map((row, index) => ({ ...row, id: `synthetic-${index}`, periodStart: new Date(row.periodStart), periodEnd: new Date(row.periodEnd) }));
  const meters = [{ id: syntheticProfile.meters[0].avalMeterId, utilityType: 'water', unitOfMeasure: 'm3', siteId: 'synthetic-site' }];
  const summary = summarizeUtilityRecords(meters, bills, new Date('2026-09-01'))[0];
  assert.equal(summary.meterComparisons[0].variancePct, 50);
  assert.equal(summary.totalCostCents, 29000);
  assert.equal(summary.totalUsage, 730);
  const directory = new URL('../outputs/sap-bydesign/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const report = {
    evaluatedAt: new Date().toISOString(), mode: 'synthetic_bydesign_odata_v2', liveSapValidated: false,
    sourceSchema: 'invented fixture, not Gentor or a standard SAP utility service',
    sourceRows: prepared.rows.length, pages: prepared.evidence.pages,
    expected: { dailyUsageVariancePct: 50, totalCostCents: 29000, totalUsageM3: 730 },
    actual: { dailyUsageVariancePct: summary.meterComparisons[0].variancePct, totalCostCents: summary.totalCostCents, totalUsageM3: summary.totalUsage },
    passed: true, providerCalls: 0, modelCalls: 0, externalWrites: 0, costUsd: 0,
    nextGate: 'Real ByDesign tenant, enabled service metadata and customer-approved mappings required',
  };
  await writeFile(new URL('rehearsal.json', directory), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(new URL('synthetic-reviewed-bills.json', directory), `${JSON.stringify(prepared.rows, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await simulator.close(); }

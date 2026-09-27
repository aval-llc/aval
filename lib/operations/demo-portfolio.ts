import type { ImportBatch } from './import-plan';

/** Explicitly fictional, stable IDs. Dates are anchored to workspace creation. */
export function demoPortfolio(anchor: Date): ImportBatch {
  const date = (days: number) => new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + days)).toISOString();
  const batch: ImportBatch = { properties: [], units: [], residents: [], leases: [], ledgerEntries: [], workOrders: [] };
  const names = ['Demo Harbor Court', 'Demo Cedar Gardens', 'Demo Vista Place'];
  for (let p = 0; p < 3; p++) {
    batch.properties!.push({ externalId: `demo-property-${p}`, name: names[p], city: 'Demo City', country: 'US', propertyType: 'multifamily' });
    for (let u = 0; u < 8; u++) {
      const id = `${p}-${u}`;
      batch.units!.push({ externalId: `demo-unit-${id}`, propertyExternalId: `demo-property-${p}`, unitNumber: String(101 + u), bedrooms: 2, marketRentCents: 100000, status: u < 6 ? 'occupied' : 'vacant_ready' });
      if (u >= 6) continue;
      batch.residents!.push({ externalId: `demo-resident-${id}`, displayName: `Sample Resident ${p + 1}-${u + 1}`, email: `resident-${id}@example.invalid`, status: 'current' });
      batch.leases!.push({ externalId: `demo-lease-${id}`, unitExternalId: `demo-unit-${id}`, residentExternalIds: [`demo-resident-${id}`], status: 'active', startDate: date(-300), endDate: date(u === 0 ? [20,50,80][p] : 200), rentCents: 100000, rentDueDay: 1 });
      batch.ledgerEntries!.push({ externalId: `demo-charge-${id}`, leaseExternalId: `demo-lease-${id}`, entryType: 'charge', category: 'rent', amountCents: 100000, postedAt: date(-20), dueAt: date(-15), memo: 'Fictional demo rent, USD' });
      const unpaid = u === 0 ? [100000,50000,25000][p] : 0;
      if (unpaid < 100000) batch.ledgerEntries!.push({ externalId: `demo-payment-${id}`, leaseExternalId: `demo-lease-${id}`, entryType: 'payment', category: 'rent', amountCents: 100000 - unpaid, postedAt: date(-10), memo: 'Fictional demo payment, USD' });
    }
  }
  batch.workOrders!.push({ externalId: 'demo-maintenance-1', propertyExternalId: 'demo-property-0', unitExternalId: 'demo-unit-0-0', summary: 'Sample request: kitchen tap leaking; source does not establish the cause.', category: 'plumbing', priority: 'routine', reportedAt: date(-2) });
  batch.workOrders!.push({ externalId: 'demo-maintenance-2', propertyExternalId: 'demo-property-1', unitExternalId: 'demo-unit-1-1', summary: 'Sample request: hallway light not working.', category: 'electrical', priority: 'routine', reportedAt: date(-1) });
  return batch;
}

export const DEMO_GOALS = [
  'Review the sample maintenance requests. Cite the affected property and unit, distinguish reported symptoms from an established cause, and prepare one recommended internal follow-up for approval. Do not contact residents or write to a PMS.',
  'Find sample leases expiring within 30, 60 and 90 days. Cite each lease and its end date. Draft a follow-up for each relevant resident without assuming renewal terms or sending messages.',
  'Report the sample overdue rent balances in USD as of today. Read ledger evidence, show balances by lease and the portfolio total, explain missing information, and do not invent payments or send collection notices.',
];

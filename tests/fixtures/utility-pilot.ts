// Synthetic only; not Gentor customer records.
export const meters = [
  { id: "astra", utilityType: "water", unitOfMeasure: "m3", siteId: "astra-site" },
  { id: "seisa", utilityType: "water", unitOfMeasure: "gal", siteId: "seisa-site" },
];
export const bills = [
  { id: "a1", meterId: "astra", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), usageAmount: 300, costCents: 60000, currency: "MXN" },
  { id: "a2", meterId: "astra", periodStart: new Date("2026-01-31"), periodEnd: new Date("2026-03-02"), usageAmount: 450, costCents: 90000, currency: "MXN" },
  { id: "s1", meterId: "seisa", periodStart: new Date("2026-03-01"), periodEnd: new Date("2026-04-01"), usageAmount: 900, costCents: 5000, currency: "USD" },
];

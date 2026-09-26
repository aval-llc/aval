import type { ByDesignReadConfig } from "../../../lib/integrations/sap-bydesign/odata.ts";
import type { ByDesignUtilityProfile } from "../../../lib/integrations/sap-bydesign/utility-mapping.ts";

// Invented fixture fields and service path. NOT SAP standard utility objects,
// NOT downloaded SAP tenant data, and NOT Gentor/SEISA/Astra production data.
export const syntheticRows = [
  { CompanyID: "SYNTHETIC", AccountID: "00017", MeterID: "WATER-001", BillID: "000001", Start: "/Date(1767225600000)/", End: "2026-01-31", Quantity: "310.000000", UnitCode: "M3", Gross: "116.00", Currency: "MXN", Reading: "ACT", Net: "100.00", Tax: "16.00" },
  { CompanyID: "SYNTHETIC", AccountID: "00017", MeterID: "WATER-001", BillID: "000002", Start: "2026-02-01", End: "2026-02-28", Quantity: "420.000000", UnitCode: "M3", Gross: "174.00", Currency: "MXN", Reading: "ACT", Net: "150.00", Tax: "24.00" },
];
export const syntheticCredentials = { username: "fixture-reader", password: "synthetic-not-a-real-secret" };
export const syntheticReadConfig: ByDesignReadConfig = {
  tenantUrl: "https://aval-fixture.sapbydesign.com",
  collectionPath: "/sap/byd/odata/cust/v1/aval_synthetic/UtilityBillCollection",
  select: Object.keys(syntheticRows[0]),
  orderBy: ["CompanyID", "AccountID", "BillID"],
  companyFilter: { field: "CompanyID", value: "SYNTHETIC" },
  pageSize: 1,
};
export const syntheticProfile: ByDesignUtilityProfile = {
  sourceNamespace: "sap-bydesign/synthetic-fixture",
  companyId: "SYNTHETIC",
  fields: { company: "CompanyID", account: "AccountID", meter: "MeterID", bill: "BillID", start: "Start", end: "End", usage: "Quantity", unit: "UnitCode", total: "Gross", currency: "Currency", reading: "Reading", subtotal: "Net", tax: "Tax" },
  periodEnd: "inclusive", amountUnit: "major",
  unitCodes: { M3: "m3", GAL: "gal", KWH: "kWh" },
  readingCodes: { ACT: "actual", EST: "estimated", UNK: "unknown" },
  meters: [{ accountId: "00017", sourceMeterId: "WATER-001", avalMeterId: "synthetic-aval-meter" }],
};

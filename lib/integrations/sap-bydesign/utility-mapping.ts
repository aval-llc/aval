import { ByDesignError } from "./odata.ts";
import { validateBill } from "../../infrastructure/validation.ts";

export interface ByDesignUtilityProfile {
  /** Reviewed source namespace; never infer an Aval organization from the payload. */
  sourceNamespace: string;
  companyId: string;
  fields: Record<"company" | "account" | "meter" | "bill" | "start" | "end" | "usage" | "unit" | "total" | "currency", string> &
    Partial<Record<"reading" | "subtotal" | "tax" | "tariff", string>>;
  periodEnd: "inclusive" | "exclusive";
  amountUnit: "major" | "minor";
  unitCodes: Record<string, "m3" | "gal" | "ccf" | "kWh" | "therm">;
  readingCodes: Record<string, "actual" | "estimated" | "unknown">;
  meters: { accountId: string; sourceMeterId: string; avalMeterId: string }[];
}
function text(value: unknown) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 200 || Array.from(value).some(c => c.charCodeAt(0) < 32)) throw new ByDesignError("INVALID_SOURCE_FIELD");
  return value;
}
/** Exact decimal conversion; never round a tax amount into a plausible value. */
export function decimalMinorUnits(value: unknown, unit: "major" | "minor") {
  const string = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(string)) throw new ByDesignError("INVALID_MONEY");
  const [whole, fraction = ""] = string.split(".");
  const places = unit === "major" ? 2 : 0;
  if (fraction.slice(places).replaceAll("0", "")) throw new ByDesignError("FRACTIONAL_MINOR_UNITS");
  const scaled = BigInt(whole) * (unit === "major" ? BigInt(100) : BigInt(1)) + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
  if (scaled > BigInt(10_000_000_000)) throw new ByDesignError("MONEY_OUT_OF_RANGE");
  return Number(scaled);
}
function date(value: unknown) {
  const string = text(value);
  // OData v2 dates use UTC epoch milliseconds. Non-midnight values require a
  // reviewed timezone mapping rather than silently truncating a local date.
  const epoch = /^\/Date\((-?\d+)\)\/$/.exec(string);
  if (epoch) {
    const parsed = new Date(Number(epoch[1]));
    if (!Number.isFinite(parsed.getTime()) || parsed.getUTCHours() || parsed.getUTCMinutes() || parsed.getUTCSeconds() || parsed.getUTCMilliseconds()) throw new ByDesignError("AMBIGUOUS_SOURCE_DATE");
    return parsed.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(string)) throw new ByDesignError("AMBIGUOUS_SOURCE_DATE");
  const parsed = new Date(string);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== string) throw new ByDesignError("INVALID_SOURCE_DATE");
  return string;
}

/** Synthetic profiles are examples, not claims about Gentor's exposed SAP schema.
 * Return only Aval's allowlisted import fields; provider text never becomes instructions. */
export function mapByDesignUtilityRows(rows: Record<string, unknown>[], profile: ByDesignUtilityProfile) {
  if (!rows.length || rows.length > 500) throw new ByDesignError("INVALID_ROW_COUNT");
  if (!["major", "minor"].includes(profile.amountUnit) || !["inclusive", "exclusive"].includes(profile.periodEnd)) throw new ByDesignError("INVALID_PROFILE");
  text(profile.sourceNamespace); text(profile.companyId);
  const mappings = new Map<string, string>();
  for (const meter of profile.meters) {
    const key = JSON.stringify([text(meter.accountId), text(meter.sourceMeterId)]);
    if (mappings.has(key)) throw new ByDesignError("AMBIGUOUS_METER_MAPPING");
    mappings.set(key, text(meter.avalMeterId));
  }
  const seen = new Set<string>();
  return rows.map(row => {
    const f = profile.fields;
    if (row[f.company] !== profile.companyId) throw new ByDesignError("COMPANY_SCOPE_MISMATCH");
    const account = text(row[f.account]);
    const meterId = mappings.get(JSON.stringify([account, text(row[f.meter])]));
    if (!meterId) throw new ByDesignError("UNMAPPED_SOURCE_METER");
    const externalId = text(row[f.bill]);
    const sourceSystem = `${profile.sourceNamespace}/${encodeURIComponent(profile.companyId)}/${encodeURIComponent(account)}`;
    if (sourceSystem.length > 200) throw new ByDesignError("SOURCE_NAMESPACE_TOO_LONG");
    const key = JSON.stringify([sourceSystem, externalId]);
    if (seen.has(key)) throw new ByDesignError("DUPLICATE_SOURCE_BILL");
    seen.add(key);
    const unitCode = text(row[f.unit]);
    const unitOfMeasure = Object.hasOwn(profile.unitCodes, unitCode) ? profile.unitCodes[unitCode] : undefined;
    if (!unitOfMeasure) throw new ByDesignError("UNMAPPED_SOURCE_UNIT");
    const readingCode = f.reading && row[f.reading] != null ? text(row[f.reading]) : null;
    const readingKind = readingCode === null ? "unknown" : Object.hasOwn(profile.readingCodes, readingCode) ? profile.readingCodes[readingCode] : undefined;
    if (!readingKind) throw new ByDesignError("UNMAPPED_READING_KIND");
    const quantity = text(row[f.usage]);
    if (!/^\d+(?:\.\d{1,6})?$/.test(quantity)) throw new ByDesignError("INVALID_SOURCE_QUANTITY");
    let periodEnd = date(row[f.end]);
    if (profile.periodEnd === "inclusive") periodEnd = new Date(new Date(periodEnd).getTime() + 86400000).toISOString().slice(0, 10);
    const bill = {
      meterId, sourceSystem, externalId, periodStart: date(row[f.start]), periodEnd,
      usageAmount: Number(quantity), unitOfMeasure, readingKind,
      costCents: decimalMinorUnits(row[f.total], profile.amountUnit), currency: text(row[f.currency]),
      subtotalCents: f.subtotal && row[f.subtotal] != null ? decimalMinorUnits(row[f.subtotal], profile.amountUnit) : null,
      taxCents: f.tax && row[f.tax] != null ? decimalMinorUnits(row[f.tax], profile.amountUnit) : null,
      tariffCode: f.tariff && row[f.tariff] != null ? text(row[f.tariff]) : null,
    };
    try { validateBill(bill); } catch { throw new ByDesignError("INVALID_NORMALIZED_BILL"); }
    return bill;
  });
}

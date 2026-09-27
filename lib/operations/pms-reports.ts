import type { ImportBatch } from './import-plan.ts';

/** These are Aval's fields, not a claimed vendor-specific API/export contract. */
export const REPORT_FIELDS = {
  properties: ['externalId','name','addressLine1','city','region','postalCode','country','propertyType'],
  units: ['externalId','propertyExternalId','unitNumber','bedrooms','bathrooms','marketRentCents','status'],
  residents: ['externalId','displayName','email','phone','status'],
  leases: ['externalId','unitExternalId','residentExternalIds','status','startDate','endDate','rentCents','depositCents'],
  workOrders: ['externalId','propertyExternalId','unitExternalId','category','priority','status','summary','reportedAt'],
  ledgerEntries: ['externalId','leaseExternalId','entryType','category','amountCents','postedAt','dueAt','memo'],
} as const;
export type ReportDataset = keyof typeof REPORT_FIELDS;

export function parseReportCsv(text: string): { headers: string[]; rows: string[][] } {
  if (text.length > 2_000_000) throw Error('Report exceeds 2 MB');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (c === '\r' && input[i+1] === '\n') i++; }
    } else { if (closed || c === '"') throw Error('Malformed quoted CSV field'); cell += c; }
  }
  if (quoted) throw Error('Unclosed CSV quote');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map(s => s.trim()) ?? [];
  if (!headers.length || headers.some(h => !h) || new Set(headers).size !== headers.length) throw Error('Unique nonempty column headers are required');
  if (rows.length > 2000 || rows.some(r => r.length !== headers.length)) throw Error('Use at most 2,000 rows with consistent columns');
  return { headers, rows };
}

export function mapPmsReport(provider: string, dataset: ReportDataset, csv: string, mapping: Record<string,string>, currency: string): ImportBatch {
  if (!['appfolio','yardi'].includes(provider) || !Object.hasOwn(REPORT_FIELDS,dataset)) throw Error('Unsupported report source');
  // Canonical receivables currently have no currency column. Never mix currencies silently.
  if (currency !== 'USD') throw Error('This report importer currently supports USD only; other currencies require a separate supported adapter');
  const { headers, rows } = parseReportCsv(csv);
  const currencyColumn = headers.findIndex(h=>/^(currency|moneda)$/i.test(h));
  if(currencyColumn>=0 && rows.some(r=>r[currencyColumn].trim().toUpperCase()!=='USD')) throw Error('Every report row must explicitly use USD; mixed or unknown currency cannot be imported');
  const fields: readonly string[] = REPORT_FIELDS[dataset];
  if (Object.keys(mapping).some(k => !fields.includes(k)) || Object.values(mapping).some(h => h && !headers.includes(h))) throw Error('Invalid field mapping');
  const prefix = (id: string) => `${provider}:report:${id.trim()}`;
  const records = rows.map(values => {
    const out: Record<string,unknown> = {};
    for (const field of fields) {
      const header = mapping[field]; if (!header) continue;
      const value = values[headers.indexOf(header)].trim(); if (!value) continue;
      if (field === 'residentExternalIds') out[field] = value.split(';').map(prefix);
      else if (field === 'externalId' || field.endsWith('ExternalId')) out[field] = prefix(value);
      else if (field.endsWith('Cents') || ['bedrooms','bathrooms'].includes(field)) {
        if (!/^\d+(\.\d+)?$/.test(value)) throw Error(`${field} must be numeric; money fields use integer cents`);
        const amount = Number(value);
        if (!Number.isFinite(amount) || (field.endsWith('Cents') && !Number.isSafeInteger(amount))) throw Error('Money must be safe integer cents');
        out[field] = amount;
      } else out[field] = value;
    }
    return out;
  });
  return { [dataset]: records } as ImportBatch;
}


type Guidance = { en: string; esMx: string };
export type MaintenancePolicyInput = { company: Guidance | null; allowPropertyOverride: boolean; properties: { propertyId: string; guidance: Guidance }[] };
export type MaintenancePolicy = MaintenancePolicyInput & { version: 1; revision: string; approvedBy: string; approvedAt: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export function parseMaintenancePolicy(value: unknown): MaintenancePolicyInput {
  if (!object(value) || !exact(value, ['company','allowPropertyOverride','properties']) || typeof value.allowPropertyOverride !== 'boolean' || !Array.isArray(value.properties) || value.properties.length > 100) throw Error('Invalid maintenance policy configuration');
  const guidance = (v: unknown): Guidance => {
    if (!object(v) || !exact(v, ['en','esMx']) || [v.en,v.esMx].some(t => typeof t !== 'string' || !t.trim() || t.length > 2000)) throw Error('Provide approved emergency guidance in English and Mexican Spanish');
    return { en: (v.en as string).trim(), esMx: (v.esMx as string).trim() };
  };
  const ids = new Set<string>();
  const properties = value.properties.map(p => {
    if (!object(p) || !exact(p, ['propertyId','guidance']) || typeof p.propertyId !== 'string' || !p.propertyId || p.propertyId.length > 100 || ids.has(p.propertyId)) throw Error('Each property policy needs a unique property ID');
    ids.add(p.propertyId); return { propertyId: p.propertyId, guidance: guidance(p.guidance) };
  });
  return { company: value.company === null ? null : guidance(value.company), allowPropertyOverride: value.allowPropertyOverride, properties };
}

/** Policy supplies proposed wording, never permission to dispatch, spend or send. */
export function resolveMaintenancePolicy(raw: unknown, propertyId: string) {
  const unavailable = (status: 'missing' | 'invalid' | 'conflict') => ({ version: 1, status, propertyId, revision: null as string | null, guidance: null as Guidance | null, approvedBy: null as string | null, approvedAt: null as string | null });
  if (raw === undefined || raw === null) return unavailable('missing');
  try {
    if (!object(raw) || raw.version !== 1 || typeof raw.revision !== 'string' || !raw.revision || typeof raw.approvedBy !== 'string' || !raw.approvedBy || typeof raw.approvedAt !== 'string' || !Number.isFinite(Date.parse(raw.approvedAt))) return unavailable('invalid');
    const input = parseMaintenancePolicy({ company: raw.company, allowPropertyOverride: raw.allowPropertyOverride, properties: raw.properties });
    const property = input.properties.find(p => p.propertyId === propertyId)?.guidance;
    const metadata = { revision: raw.revision, approvedBy: raw.approvedBy, approvedAt: raw.approvedAt };
    if (property && input.company && !input.allowPropertyOverride && JSON.stringify(property) !== JSON.stringify(input.company)) return { ...unavailable('conflict'), ...metadata };
    const selected = property ?? input.company;
    if (!selected) return { ...unavailable('missing'), ...metadata };
    return { version: 1, status: 'approved' as const, propertyId, ...metadata, guidance: selected };
  } catch { return unavailable('invalid'); }
}

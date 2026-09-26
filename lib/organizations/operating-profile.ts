/**
 * What business a workspace runs: its operating profile.
 *
 * Two independent axes, each a multi-select, because a real operator is rarely
 * one thing. A third-party manager with an HOA book and two commercial
 * buildings is property management + association management across
 * multifamily, association and commercial assets — and a single "customer
 * type" menu could not say so. A mixed portfolio is not a category of its
 * own; it is any profile with more than one entry.
 *
 * The taxonomy is data. Adding a business model or an asset class is one entry
 * here: the settings UI renders from these lists, profiles store ids, and
 * domain eligibility (lib/agents/organization/domains.ts) is written as rules
 * over ids, so nothing else has to change. Unknown ids in a stored profile are
 * dropped on read rather than trusted, so retiring an entry cannot break a
 * workspace.
 *
 * No storage imports; lib/organizations/operating-profile-store.ts reads and
 * writes it.
 */

export interface TaxonomyEntry {
  id: string;
  label: string;
  description: string;
}

export const BUSINESS_MODELS: readonly TaxonomyEntry[] = [
  { id: "property_management", label: "Property management", description: "Manages properties on behalf of third-party owners or clients." },
  { id: "owner_operator", label: "Owner / operator", description: "Owns and operates its own portfolio." },
  { id: "brokerage_leasing", label: "Brokerage & leasing", description: "Markets and leases space, or represents tenants or landlords, without running the buildings." },
  { id: "real_estate_corporate", label: "Corporate real estate", description: "Runs real estate a company occupies or holds for its own operations." },
  { id: "association_management", label: "Association management", description: "Manages homeowner, condominium or community associations." },
  { id: "asset_management", label: "Asset & investment management", description: "Manages real-estate assets or funds for investors, with operations beneath it." },
];

export const ASSET_CLASSES: readonly TaxonomyEntry[] = [
  { id: "multifamily", label: "Multifamily", description: "Apartment buildings and communities." },
  { id: "single_family", label: "Single-family rentals", description: "Houses and small scattered-site rentals." },
  { id: "commercial", label: "Commercial", description: "Office, retail, industrial and other commercial space." },
  { id: "affordable", label: "Affordable & subsidized", description: "Program-regulated housing: vouchers, tax credit, public housing." },
  { id: "student", label: "Student housing", description: "Housing let by the bed or to students." },
  { id: "association", label: "Associations / HOA", description: "Owner-held communities run by a board." },
  { id: "mixed_use", label: "Mixed-use", description: "Buildings combining residential and commercial space." },
];

export interface OperatingProfile {
  businessModels: string[];
  assetClasses: string[];
  /** Bumped whenever the profile is saved, so routing decisions can say which profile they used. */
  version: number;
}

export const EMPTY_PROFILE: OperatingProfile = { businessModels: [], assetClasses: [], version: 0 };

const MODEL_IDS = new Set(BUSINESS_MODELS.map((entry) => entry.id));
const ASSET_IDS = new Set(ASSET_CLASSES.map((entry) => entry.id));

/** A profile from anything: stored JSON, a request body. Unknown ids are dropped, never trusted. */
export function normalizeProfile(value: unknown): OperatingProfile {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pick = (raw: unknown, known: ReadonlySet<string>) =>
    Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && known.has(id)))].sort() : [];
  const version = typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 0 ? record.version : 0;
  return { businessModels: pick(record.businessModels, MODEL_IDS), assetClasses: pick(record.assetClasses, ASSET_IDS), version };
}

/** A profile that says nothing yet. Routing treats it as "every domain", which is what happened before profiles existed. */
export function isUnset(profile: OperatingProfile): boolean {
  return profile.businessModels.length === 0 && profile.assetClasses.length === 0;
}

export function isMixedPortfolio(profile: OperatingProfile): boolean {
  return profile.businessModels.length > 1 || profile.assetClasses.length > 1;
}

/**
 * When a domain applies, as a rule over the two axes.
 *
 * `models` and `assets` each list ids any one of which suffices; an absent list
 * places no constraint on that axis. `match: "all"` (the default) needs every
 * constrained axis to pass; `match: "any"` needs one — which is how the HOA
 * domain applies to an association manager *or* to anyone holding association
 * assets.
 *
 * Silence never excludes. An axis the workspace left empty passes: saying only
 * "we are property managers" does not mean "we hold no multifamily".
 */
export interface EligibilityRule {
  models?: readonly string[];
  assets?: readonly string[];
  match?: "all" | "any";
}

export function ruleApplies(rule: EligibilityRule, profile: OperatingProfile): boolean {
  const axes: boolean[] = [];
  if (rule.models) axes.push(profile.businessModels.length === 0 || rule.models.some((id) => profile.businessModels.includes(id)));
  if (rule.assets) axes.push(profile.assetClasses.length === 0 || rule.assets.some((id) => profile.assetClasses.includes(id)));
  if (axes.length === 0) return true;
  return rule.match === "any" ? axes.some(Boolean) : axes.every(Boolean);
}

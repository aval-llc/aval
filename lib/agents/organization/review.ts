/**
 * The Specialist catalogue is model-drafted text. This module says what kind
 * of text each part is, and which parts need a person qualified to review them
 * before anyone relies on them.
 *
 * Four kinds, kept apart so none is mistaken for another:
 *
 *   routing metadata      name, triggers, nearest sibling — how work finds the
 *                         Specialist; wrong here means a misroute, never a
 *                         wrong action
 *   capability definition capabilities, inputs, outputs, completion contract,
 *                         execution model — what the product does; enforced by
 *                         code (tools, checks), not by the text
 *   operational guidance  the task boundary — how the work should be done;
 *                         briefing for a model, not a rule anything enforces
 *   legal / compliance    forbidden actions, approvals and any text that
 *   claims                touches regulated ground — the part that must never
 *                         be read as legal policy
 *
 * The authority on what may actually happen is never this text. It is the
 * deterministic layer: permissions (permissions.ts), the approval and financial
 * policies (policy.ts, execution-policy.ts), the PMS capability matrix and the
 * mandatory human checkpoints (lib/pms). A Specialist's briefing says so.
 */

import type { SpecialistDefinition } from "./types.ts";

export type CatalogueField = keyof Pick<SpecialistDefinition,
  "name" | "triggers" | "notThis" | "capabilities" | "inputs" | "outputs" | "completion" | "execution" | "boundary" | "forbidden" | "approvals" | "collaborators">;

export const FIELD_KIND: Record<CatalogueField, "routing" | "capability" | "guidance" | "legal"> = {
  name: "routing", triggers: "routing", notThis: "routing", collaborators: "routing",
  capabilities: "capability", inputs: "capability", outputs: "capability", completion: "capability", execution: "capability",
  boundary: "guidance",
  forbidden: "legal", approvals: "legal",
};

/**
 * Regulated ground, by review area. Text matching any of these needs review by
 * someone qualified in that area before it is relied on — for this workspace's
 * jurisdiction, not in general.
 */
const REGULATED: Record<string, RegExp> = {
  "fair housing": /\b(fair housing|protected (trait|class|characteristic)|steer|disparate|familial status|source of income)\b/i,
  "tenant screening / FCRA": /\b(fcra|adverse action|consumer report|credit report|screening criteria|criminal (history|screening)|background check)\b/i,
  "reasonable accommodation / disability": /\b(accommodation|disabilit|assistance animal|service animal|medical)\b/i,
  "notices, eviction and lease law": /\b(notice period|eviction|unlawful detainer|serve[ds]? (a )?notice|cure or quit|pay or quit|lease violation|legal handoff|litigation)\b/i,
  "deposits, fees and rent regulation": /\b(security deposit|deposit (deduction|withholding|return)|late fee|rent (control|stabili[sz]ation|increase limit)|application fee|interest on deposit)\b/i,
  "subsidized and affordable housing": /\b(hud|nspire|voucher|pha|recertification|lihtc|tax credit|utility allowance|subsidy|section 8)\b/i,
  "habitability and life safety": /\b(habitab|life[- ]safety|lead[- ]based paint|carbon monoxide|smoke alarm|gas leak|electrical hazard|mold|asbestos)\b/i,
  "pricing and antitrust": /\b(antitrust|competitor|coordinated pricing|nonpublic pricing|pricing recommendation)\b/i,
  "privacy and data": /\b(privacy|personal data|data (request|subject)|pii|ssn|social security)\b/i,
  "accounting, trust funds and tax": /\b(trust account|1099|w-?9|tax (form|year|reporting)|owner distribution|escrow)\b/i,
  "jurisdiction-specific rules": /\bjurisdiction\b/i,
};

export interface SpecialistReview {
  id: string;
  /** Review areas the text touches, with the words that put it there. */
  legalReview: { area: string; field: CatalogueField; match: string }[];
  /** Always true: every Specialist was drafted by a model and needs domain review. */
  domainReview: true;
}

function textOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textOf);
  return [];
}

/**
 * Domains that are regulated as a whole, so every Specialist in them needs
 * legal review whatever its wording — a keyword scan alone would let
 * "application completeness" through, though it is tenant screening.
 */
const REGULATED_DOMAINS: Partial<Record<SpecialistDefinition["domain"], string>> = {
  screening: "tenant screening / FCRA",
  affordable: "subsidized and affordable housing",
  "lease-admin": "notices, eviction and lease law",
  "risk-compliance": "fair housing",
};

export function reviewSpecialist(specialist: SpecialistDefinition): SpecialistReview {
  const legalReview: SpecialistReview["legalReview"] = [];
  const domainArea = REGULATED_DOMAINS[specialist.domain];
  if (domainArea) legalReview.push({ area: domainArea, field: "boundary", match: `the ${specialist.domain} domain is regulated as a whole` });
  for (const field of Object.keys(FIELD_KIND) as CatalogueField[]) {
    for (const text of textOf(specialist[field])) {
      for (const [area, pattern] of Object.entries(REGULATED)) {
        const match = text.match(pattern);
        if (match && !legalReview.some((row) => row.area === area && row.field === field)) legalReview.push({ area, field, match: match[0] });
      }
    }
  }
  return { id: specialist.id, legalReview, domainReview: true };
}

/** Said to every Specialist, so the model never mistakes its briefing for authority. */
export const BRIEFING_STANDING = "This briefing is Aval's operational guidance for this job. It is not legal advice and not workspace policy: what you may actually do is decided by the workspace's permissions, approval and financial policies, which are enforced whatever this text says. Where this touches law, the rule for this workspace's jurisdiction governs, and a person decides.";

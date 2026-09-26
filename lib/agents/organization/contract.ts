/**
 * Each Specialist's working contract, derived from its definition by rules
 * rather than assigned by hand.
 *
 * Hand-assigning 266 tool lists is how a catalogue ends up with arbitrary
 * grants nobody can explain. Instead:
 *
 *   required    capabilities in the Specialist's own domain's core, plus any
 *               capability that performs an act — the job cannot be done
 *               without them;
 *   optional    context from other domains that improves the work but does
 *               not define it;
 *   approval    classes derived from what each capability does (money,
 *   classes     external communication, provider write, legal notice, fair
 *               housing, access), cross-checked against the registry;
 *   fallback    the nearest sibling for work that belongs next door, and the
 *               Specialist's Lead for anything else;
 *   status      complete, analysis-only, or incomplete — see `readiness`.
 *
 * Tools are never listed here. They are resolved at run time from the
 * capabilities (capabilities.ts), then narrowed by every other layer: the
 * workspace, the employee, resource scope, connections, the PMS capability
 * matrix and certified workflows, customer grants, policy and the person the
 * work runs for (lib/agents/toolset.ts).
 */

import { CAPABILITY_TOOLS, type CanonicalCapability } from "./capabilities.ts";
import { leadForDomain, leadRuntimeId } from "./domains.ts";
import type { DomainId, SpecialistDefinition } from "./types.ts";

/** The entities a domain is about. A capability on one of them is core to that domain's specialists. */
const DOMAIN_CORE: Record<DomainId, readonly string[]> = {
  "leasing-marketing": ["lead", "prospect", "listing", "showing", "application", "marketing", "leasing"],
  "screening": ["screening", "adverse_action", "application"],
  "resident-experience": ["resident", "communication", "accommodation", "maintenance"],
  "renewals": ["renewal", "lease", "resident"],
  "maintenance": ["maintenance", "work_order", "vendor", "inventory", "purchase_order"],
  "turns": ["turn", "work_order", "inspection", "vendor", "key_access"],
  "inspections": ["inspection", "work_order"],
  "finance": ["accounting", "gl", "journal_entry", "bank", "reconciliation", "budget", "financial", "charge", "deposit"],
  "receivables": ["charge", "payment", "ledger", "delinquency", "payment_plan", "collections", "deposit"],
  "spend-vendor": ["vendor", "invoice", "bill", "purchase_order", "payment"],
  "owner-services": ["owner", "client", "financial"],
  "lease-admin": ["lease", "notice", "document", "deposit", "renewal"],
  "risk-compliance": ["risk", "insurance", "compliance", "fair_housing", "incident", "claim", "accommodation"],
  "affordable": ["affordable", "recertification", "voucher", "nspire"],
  "property-operations": ["property", "unit", "occupancy", "key_access", "staff"],
  "portfolio-strategy": ["portfolio", "analytics", "financial"],
  "market-revenue": ["market", "pricing", "analytics", "leasing"],
  "utilities": ["utility", "sustainability"],
  "hoa": ["association", "assessment", "violation", "architectural_request", "board"],
  "commercial": ["commercial", "cam", "lease"],
  "data-integrations": ["integration", "provenance", "data", "report", "analytics", "document", "communication"],
  "people-operations": ["staff", "sop", "task"],
};

/** Verbs that change something, as opposed to reading it or preparing it for a person. */
const ACTS = new Set(["create", "update", "close", "send", "call", "schedule", "dispatch", "publish", "post", "execute", "request", "intake"]);
/** Verbs whose output is a proposal handed to a person, which needs no executor of its own. */
const PROPOSES = new Set(["prepare", "review", "recommend", "draft"]);

export type ApprovalClass = "money" | "external_communication" | "provider_write" | "legal_notice" | "fair_housing" | "access";

function namespace(capability: string): string { return capability.split(".")[0]; }
function verb(capability: string): string { return capability.split(".").at(-1) ?? ""; }

export function isAct(capability: string): boolean { return ACTS.has(verb(capability)); }

/** The approval class a capability falls into, or null when it needs none beyond the tool's own policy. */
export function approvalClassOf(capability: string): ApprovalClass | null {
  const ns = namespace(capability);
  if (capability === "owner.distribution.prepare" || capability === "owner.contribution.prepare") return "money";
  if (["payment", "payment_plan", "charge", "journal_entry", "invoice", "bill", "collections", "deposit"].includes(ns) && (isAct(capability) || PROPOSES.has(verb(capability)))) return "money";
  if (capability === "communication.send" || capability === "communication.call" || capability === "resident.message.send" || capability === "prospect.message.prepare") return "external_communication";
  if (["notice.prepare", "lease.draft", "lease.execute", "violation.prepare"].includes(capability)) return "legal_notice";
  if (["screening", "adverse_action", "accommodation", "fair_housing"].includes(ns)) return "fair_housing";
  if (ns === "key_access") return "access";
  if (isAct(capability)) return "provider_write";
  return null;
}

export type Readiness = "complete" | "analysis_only" | "incomplete";

export interface SpecialistContract {
  id: string;
  required: CanonicalCapability[];
  optional: CanonicalCapability[];
  approvalClasses: ApprovalClass[];
  /** Work that belongs next door goes to the nearest sibling; anything else to the Lead. */
  fallback: { sibling: string; lead: string };
  /** Required capabilities with no executor today. */
  missing: CanonicalCapability[];
  /**
   * `complete` — every required capability has a tool.
   * `analysis_only` — nothing required is missing except proposals a person
   *   acts on (prepare, review, recommend, draft): the Specialist's product is
   *   analysis or a draft, which needs no executor of its own.
   * `incomplete` — a required read or act has no tool yet.
   */
  readiness: Readiness;
}

export function specialistContract(specialist: SpecialistDefinition): SpecialistContract {
  const core = new Set(DOMAIN_CORE[specialist.domain]);
  const inCore = (capability: string) => core.has(namespace(capability));
  const anyCore = specialist.capabilities.some(inCore);
  // A specialist whose capabilities are all outside its domain's core is
  // cross-cutting by design: everything it declares is what it needs.
  const context = new Set<string>(specialist.contextOnly ?? []);
  const required = specialist.capabilities.filter((capability) => !context.has(capability) && (!anyCore || inCore(capability) || isAct(capability)));
  const optional = specialist.capabilities.filter((capability) => !required.includes(capability));
  const untooled = required.filter((capability) => !CAPABILITY_TOOLS[capability]?.length);
  const missing = untooled.filter((capability) => !PROPOSES.has(verb(capability)));
  const readiness: Readiness = untooled.length === 0 ? "complete" : missing.length === 0 ? "analysis_only" : "incomplete";
  const approvalClasses = [...new Set(specialist.capabilities.map(approvalClassOf).filter((value): value is ApprovalClass => value !== null))];
  return {
    id: specialist.id,
    required, optional, approvalClasses,
    fallback: { sibling: specialist.notThis.specialist, lead: leadRuntimeId(leadForDomain(specialist.domain)) },
    missing, readiness,
  };
}

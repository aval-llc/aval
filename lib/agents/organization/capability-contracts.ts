/**
 * The contract of every canonical capability that some Specialist requires
 * and no implemented tool delivers yet, grouped by business domain.
 *
 *   canonical capability → deterministic contract → risk class
 *     → provider implementations → verification → evidence
 *
 * A gap is closed by building one of its `sources`, never by widening a
 * Specialist's prompt. When a source is built and a tool maps the capability
 * (capabilities.ts), the capability leaves this list: a test holds the list to
 * exactly the capabilities still missing, so it can neither go stale nor hide
 * a gap.
 *
 * `status` on a source is what exists in this repository, not what a vendor
 * advertises. `not_built` means Aval has no adapter; `planned` means the
 * adapter's shape is decided here but no code exists. Nothing here is
 * provider-validated.
 *
 * Classes are the requirement audit's (docs/aval/SPECIALIST_REQUIREMENT_AUDIT.md):
 * B — Aval has no record for it; C — a record or provider action exists, but no
 * execution path does.
 */

import type { CanonicalCapability } from "./capabilities.ts";
import type { ApprovalClass } from "./contract.ts";

export const CAPABILITY_GROUPS = [
  "Leasing", "Screening", "Resident operations", "Inspections", "Finance", "Vendor operations",
  "Compliance & risk", "Affordable housing", "Property operations", "Market", "Utilities",
  "Associations", "Commercial", "People operations",
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export interface CapabilitySource {
  kind: "native" | "pms" | "external";
  /** The native table, the PmsAction, or the class of external provider. */
  name: string;
  status: "not_built" | "planned";
}

export interface CapabilityContract {
  capability: CanonicalCapability;
  group: CapabilityGroup;
  gap: "B" | "C";
  /** The deterministic contract: what the read returns, or what the act changes. */
  returns: string;
  /** `read` for a read; otherwise the approval class its act falls into (contract.ts `approvalClassOf`). */
  risk: "read" | ApprovalClass;
  sources: readonly CapabilitySource[];
  /** How a result is checked before anything downstream relies on it. */
  verification: string;
  /** What the result carries so a Lead, a reviewer or an auditor can trace it. */
  evidence: string;
  /** What has to happen first, stated plainly. */
  blockedOn: string;
}

const PROVENANCE = "source system, record id and retrieval time per row";

export const CAPABILITY_CONTRACTS: readonly CapabilityContract[] = [
  /* ── Leasing ─────────────────────────────────────────────────────────── */
  {
    capability: "application.read", group: "Leasing", gap: "C",
    returns: "Applications for a unit or lead: applicant ids, household size, stage, submitted date, fee status, attached document ids. No screening results (those are screening.read).",
    risk: "read",
    sources: [{ kind: "pms", name: "leasing.applications.read", status: "not_built" }, { kind: "native", name: "applications (no table)", status: "not_built" }],
    verification: "Row counts reconcile with the provider's application list for the same window.",
    evidence: PROVENANCE,
    blockedOn: "A PMS read executor: the action is in the matrix and DoorLoop probes it, but reads today come only from synced native tables and there is no application table.",
  },
  {
    capability: "lead.update", group: "Leasing", gap: "C",
    returns: "Changes one lead's stage, owner, next step or lost reason; returns the lead before and after.",
    risk: "provider_write",
    sources: [{ kind: "native", name: "leasing_leads (source_provider = manual)", status: "planned" }, { kind: "pms", name: "none in the matrix", status: "not_built" }],
    verification: "Re-read after write; refused when the lead is owned by a sync, which would overwrite it.",
    evidence: "the before/after row, the Work and step that wrote it",
    blockedOn: "A decision on source of truth: a native write is safe only for leads no PMS or ILS sync owns.",
  },
  {
    capability: "lead.create", group: "Leasing", gap: "C",
    returns: "Creates one lead from an inquiry with channel, unit type and first-contact date; idempotent on the inquiry's message id.",
    risk: "provider_write",
    sources: [{ kind: "native", name: "leasing_leads", status: "planned" }],
    verification: "Duplicate inquiry (same message id) returns the existing lead.",
    evidence: "the created row and the originating conversation id",
    blockedOn: "Same source-of-truth decision as lead.update.",
  },
  {
    capability: "showing.read", group: "Leasing", gap: "C",
    returns: "Scheduled and past showings: lead, unit, time, kind (agent-led or self-guided), outcome.",
    risk: "read",
    sources: [{ kind: "pms", name: "leasing.viewings.read (not in the matrix)", status: "not_built" }],
    verification: "A showing booked through book_viewing appears in the next read.",
    evidence: PROVENANCE,
    blockedOn: "A viewing read action in the PMS matrix; today only the write (leasing.viewing.book) exists, and leads carry toured_at only.",
  },

  /* ── Screening ───────────────────────────────────────────────────────── */
  {
    capability: "screening.read", group: "Screening", gap: "B",
    returns: "Screening results per applicant and product (identity, credit, eviction, criminal, income): result, date, provider reference. Raw report text never enters model context.",
    risk: "fair_housing",
    sources: [{ kind: "external", name: "consumer reporting agency", status: "not_built" }],
    verification: "Result is bound to the applicant and the consent record it was ordered under.",
    evidence: "provider report reference, product, ordered-under consent id",
    blockedOn: "A screening provider agreement and an FCRA-scoped record; counsel review of what may enter a model's context.",
  },
  {
    capability: "screening.request", group: "Screening", gap: "B",
    returns: "Orders one screening product for one applicant; returns the order reference. One order per applicant per product.",
    risk: "fair_housing",
    sources: [{ kind: "external", name: "consumer reporting agency", status: "not_built" }],
    verification: "Refused without a recorded applicant consent and permissible purpose; idempotent per applicant and product.",
    evidence: "consent record, criteria version, order reference, fee charged",
    blockedOn: "As screening.read.",
  },

  /* ── Resident operations ─────────────────────────────────────────────── */
  {
    capability: "accommodation.intake", group: "Resident operations", gap: "B",
    returns: "Records a reasonable-accommodation or modification request: who, what was asked, date received, channel. Never a decision.",
    risk: "fair_housing",
    sources: [{ kind: "native", name: "accommodation_requests (no table)", status: "not_built" }],
    verification: "The received date is the message's, not the recording time.",
    evidence: "originating message id and received timestamp",
    blockedOn: "The record itself, and counsel review of its retention and access rules.",
  },
  {
    capability: "accommodation.read", group: "Resident operations", gap: "B",
    returns: "Accommodation requests with status, interactive-process steps and deadlines. Health details are never returned.",
    risk: "fair_housing",
    sources: [{ kind: "native", name: "accommodation_requests (no table)", status: "not_built" }],
    verification: "Access limited to the people the workspace names for accommodations.",
    evidence: "request id and step history",
    blockedOn: "As accommodation.intake.",
  },

  /* ── Inspections ─────────────────────────────────────────────────────── */
  {
    capability: "inspection.read", group: "Inspections", gap: "B",
    returns: "Inspections per unit or property: kind (move-in, move-out, periodic, life-safety, NSPIRE and other program standards), date, inspector, items with condition and photo/document ids, deficiencies.",
    risk: "read",
    sources: [{ kind: "native", name: "inspections (no table)", status: "not_built" }, { kind: "external", name: "inspection app", status: "not_built" }, { kind: "pms", name: "none in the matrix", status: "not_built" }],
    verification: "Each deficiency links to the inspection item it came from.",
    evidence: PROVENANCE,
    blockedOn: "An inspection record; the largest single gap (15 Specialists across Turns, Inspections, Affordable and Portfolio strategy).",
  },

  /* ── Finance ─────────────────────────────────────────────────────────── */
  {
    capability: "bank.read", group: "Finance", gap: "B",
    returns: "Bank statement lines per account and period: date, amount, description, cleared status, running balance.",
    risk: "read",
    sources: [{ kind: "external", name: "bank feed aggregator", status: "not_built" }, { kind: "native", name: "uploaded statement", status: "not_built" }],
    verification: "Statement opening + lines = closing balance, checked before use.",
    evidence: "account (masked), statement period, line references",
    blockedOn: "A bank-feed provider or a statement import; gl_transactions is the book side only.",
  },
  {
    capability: "budget.read", group: "Finance", gap: "B",
    returns: "Approved budget by GL account, property and period, with the version that was approved.",
    risk: "read",
    sources: [{ kind: "native", name: "budgets (no table)", status: "not_built" }, { kind: "pms", name: "none in the matrix", status: "not_built" }],
    verification: "Budget accounts resolve to gl_accounts; totals per period stated.",
    evidence: "budget version and approval date",
    blockedOn: "A budget record and an import path.",
  },

  /* ── Vendor operations ───────────────────────────────────────────────── */
  {
    capability: "invoice.read", group: "Vendor operations", gap: "B",
    returns: "Vendor payables (invoices and bills are one record): vendor, number, date, due, amount, GL coding, linked work order or PO, approval and payment status.",
    risk: "read",
    sources: [{ kind: "native", name: "payables (no table)", status: "not_built" }, { kind: "pms", name: "none in the matrix", status: "not_built" }],
    verification: "Duplicate check on vendor + invoice number + amount.",
    evidence: PROVENANCE,
    blockedOn: "An accounts-payable record; vendorEstimate documents are quotes, not payables.",
  },
  {
    capability: "inventory.read", group: "Vendor operations", gap: "B",
    returns: "Parts on hand by location: item, quantity, reorder point.",
    risk: "read",
    sources: [{ kind: "native", name: "inventory (no table)", status: "not_built" }],
    verification: "Quantities never negative; a count date is stated.",
    evidence: "last count date per item",
    blockedOn: "An inventory record; many operators keep none, so it may stay optional in practice.",
  },

  /* ── Compliance & risk ───────────────────────────────────────────────── */
  {
    capability: "compliance.read", group: "Compliance & risk", gap: "B",
    returns: "The compliance register for a property: jurisdiction, protected classes beyond federal, screening limits, disclosure duties, notice periods and filing deadlines, each with its source and review date.",
    risk: "read",
    sources: [{ kind: "native", name: "compliance register (no table)", status: "not_built" }],
    verification: "Every rule carries a citation and a reviewed-by; an unreviewed rule is returned as unreviewed.",
    evidence: "rule citation, jurisdiction, reviewed-by and date",
    blockedOn: "The register and a qualified reviewer for its content. Aval must not author legal rules itself.",
  },
  {
    capability: "insurance.read", group: "Compliance & risk", gap: "B",
    returns: "Resident renters and property policies: holder, carrier, coverage, limits, effective and expiry dates, additional-insured status. Vendor certificates stay on vendor.insurance.read.",
    risk: "read",
    sources: [{ kind: "native", name: "insurance_policies (no table)", status: "not_built" }, { kind: "external", name: "renters-insurance tracking provider", status: "not_built" }],
    verification: "Expiry compared against today, with the date stated.",
    evidence: "policy document id",
    blockedOn: "A policy record.",
  },
  {
    capability: "incident.read", group: "Compliance & risk", gap: "B",
    returns: "Incidents: what, where, when, who was involved, reported by, claim status. Injury and health details restricted.",
    risk: "read",
    sources: [{ kind: "native", name: "incidents (no table)", status: "not_built" }],
    verification: "Access limited to the people the workspace names for risk.",
    evidence: "incident id and report timestamps",
    blockedOn: "An incident record.",
  },

  /* ── Affordable housing ──────────────────────────────────────────────── */
  {
    capability: "affordable.read", group: "Affordable housing", gap: "B",
    returns: "Program households: program, set-aside, certification dates, certified income and assets, subsidy (voucher, HAP contract, tenant and subsidy portions), utility allowance.",
    risk: "read",
    sources: [{ kind: "pms", name: "none in the matrix (affordable modules)", status: "not_built" }, { kind: "native", name: "affordable_households (no table)", status: "not_built" }],
    verification: "Certification dates reconcile with the program's recertification schedule.",
    evidence: PROVENANCE,
    blockedOn: "A provider affordable-module read; no connected PMS path exposes one today.",
  },

  /* ── Property operations ─────────────────────────────────────────────── */
  {
    capability: "key_access.read", group: "Property operations", gap: "B",
    returns: "Keys, fobs, codes and lockboxes per unit: holder, issued, returned, last changed. Codes themselves are never returned.",
    risk: "access",
    sources: [{ kind: "native", name: "key_access (no table)", status: "not_built" }, { kind: "external", name: "smart-lock provider", status: "not_built" }],
    verification: "Every issued item has a holder; a turn is not ready while one is unreturned.",
    evidence: "item id and custody history",
    blockedOn: "A custody record.",
  },

  /* ── Market ──────────────────────────────────────────────────────────── */
  {
    capability: "market.public.read", group: "Market", gap: "C",
    returns: "Public or lawfully licensed submarket statistics: occupancy, asking rent, concessions, supply, each with source, date and definition.",
    risk: "read",
    sources: [{ kind: "external", name: "licensed market-data provider", status: "not_built" }],
    verification: "Every figure dated and sourced; nonpublic competitor data is refused (antitrust).",
    evidence: "source, publication date, definition",
    blockedOn: "A provider licence. No market data is connected; the product says so today.",
  },
  {
    capability: "market.comparables.read", group: "Market", gap: "C",
    returns: "A comparable set: properties, unit types, asking rents and concessions from public listings, with capture dates.",
    risk: "read",
    sources: [{ kind: "external", name: "public listing data provider", status: "not_built" }],
    verification: "Only publicly advertised terms; no competitor-shared or pooled nonpublic data.",
    evidence: "listing reference and capture date",
    blockedOn: "As market.public.read.",
  },

  /* ── Utilities ───────────────────────────────────────────────────────── */
  {
    capability: "sustainability.read", group: "Utilities", gap: "C",
    returns: "Benchmark scores, emission factors and reporting-framework submissions for a property.",
    risk: "read",
    sources: [{ kind: "external", name: "benchmarking service", status: "not_built" }],
    verification: "Coverage and estimation stated per metric.",
    evidence: "benchmark reference and period",
    blockedOn: "A benchmarking provider connection. Usage itself is already read from utility bills.",
  },

  /* ── Associations ────────────────────────────────────────────────────── */
  {
    capability: "association.read", group: "Associations", gap: "B",
    returns: "Associations, members and their units, assessment schedule and each member's assessment account, board members and governing-document ids.",
    risk: "read",
    sources: [{ kind: "pms", name: "none in the matrix (association modules)", status: "not_built" }, { kind: "native", name: "associations (no table)", status: "not_built" }],
    verification: "Member balances reconcile with the assessment ledger.",
    evidence: PROVENANCE,
    blockedOn: "An association record or provider read.",
  },

  /* ── Commercial ──────────────────────────────────────────────────────── */
  {
    capability: "commercial.read", group: "Commercial", gap: "B",
    returns: "Commercial lease terms: premises, rentable area and pro-rata share, base rent schedule, escalations, recovery (CAM, tax, insurance) terms, caps, options and critical dates.",
    risk: "read",
    sources: [{ kind: "native", name: "commercial_lease_terms (no table)", status: "not_built" }, { kind: "pms", name: "none in the matrix", status: "not_built" }],
    verification: "Pro-rata shares across a building sum to at most 100%.",
    evidence: "lease document id and clause references",
    blockedOn: "A commercial terms record; abstracts can be prepared from lease documents meanwhile.",
  },

  /* ── People operations ───────────────────────────────────────────────── */
  {
    capability: "task.read", group: "People operations", gap: "B",
    returns: "Human work items: assignee, status, effort, age, SLA, acceptance.",
    risk: "read",
    sources: [{ kind: "native", name: "human work items (no table)", status: "not_built" }],
    verification: "Each item has one current assignee.",
    evidence: "item id and assignment history",
    blockedOn: "A human assignment model. Aval routes agent Work by delegation; people have no queue.",
  },
  {
    capability: "task.route", group: "People operations", gap: "B",
    returns: "Assigns or reassigns one human work item to a person or team; returns the assignment.",
    risk: "provider_write",
    sources: [{ kind: "native", name: "human work items (no table)", status: "not_built" }],
    verification: "The assignee holds the authority the item needs; unaccepted items escalate on a timer.",
    evidence: "assignment record and the rule that chose the assignee",
    blockedOn: "As task.read.",
  },
  {
    capability: "staff.schedule.read", group: "People operations", gap: "B",
    returns: "On-call rotations per property and emergency category: primary, backup, escalation ladder, coverage gaps.",
    risk: "read",
    sources: [{ kind: "native", name: "on-call rotations (no table)", status: "not_built" }],
    verification: "Every hour of every rotation has a primary.",
    evidence: "rotation version",
    blockedOn: "An on-call record. Communication team routes (get_communication_channels) name who answers, not when.",
  },
];

export function capabilityContract(capability: string): CapabilityContract | undefined {
  return CAPABILITY_CONTRACTS.find((contract) => contract.capability === capability);
}

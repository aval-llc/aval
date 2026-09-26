#!/usr/bin/env node
/**
 * Classifies every missing requirement of every incomplete Specialist, and
 * writes docs/aval/SPECIALIST_REQUIREMENT_AUDIT.md.
 *
 * The classification is a point-in-time audit of the catalogue as it stood at
 * commit 7d529fb (138 incomplete Specialists, 189 missing pairs). It is the
 * input to normalization, not a rule the runtime reads: once a wrong mapping is
 * fixed, the pair it classified disappears from the contracts. Run it against
 * a checkout of 7d529fb to reproduce the published matrix.
 *
 *   A  EXISTING_CAPABILITY_WRONG_MAPPING   an existing capability already meets the need
 *   B  NEW_CANONICAL_CAPABILITY_REQUIRED   Aval has no reusable capability for it
 *   C  PROVIDER_WORKFLOW_REQUIRED          canonical, with a data source, but no execution path
 *   D  ANALYSIS_ONLY_BY_DESIGN             the Specialist must not execute this
 *   E  APPROVAL_ONLY / DECISION_SUPPORT    the Specialist prepares; an authorized person acts
 *   F  DUPLICATE_OR_OVERLAPPING_EXPERTISE  owned by another capability or Specialist
 *   G  INVALID_REQUIREMENT                 the Specialist's own boundary does not need it
 *
 *   node scripts/specialist-requirement-audit.mjs
 */
import { writeFileSync } from "node:fs";
import { LEADS, specialistsForDomain } from "../lib/agents/organization/index.ts";
import { specialistContract } from "../lib/agents/organization/contract.ts";

const CLASS_NAMES = {
  A: "EXISTING_CAPABILITY_WRONG_MAPPING",
  B: "NEW_CANONICAL_CAPABILITY_REQUIRED",
  C: "PROVIDER_WORKFLOW_REQUIRED",
  D: "ANALYSIS_ONLY_BY_DESIGN",
  E: "APPROVAL_ONLY / DECISION_SUPPORT",
  F: "DUPLICATE_OR_OVERLAPPING_EXPERTISE",
  G: "INVALID_REQUIREMENT",
};

/** The default class of a missing capability, the evidence for it, and what normalization does. */
const BY_CAPABILITY = {
  "application.read": ["C", "PMS action `leasing.applications.read` is in the matrix (lib/pms/types.ts) and DoorLoop probes it; no read executor and no native application record.", "provider read adapter"],
  "screening.read": ["B", "No screening-result entity anywhere; results come from a consumer reporting agency.", "define `screening.read` contract (FCRA-scoped)"],
  "screening.request": ["F", "Ordering a report is one act per applicant (consent, permissible purpose, fee). Credit Screening Coordination owns it; verifiers read results.", "remove; read `screening.read`, collaborate with screening.credit-screening-coordination"],
  "lead.create": ["C", "Native `leasing_leads` exists and `get_leads` reads it; no write path, native or PMS.", "native lead write adapter (sync-owned leads refused)"],
  "lead.update": ["C", "Native `leasing_leads` exists and `get_leads` reads it; no write path, native or PMS.", "native lead write adapter (sync-owned leads refused)"],
  "showing.read": ["C", "`book_viewing` writes through `leasing.viewing.book`; there is no viewing read in the PMS matrix and `get_leads` carries only `toured_at`.", "provider viewing read"],
  "accommodation.intake": ["B", "No accommodation-request record; the date received and the interactive process are legally material.", "define accommodation request record"],
  "accommodation.read": ["B", "No accommodation-request record.", "define accommodation request record"],
  "inventory.read": ["B", "No parts inventory entity or provider read.", "define `inventory.read` contract"],
  "turn.read": ["B", "No turn entity; derivable from leases (move-outs), units (vacancy, ready) and work orders already in Aval.", "build native derived read"],
  "inspection.read": ["B", "No inspection record; reports are not a document kind either.", "define inspection record contract"],
  "key_access.read": ["B", "No key, fob or lockbox inventory.", "define `key_access.read` contract"],
  "bank.read": ["B", "No bank statement or feed; `gl_transactions` holds the book side only.", "define bank statement contract"],
  "budget.read": ["B", "No budget entity; `planning_items` are not budgets.", "define budget contract"],
  "invoice.read": ["B", "No accounts-payable record; `vendorEstimate` documents are quotes, not payables.", "define payable (invoice) contract"],
  "bill.read": ["F", "A vendor bill and a vendor invoice are the same payable.", "consolidate into `invoice.read`"],
  "owner.read": ["C", "`ownership_entities` exists, linked from `properties.ownership_entity_id` and `access_grants`; nothing reads it.", "build native owner read"],
  "client.read": ["F", "A management client is the ownership entity; same record as `owner.read`.", "consolidate into `owner.read`"],
  "document.extract": ["A", "Extraction is reading a stored document and quoting it; `read_document` delivers the text and the Specialist returns fields with verbatim quotes (the discipline lib/documents/extraction.ts already applies).", "map to `read_document`"],
  "compliance.read": ["B", "No register of jurisdiction rules, protected classes, deadlines or disclosures; the operating profile carries none.", "define compliance register contract"],
  "insurance.read": ["B", "Only vendor certificates exist (`vendors.insurance_expires_on`); no resident or property policy record.", "define insurance policy contract"],
  "incident.read": ["B", "No incident record.", "define incident record contract"],
  "affordable.read": ["B", "No affordable-program household record (certification, income, subsidy).", "define affordable household contract"],
  "voucher.read": ["F", "A voucher/HAP contract is part of the affordable household's subsidy.", "consolidate into `affordable.read`"],
  "nspire.read": ["F", "NSPIRE is an inspection standard, not a separate record.", "consolidate into `inspection.read` (standard = NSPIRE)"],
  "market.public.read": ["C", "Canonical and used by `pricing.recommend`; no lawful market-data provider is connected (persona catalog says so).", "market data provider"],
  "market.comparables.read": ["C", "Canonical; no lawful comparables provider is connected.", "market data provider"],
  "sustainability.read": ["C", "Benchmarking and emission factors need a provider (e.g. ENERGY STAR Portfolio Manager); none is connected.", "benchmarking provider"],
  "association.read": ["B", "No association, member or assessment record.", "define association contract"],
  "assessment.read": ["F", "Assessments are the association member's account; one record with the association.", "consolidate into `association.read`"],
  "commercial.read": ["B", "No commercial lease-terms record (recoveries, options, CAM share).", "define commercial lease contract"],
  "cam.read": ["F", "A CAM pool is commercial lease recovery terms plus GL expense lines.", "consolidate into `commercial.read` (+ `gl.read`)"],
  "task.route": ["B", "Aval routes agent Work by delegation; it has no human work-item assignee, acceptance or reassignment.", "define human assignment contract"],
  "sop.read": ["A", "SOPs are stored documents; `list_documents`/`read_document` already read them.", "map to document reads"],
};

/** Where one Specialist's use of a capability is classified differently from the default. */
const OVERRIDES = {
  "screening.credit-screening-coordination": { "screening.request": ["B", "The one Specialist that orders reports; no screening provider path exists.", "define `screening.request` contract (consent + permissible purpose)"] },
  "finance.cash-flow-analysis": {
    "bank.read": ["A", "Cash position comes from GL cash accounts; `gl.read` and `financial.statement.read` already cover it.", "demote to optional"],
    "budget.read": ["G", "Its boundary projects from scheduled rent and payables, not a budget; the derivation rule made a domain-core read required.", "demote to optional"],
  },
  "risk-compliance.renters-insurance-compliance": { "compliance.read": ["A", "Whether insurance is required is a lease term; `lease.read` covers it.", "demote to optional"] },
  "risk-compliance.vendor-insurance-compliance": { "insurance.read": ["A", "Vendor certificates already read through `vendor.insurance.read` (`get_vendors`).", "replace with `vendor.insurance.read`"] },
  "utilities.energy-and-water-usage-analysis": { "sustainability.read": ["A", "Its boundary is usage over time and against peers: `utility.read`/`utility.bill.read` already deliver that.", "demote to optional"] },
  "people-operations.workload-balancing": { "task.route": ["E", "Its boundary: proposes reassignments for a manager to accept.", "remove the act; decision support"] },
  "people-operations.on-call-schedule": { "task.route": ["G", "Its boundary stops at a covered schedule and does not route work. Its real need is an on-call rotation record (tracked with the human assignment contract).", "remove"] },
  "people-operations.internal-incident": { "task.route": ["F", "Assigning corrective actions is Staff Task Routing's job.", "remove; collaborate with people-operations.staff-task-routing"] },
};

const rows = [];
const counts = Object.fromEntries(Object.keys(CLASS_NAMES).map((key) => [key, 0]));
const byCapability = {};
for (const lead of LEADS) {
  for (const specialist of specialistsForDomain(lead.domain)) {
    const contract = specialistContract(specialist);
    if (contract.readiness !== "incomplete") continue;
    const pairs = contract.missing.map((capability) => {
      const override = OVERRIDES[specialist.id]?.[capability];
      const [cls, why, action] = override ?? BY_CAPABILITY[capability] ?? [];
      if (!cls) throw new Error(`unclassified: ${specialist.id} ${capability}`);
      counts[cls]++;
      const split = (byCapability[capability] ??= {});
      split[cls] = (split[cls] ?? 0) + 1;
      return { capability, cls, why, action, overridden: Boolean(override) };
    });
    rows.push({ lead: lead.name, specialist, pairs });
  }
}

const pairTotal = Object.values(counts).reduce((a, b) => a + b, 0);
const total = (classes) => Object.values(classes).reduce((a, b) => a + b, 0);
const out = [
  "# Specialist requirement audit",
  "",
  "Generated by `scripts/specialist-requirement-audit.mjs`. Snapshot of the catalogue at commit `7d529fb`, before normalization. Do not edit by hand.",
  "",
  `Every missing requirement of the ${rows.length} incomplete Specialists (${pairTotal} Specialist–capability pairs over ${Object.keys(byCapability).length} distinct capabilities) is classified as exactly one of:`,
  "",
  "| Class | Meaning | Pairs |",
  "|---|---|---|",
  ...Object.entries(CLASS_NAMES).map(([key, name]) => `| ${key} | ${name} | ${counts[key]} |`),
  "",
  "Classes D and E are nearly empty here, and that is a finding rather than a gap: the Specialists whose whole product is analysis or a proposal had already been separated out as the 41 analysis-only Specialists, whose unexecuted capabilities are `prepare`/`review`/`recommend`/`draft`. What remains incomplete is almost entirely missing *reads*: data Aval does not hold (B) or holds without a way to reach it (C).",
  "",
  "## By capability",
  "",
  "| Capability | Pairs | Default class | Evidence | Normalization |",
  "|---|---|---|---|---|",
  ...Object.entries(byCapability).sort((a, b) => total(b[1]) - total(a[1])).map(([capability, classes]) => {
    const [cls, why, action] = BY_CAPABILITY[capability];
    const split = Object.entries(classes).map(([key, n]) => `${key}×${n}`).join(" ");
    return `| \`${capability}\` | ${split} | ${cls} | ${why} | ${action} |`;
  }),
  "",
  "## Per-Specialist matrix",
  "",
  "An asterisk marks a Specialist-specific classification that differs from the capability's default; its reason is given.",
  "",
];
let currentLead = "";
for (const { lead, specialist, pairs } of rows) {
  if (lead !== currentLead) {
    if (currentLead) out.push("");
    currentLead = lead;
    out.push(`### ${lead}`, "", "| Specialist | Missing requirement | Class | Why (overrides) | Normalization |", "|---|---|---|---|---|");
  }
  for (const [index, pair] of pairs.entries()) {
    out.push(`| ${index === 0 ? specialist.name : ""} | \`${pair.capability}\` | ${pair.cls}${pair.overridden ? "*" : ""} | ${pair.overridden ? pair.why : ""} | ${pair.action} |`);
  }
}
writeFileSync(new URL("../docs/aval/SPECIALIST_REQUIREMENT_AUDIT.md", import.meta.url), out.join("\n") + "\n");
console.log({ specialists: rows.length, pairs: pairTotal, ...counts });

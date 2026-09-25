/**
 * The shape of Aval's built-in organization.
 *
 *   Aval One        the global orchestrator behind "Ask Aval"
 *   22 Leads        domain coordinators
 *   266 Specialists bounded, versioned expertise the runtime can instantiate
 *
 * These are platform actors, not customer headcount. A workspace's own AI
 * Employees (lib/agents/employees.ts) own work and may use any of these as
 * expertise; none of them is ever created as an employee row.
 *
 * No storage imports: the definitions are data, testable with `node --test`.
 */

import type { CanonicalCapability } from "./capabilities.ts";

export const DOMAIN_IDS = [
  "leasing-marketing",
  "screening",
  "resident-experience",
  "renewals",
  "maintenance",
  "turns",
  "inspections",
  "finance",
  "receivables",
  "spend-vendor",
  "owner-services",
  "lease-admin",
  "risk-compliance",
  "affordable",
  "property-operations",
  "portfolio-strategy",
  "market-revenue",
  "utilities",
  "hoa",
  "commercial",
  "data-integrations",
  "people-operations",
] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

/**
 * The kinds of business a workspace can run (directive §10). A domain is
 * eligible for routing only where the workspace runs a business it applies to,
 * so a pure HOA manager is never routed into leasing, and a market-rate
 * portfolio is never routed into recertification.
 */
export const CUSTOMER_TYPES = [
  "third_party_residential",
  "multifamily_owner_operator",
  "single_family_rental",
  "commercial",
  "association",
  "affordable",
  "student",
  "mixed_use",
  "asset_manager",
] as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** Internal maturity (directive §32). Never shown raw in customer UI. */
export type Maturity =
  | "DEFINED"
  | "ROUTABLE"
  | "TOOLED"
  | "SIMULATOR_TESTED"
  | "SANDBOX_TESTED"
  | "LIVE_PROVIDER_TESTED"
  | "CUSTOMER_VALIDATED";

/**
 * How a Specialist runs (directive §7): the smallest execution model that is
 * sufficient. `deterministic` never spawns a model — arithmetic, schema checks
 * and policy checks are code. `expertise` is loaded into an existing run.
 * `child_run` is a bounded model-backed run of its own.
 */
export type ExecutionModel = "deterministic" | "expertise" | "child_run";

export interface SpecialistDefinition {
  /** Stable, namespaced: `<domain>.<slug>`. Never reused for different work. */
  id: string;
  name: string;
  domain: DomainId;
  /** What it does and where it stops. One or two sentences, specific enough to route on. */
  boundary: string;
  /**
   * The nearest sibling, and why this is not that. Named so a reviewer can see
   * that two specialists are different jobs rather than one job renamed.
   */
  notThis: { specialist: string; because: string };
  /** Words and events that suggest this specialist. Lower-case. */
  triggers: readonly string[];
  inputs: readonly string[];
  outputs: readonly string[];
  capabilities: readonly CanonicalCapability[];
  execution: ExecutionModel;
  /**
   * The machine-checkable outcome this specialist's work is done at — and, as
   * directive §19 insists, what it is explicitly not done at.
   */
  completion: { doneWhen: string; notDoneWhen: string };
  /** Actions this specialist must never take, whatever it is asked. */
  forbidden: readonly string[];
  /** Actions it may prepare but a person must approve. */
  approvals: readonly string[];
  /** Peer specialists it may legitimately ask for help. Ids, same or other domain. */
  collaborators: readonly string[];
}

export interface LeadDefinition {
  /** `lead.<domain>` for new Leads. */
  id: string;
  domain: DomainId;
  name: string;
  summary: string;
  /**
   * The historical visible agent this Lead promotes, where there is one.
   *
   * The legacy id stays the stable key: tasks, approvals, audit events,
   * deployments and deep links recorded under it keep resolving, and the
   * Lead's authority for that id is exactly the historical envelope.
   */
  legacyPersonaId?: string;
  /** Other domains this Lead may consult. */
  relatedDomains: readonly DomainId[];
  /** Business types this domain applies to. Empty means every type. */
  appliesTo: readonly CustomerType[];
  /** Standing forbidden actions for every specialist in the domain. */
  domainForbidden: readonly string[];
  /** Standing instructions every run in this domain receives. */
  domainInstructions: string;
}

export interface AvalOneDefinition {
  id: "aval-one";
  /** The stable key historical work was recorded under. */
  legacyPersonaId: "general";
  name: "Aval One";
  subtitle: "Global orchestrator";
  summary: string;
}

export type ActorKind = "aval_one" | "lead" | "specialist";

/**
 * The expertise catalogue, and the eight specialists as data.
 *
 * The eight were a union type in source. They are now rows: expertise profiles
 * and starter templates, indistinguishable from anything a customer writes.
 * That is the whole migration — not "the eight plus custom ones", but a
 * catalogue whose first entries happen to be the ones Aval ships.
 *
 * Nothing in the runtime may special-case a slug in this file. If it does, the
 * roster has grown back.
 */

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { aiEmployees, employeeExpertise, expertiseProfiles, expertiseSelections } from "@/db/postgres/schema";
import { createEmployee } from "./employees.ts";
import {
  applyUserSelection,
  routeExpertise,
  type ExpertiseCandidateInput,
  type RoutingDecision,
  type RiskTier,
  type WorkSignals,
} from "./expertise-routing.ts";

export interface ExpertiseProfileSeed {
  slug: string;
  name: string;
  description: string;
  capabilityTags: string[];
  domains: string[];
  routingSignals: string[];
  requiredCapabilities: string[];
  riskCeiling: RiskTier;
  instructions: string;
}

/**
 * What Aval ships.
 *
 * Derived from the eight specialists' prompt additions and tool subsets, but
 * carrying no privilege: a workspace may disable any of them, shadow one with
 * its own, or ignore the lot and write its own catalogue.
 */
export const SHIPPED_EXPERTISE: readonly ExpertiseProfileSeed[] = [
  {
    slug: "financial-analysis",
    name: "Financial analysis",
    description: "Portfolio economics: operating statements, delinquency, accounting breakdowns.",
    capabilityTags: ["financial"],
    domains: ["financial"],
    routingSignals: ["noi", "ledger", "arrears", "delinquent", "operating", "statement", "budget", "variance"],
    requiredCapabilities: [],
    riskCeiling: "medium",
    instructions: "Reason from posted figures only. Name the period and the source of every number, and say plainly when a figure is unavailable rather than estimating it.",
  },
  {
    slug: "brokerage-leasing",
    name: "Brokerage and leasing",
    description: "Leasing funnel, velocity, and conversion across the portfolio.",
    capabilityTags: ["leasing"],
    domains: ["leasing"],
    routingSignals: ["leasing", "vacancy", "funnel", "tour", "application", "conversion", "lead"],
    requiredCapabilities: [],
    riskCeiling: "medium",
    instructions: "Distinguish inquiries from tours and tours from applications. A funnel figure without its stage is not an answer.",
  },
  {
    slug: "real-estate",
    name: "Real estate",
    description: "Property and unit composition, ownership structure, portfolio shape.",
    capabilityTags: ["property"],
    domains: ["property"],
    routingSignals: ["property", "unit", "portfolio", "building", "square", "footage"],
    requiredCapabilities: [],
    riskCeiling: "low",
    instructions: "Be precise about what is a property, a unit and a lease; conflating them produces figures that look right and are not.",
  },
  {
    slug: "market-research",
    name: "Market research",
    description: "Comparables, rent positioning and local market context.",
    capabilityTags: ["market"],
    domains: ["market"],
    routingSignals: ["market", "comparable", "comp", "benchmark", "submarket"],
    requiredCapabilities: [],
    riskCeiling: "low",
    instructions: "Separate what the portfolio's own records show from anything asserted about the wider market, and never present the second as the first.",
  },
  {
    slug: "maintenance",
    name: "Maintenance",
    description: "Work orders, repairs, vendor execution and completion evidence.",
    capabilityTags: ["maintenance"],
    domains: ["maintenance"],
    routingSignals: ["repair", "leak", "hvac", "work_order", "maintenance_request", "broken", "outage", "plumbing"],
    requiredCapabilities: [],
    riskCeiling: "high",
    instructions: "A work order accepted by a provider is not a repair completed. Track the objective through to evidence that the condition is actually resolved.",
  },
  {
    slug: "risk-analysis",
    name: "Risk analysis",
    description: "Exposure, concentration and what could go wrong across the portfolio.",
    capabilityTags: ["risk"],
    domains: ["financial", "property"],
    routingSignals: ["risk", "exposure", "concentration", "insurance", "liability", "compliance"],
    requiredCapabilities: [],
    riskCeiling: "medium",
    instructions: "Quantify exposure where the records allow and state the unquantified residue explicitly. An unmentioned risk reads as an absent one.",
  },
  {
    slug: "portfolio-outlook",
    name: "Portfolio outlook",
    description: "Trend and trajectory across the portfolio over time.",
    capabilityTags: ["financial", "property"],
    domains: ["financial", "property"],
    routingSignals: ["trend", "outlook", "forecast", "trajectory", "quarter"],
    requiredCapabilities: [],
    riskCeiling: "low",
    instructions: "Distinguish what the series shows from what it implies, and give the window every trend is measured over.",
  },
  {
    slug: "lease-review",
    name: "Lease review",
    description: "Lease terms, renewals, occupancy and obligations.",
    capabilityTags: ["leasing"],
    domains: ["leasing"],
    routingSignals: ["lease", "renewal", "term", "expiry", "occupant", "clause"],
    requiredCapabilities: [],
    riskCeiling: "medium",
    instructions: "Quote the lease rather than summarising it when the answer turns on wording, and name the document every term comes from.",
  },
  {
    slug: "resident-experience",
    name: "Resident experience",
    description: "Resident communication, expectations and follow-through until an issue is resolved.",
    capabilityTags: ["resident"],
    domains: ["resident"],
    routingSignals: ["resident", "tenant", "complaint", "request", "unhappy"],
    requiredCapabilities: [],
    riskCeiling: "medium",
    instructions: "Keep the resident informed of what will happen and when. Silence between updates is itself an outcome the resident experiences.",
  },
  {
    slug: "vendor-coordination",
    name: "Vendor coordination",
    description: "Scheduling, dispatching and chasing third parties to completion.",
    capabilityTags: ["vendor"],
    domains: ["vendor", "maintenance"],
    routingSignals: ["vendor", "contractor", "dispatch", "schedule", "appointment", "technician"],
    requiredCapabilities: [],
    riskCeiling: "high",
    instructions: "A vendor accepting a job is not a job done. Track the appointment through to a confirmed outcome and chase what is overdue.",
  },
  {
    slug: "escalation",
    name: "Escalation",
    description: "Recognising when something has stopped progressing and needs a person.",
    capabilityTags: ["escalation"],
    domains: ["resident", "maintenance", "vendor"],
    routingSignals: ["repeated", "escalate", "urgent", "unresolved", "again"],
    requiredCapabilities: [],
    riskCeiling: "critical",
    instructions: "Say what has already been tried, why it did not work, and exactly what decision is being asked of the person. An escalation without those three is an interruption.",
  },
];

/**
 * Starter templates.
 *
 * Offered at creation time and copied into an ordinary employee. A customer who
 * picks one gets a head start, not a different kind of employee — which is the
 * difference between a template and a roster.
 */
export interface EmployeeTemplate {
  slug: string;
  name: string;
  role: string;
  objective: string;
  expertise: string[];
  /**
   * What a starter employee can reach on day one.
   *
   * Reads only. Every one of these is a non-mutating tool, so a seeded
   * workspace has employees that can answer questions and none that can change
   * anything until somebody grants it — which is the same rule a hand-made
   * employee follows, not a special case for the ones Aval ships.
   */
  capabilities: string[];
}

export const STARTER_TEMPLATES: readonly EmployeeTemplate[] = [
  { slug: "financial-analyst", name: "Financial Analyst", role: "Financial Analyst",
    objective: "Keep portfolio economics current and explain what changed and why.",
    expertise: ["financial-analysis", "portfolio-outlook"],
    capabilities: ["get_portfolio_metrics", "get_accounting_breakdown", "get_operating_statement", "get_delinquent_accounts", "get_metric_series"] },
  { slug: "brokerage-leasing", name: "Leasing Manager", role: "Brokerage & Leasing",
    objective: "Move the leasing funnel and keep vacancy falling.",
    expertise: ["brokerage-leasing", "market-research"],
    capabilities: ["get_leasing_funnel", "get_property_breakdown", "get_metric_series", "get_leasing_velocity"] },
  { slug: "real-estate", name: "Real Estate Analyst", role: "Real Estate",
    objective: "Keep the portfolio's composition accurate and current.",
    expertise: ["real-estate", "portfolio-outlook"],
    capabilities: ["get_portfolio_metrics", "get_property_breakdown"] },
  { slug: "market-research", name: "Market Researcher", role: "Market Research",
    objective: "Position rents against the market with evidence.",
    expertise: ["market-research"],
    capabilities: ["get_property_breakdown", "get_metric_series"] },
  { slug: "maintenance", name: "Maintenance Coordinator", role: "Maintenance",
    objective: "Take repairs from report to verified completion.",
    expertise: ["maintenance", "vendor-coordination", "escalation"],
    capabilities: ["get_maintenance_performance", "get_portfolio_metrics", "read_maintenance_context"] },
  { slug: "risk-analyst", name: "Risk Analyst", role: "Risk Analyst",
    objective: "Surface exposure before it becomes an incident.",
    expertise: ["risk-analysis"],
    capabilities: ["get_portfolio_metrics", "get_delinquent_accounts", "get_metric_series"] },
  { slug: "portfolio-outlook", name: "Portfolio Strategist", role: "Portfolio Outlook",
    objective: "Explain where the portfolio is heading and on what evidence.",
    expertise: ["portfolio-outlook", "financial-analysis"],
    capabilities: ["get_portfolio_metrics", "get_metric_series"] },
  { slug: "lease-review", name: "Lease Reviewer", role: "Lease Review",
    objective: "Keep lease terms, renewals and obligations understood and on time.",
    expertise: ["lease-review"],
    capabilities: ["get_property_breakdown", "read_document", "list_documents"] },
  { slug: "resident-operations", name: "Resident Operations Manager", role: "Resident Operations Manager",
    objective: "Own resident issues end to end until they are verified resolved.",
    expertise: ["resident-experience", "maintenance", "vendor-coordination", "escalation"],
    capabilities: ["read_maintenance_context", "read_conversation", "list_conversations", "get_maintenance_performance"] },
];

export interface ExpertiseRecord extends ExpertiseCandidateInput {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
}

const parseArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};

/**
 * The shipped catalogue lives in `20260919001100_expertise_seed_and_guards.sql`.
 *
 * Not seeded from here on purpose: a shipped profile carries a null
 * organization, and the insert policy refuses that from an application session
 * so a workspace cannot author a row every other workspace can see. The
 * duplication between that migration and `SHIPPED_EXPERTISE` above is checked
 * by a test rather than trusted.
 */

/** Everything this workspace can see: what Aval ships plus what it wrote. */
export async function listExpertiseCatalogue(
  dbSession: DbSession,
  organizationId: string,
): Promise<ExpertiseRecord[]> {
  const rows = await dbSession.db
    .select()
    .from(expertiseProfiles)
    .where(and(
      eq(expertiseProfiles.enabled, true),
      or(isNull(expertiseProfiles.organizationId), eq(expertiseProfiles.organizationId, organizationId)),
    ))
    .orderBy(asc(expertiseProfiles.slug));

  // A workspace's own profile shadows the shipped one of the same slug.
  const bySlug = new Map<string, ExpertiseRecord>();
  for (const row of rows) {
    const record: ExpertiseRecord = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      capabilityTags: parseArray(row.capabilityTagsJson),
      domains: parseArray(row.domainsJson),
      routingSignals: parseArray(row.routingSignalsJson),
      requiredCapabilities: parseArray(row.requiredCapabilitiesJson),
      riskCeiling: row.riskCeiling as RiskTier,
      instructions: row.instructions,
      version: row.version,
    };
    const shadowed = bySlug.get(row.slug);
    if (!shadowed || row.organizationId !== null) bySlug.set(row.slug, record);
  }
  return [...bySlug.values()];
}

export async function grantExpertise(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
  expertiseId: string,
  grantedBy: string,
  pinned = false,
): Promise<void> {
  await dbSession.db.insert(employeeExpertise).values({
    id: crypto.randomUUID(),
    organizationId, employeeId, expertiseId, pinned, grantedBy, createdAt: new Date(),
  }).onConflictDoNothing();
}

/**
 * The expertise one employee is permitted to load.
 *
 * Selection chooses from this set and never outside it, so an employee cannot
 * acquire a competence at runtime by being asked for one.
 */
export async function employeeCandidates(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
): Promise<ExpertiseRecord[]> {
  const granted = await dbSession.db
    .select({ expertiseId: employeeExpertise.expertiseId, pinned: employeeExpertise.pinned })
    .from(employeeExpertise)
    .where(and(
      eq(employeeExpertise.organizationId, organizationId),
      eq(employeeExpertise.employeeId, employeeId),
    ));
  if (granted.length === 0) return [];

  const pinned = new Map(granted.map((row) => [row.expertiseId, row.pinned]));
  const catalogue = await listExpertiseCatalogue(dbSession, organizationId);
  return catalogue
    .filter((record) => pinned.has(record.id))
    .map((record) => ({ ...record, pinned: pinned.get(record.id) ?? false }));
}

/**
 * Chooses expertise for a piece of work and records why.
 *
 * The decision is persisted whether or not anything was selected: "nothing was
 * relevant" is as much an answer as a list, and an operator asking why an
 * employee was unbriefed deserves to find it.
 */
export async function selectExpertiseForWork(
  dbSession: DbSession,
  organizationId: string,
  input: {
    taskId: string;
    employeeId: string;
    signals: WorkSignals;
    /** A person's explicit choice, which wins unless policy blocks it. */
    requestedSlugs?: readonly string[];
    requestedBy?: string;
  },
): Promise<{ decision: RoutingDecision; loaded: ExpertiseRecord[] }> {
  const candidates = await employeeCandidates(dbSession, organizationId, input.employeeId);
  let decision: RoutingDecision = routeExpertise(candidates, input.signals);
  let overriddenBy: string | null = null;

  if (input.requestedSlugs?.length && input.requestedBy) {
    decision = applyUserSelection(decision, input.requestedSlugs, input.requestedBy);
    overriddenBy = input.requestedBy;
  }

  await dbSession.db.insert(expertiseSelections).values({
    id: crypto.randomUUID(),
    organizationId,
    taskId: input.taskId,
    employeeId: input.employeeId,
    candidatesJson: JSON.stringify(decision.candidates),
    selectedJson: JSON.stringify(decision.selected),
    signalsJson: JSON.stringify(decision.signals),
    decidedBy: decision.decidedBy,
    modelProvider: null,
    modelName: null,
    confidence: null,
    overriddenBy,
    createdAt: new Date(),
  });

  const selected = new Set(decision.selected);
  return { decision, loaded: candidates.filter((record) => selected.has(record.slug)) };
}

/** The instructions for the profiles actually chosen, in selection order. */
export async function loadExpertiseInstructions(
  dbSession: DbSession,
  organizationId: string,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await dbSession.db
    .select({ slug: expertiseProfiles.slug, instructions: expertiseProfiles.instructions })
    .from(expertiseProfiles)
    .where(and(
      inArray(expertiseProfiles.slug, [...slugs]),
      or(isNull(expertiseProfiles.organizationId), eq(expertiseProfiles.organizationId, organizationId)),
    ));
  const bySlug = new Map(rows.map((row) => [row.slug, row.instructions]));
  return slugs.map((slug) => bySlug.get(slug)).filter((value): value is string => Boolean(value));
}

/* ── the workspace's starting team ────────────────────────────────────────── */

/**
 * Gives a workspace the employees Aval ships with.
 *
 * The eight specialists did not become templates that leave a new workspace
 * empty — they are seeded as ordinary employees, and a customer can rename,
 * re-scope, pause or archive any of them exactly as they would one they
 * created. What changed is that the roster is now rows the customer owns rather
 * than a union type they cannot touch.
 *
 * Idempotent, and never re-creates what somebody archived: a workspace that
 * deliberately got rid of the Market Researcher does not find it back tomorrow.
 */
export async function seedWorkspaceEmployees(
  dbSession: DbSession,
  organizationId: string,
  userId: string,
): Promise<number> {
  const existing = await dbSession.db
    .select({ name: aiEmployees.name })
    .from(aiEmployees)
    .where(eq(aiEmployees.organizationId, organizationId));
  // Any employee at all means this workspace has been set up. Seeding again
  // would fight whatever the customer has since decided.
  if (existing.length > 0) return 0;

  const catalogue = await listExpertiseCatalogue(dbSession, organizationId);
  const bySlug = new Map(catalogue.map((record) => [record.slug, record]));

  let created = 0;
  for (const template of STARTER_TEMPLATES) {
    const employee = await createEmployee(dbSession, organizationId, userId, {
      name: template.name,
      role: template.role,
      objective: template.objective,
      status: "active",
      autonomyMode: "supervised",
      scopes: template.capabilities.map((value) => ({ kind: "capability" as const, value })),
    });
    for (const slug of template.expertise) {
      const profile = bySlug.get(slug);
      if (profile) await grantExpertise(dbSession, organizationId, employee.id, profile.id, userId);
    }
    created += 1;
  }
  return created;
}

export interface EmployeeAssignment {
  employeeId: string;
  name: string;
  role: string;
  score: number;
  matched: string[];
}

/**
 * Which employee should take this work.
 *
 * The coordinator does not pick by name. It scores every active employee by the
 * expertise it holds, using the same routing rules that decide which expertise
 * to load — so "who should do this" and "what does this need" are answered by
 * one set of signals rather than two that can disagree.
 *
 * Returns null when nothing scores, which is a real answer: work nobody is
 * equipped for should reach a person rather than the nearest employee.
 */
export async function assignEmployeeForWork(
  dbSession: DbSession,
  organizationId: string,
  signals: WorkSignals,
): Promise<EmployeeAssignment | null> {
  const active = await dbSession.db
    .select({ id: aiEmployees.id, name: aiEmployees.name, role: aiEmployees.role })
    .from(aiEmployees)
    .where(and(eq(aiEmployees.organizationId, organizationId), eq(aiEmployees.status, "active")));
  if (active.length === 0) return null;

  // One catalogue read and one grants read for the whole workspace. Scoring
  // each desk through `employeeCandidates` would reload the entire catalogue
  // once per employee — the same answer at N times the cost, and the roster
  // has no ceiling any more.
  const catalogue = await listExpertiseCatalogue(dbSession, organizationId);
  const grants = await dbSession.db
    .select({
      employeeId: employeeExpertise.employeeId,
      expertiseId: employeeExpertise.expertiseId,
      pinned: employeeExpertise.pinned,
    })
    .from(employeeExpertise)
    .where(eq(employeeExpertise.organizationId, organizationId));
  const heldBy = new Map<string, Map<string, boolean>>();
  for (const grant of grants) {
    const held = heldBy.get(grant.employeeId) ?? new Map<string, boolean>();
    held.set(grant.expertiseId, grant.pinned);
    heldBy.set(grant.employeeId, held);
  }

  let best: EmployeeAssignment | null = null;
  for (const employee of active) {
    const held = heldBy.get(employee.id);
    if (!held) continue;
    // Catalogue order is preserved, so this is the same list, in the same
    // order, that `employeeCandidates` would have returned for this employee.
    const candidates = catalogue
      .filter((record) => held.has(record.id))
      .map((record) => ({ ...record, pinned: held.get(record.id) ?? false }));
    if (candidates.length === 0) continue;
    const decision = routeExpertise(candidates, signals);
    const score = decision.candidates
      .filter((candidate) => decision.selected.includes(candidate.slug))
      .reduce((total, candidate) => total + candidate.score, 0);
    if (score <= 0) continue;
    const matched = decision.candidates
      .filter((candidate) => decision.selected.includes(candidate.slug))
      .flatMap((candidate) => candidate.matched);
    // Ties break on name, so the same work reaches the same desk twice running.
    if (!best || score > best.score || (score === best.score && employee.name < best.name)) {
      best = { employeeId: employee.id, name: employee.name, role: employee.role, score, matched };
    }
  }
  return best;
}

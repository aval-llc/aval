/**
 * Responses shaped exactly like the routes the library reads. The organization
 * is built from the real registry, the same way /api/agents/organization builds
 * it, so what renders is the real catalogue.
 */
import { AVAL_ONE, AVAL_ONE_ID, LEADS, SPECIALISTS, builtInActor, leadRuntimeId, specialistsForDomain } from "@/lib/agents/organization/index.ts";

const nameOf = (id: string) => builtInActor(id)?.name ?? id;

export function organization(includeSpecialists: boolean) {
  return {
    avalOne: { id: AVAL_ONE_ID, alias: AVAL_ONE.id, name: AVAL_ONE.name, subtitle: AVAL_ONE.subtitle, summary: AVAL_ONE.summary },
    leads: LEADS.map((lead) => ({ id: leadRuntimeId(lead), alias: lead.id, domain: lead.domain, name: lead.name, summary: lead.summary, historical: Boolean(lead.legacyPersonaId), specialistCount: specialistsForDomain(lead.domain).length, relatedLeads: [] })),
    counts: { leads: LEADS.length, specialists: SPECIALISTS.length, domains: LEADS.length },
    ...(includeSpecialists ? {
      specialists: SPECIALISTS.map((specialist) => ({
        id: specialist.id, name: specialist.name, domain: specialist.domain, boundary: specialist.boundary,
        notThis: { id: specialist.notThis.specialist, name: nameOf(specialist.notThis.specialist), because: specialist.notThis.because },
        triggers: specialist.triggers, inputs: specialist.inputs, outputs: specialist.outputs, capabilities: specialist.capabilities,
        approvals: specialist.approvals, forbidden: [...specialist.forbidden, ...(LEADS.find((lead) => lead.domain === specialist.domain)?.domainForbidden ?? [])],
        completion: specialist.completion, collaborators: specialist.collaborators.map((id) => ({ id, name: nameOf(id) })),
      })),
    } : {}),
  };
}

/**
 * 28 employees — more than one page of 24, so pagination can be seen — named
 * and scoped the way a real team is, including one migrated from a custom
 * persona. Harness fixtures only; nothing here exists in any workspace.
 */
const TEAM: Array<[string, string, string]> = [
  ["Maya", "Resident Operations", "Own resident issues end to end until they are verified resolved."],
  ["David", "Maintenance Operations", "Take repairs from report to verified completion."],
  ["Sarah", "Portfolio Analyst", "Explain where the portfolio stands and on what evidence."],
  ["Morgan", "Leasing Operations", "Move the leasing funnel and keep vacancy falling."],
  ["Jordan", "Owner Reporting", "Give each owner a reconciled picture of their property every period."],
  ["Priya", "Maintenance Operations", "Run preventive maintenance for the east portfolio."],
  ["Luis", "Leasing Operations", "Lease up the Riverside building."],
  ["Hannah", "Resident Operations", "Handle move-ins and resident onboarding."],
  ["Omar", "Owner Reporting", "Close owner statements for the single-family book."],
  ["Grace", "Portfolio Analyst", "Track NOI and variance against budget."],
  ["Ethan", "Maintenance Operations", "Coordinate vendors and after-hours emergencies."],
  ["Zoe", "Leasing Operations", "Follow up every lead within one business day."],
  ["Mateo", "Resident Operations", "Resolve payment questions and portal issues."],
  ["Nina", "Owner Reporting", "Prepare the quarterly investor brief."],
  ["Caleb", "Portfolio Analyst", "Model capex and reserves for next year."],
  ["Aisha", "Maintenance Operations", "Own turn scheduling and make-ready."],
  ["Ben", "Leasing Operations", "Coordinate self-guided tours."],
  ["Chloe", "Resident Operations", "Collect renters insurance and keep it current."],
  ["Ravi", "Owner Reporting", "Answer owner questions within a day."],
  ["Elena", "Portfolio Analyst", "Benchmark properties against each other."],
  ["Theo", "Maintenance Operations", "Track SLAs and repeat issues."],
  ["Ivy", "Leasing Operations", "Keep listings accurate across channels."],
  ["Marcus", "Resident Operations", "Run renewals outreach with the resident team."],
  ["Lena", "Owner Reporting", "Reconcile owner contributions and reserves."],
  ["Sam", "Portfolio Analyst", "Watch delinquency and concentration risk."],
  ["Rosa", "Maintenance Operations", "Manage the plumbing and HVAC vendor pool."],
];
export const EMPLOYEES = [
  { id: "persona-7f3a", name: "Lease reader", role: "Custom agent", objective: "Read our leases and flag renewal dates.", status: "active", autonomyMode: "supervised" },
  ...TEAM.map(([name, role, objective], i) => ({ id: `emp-${i}`, name, role, objective, status: i === 1 ? "paused" : i % 9 === 4 ? "draft" : "active", autonomyMode: i % 3 === 0 ? "assisted" : "supervised" })),
];

/** The five optional templates, as GET /api/agents/employees returns them. */
export const TEMPLATES = [
  { slug: "resident-operations", name: "Resident Operations", role: "Resident Operations", objective: "Own resident issues end to end until they are verified resolved." },
  { slug: "maintenance-operations", name: "Maintenance Operations", role: "Maintenance Operations", objective: "Take repairs from report to verified completion." },
  { slug: "leasing-operations", name: "Leasing Operations", role: "Leasing Operations", objective: "Move the leasing funnel and keep vacancy falling." },
  { slug: "portfolio-analyst", name: "Portfolio Analyst", role: "Portfolio Analyst", objective: "Explain where the portfolio stands, where it is heading, and on what evidence." },
  { slug: "owner-reporting", name: "Owner Reporting", role: "Owner Reporting", objective: "Give each owner an accurate, reconciled picture of their property every period." },
];

export const TASKS = [
  { id: "t1", agentId: "maintenance", employeeId: null, goal: "Coordinate the leak repair in 4B", status: "RUNNING" },
  { id: "t2", agentId: "general", employeeId: null, goal: "Review maintenance performance across the portfolio", status: "COMPLETED" },
  { id: "t3", agentId: "lead.hoa", employeeId: null, goal: "Prepare the architectural request for board review", status: "WAITING_FOR_OWNER" },
];

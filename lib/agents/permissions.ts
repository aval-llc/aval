/**
 * Permission envelopes — what each agent is *allowed* to do, expressed
 * independently of what any model proposes.
 *
 * This file exists because of one inversion the architecture audit found
 * (docs/AGENT_ARCHITECTURE_AUDIT.md, gap 1): tool access was enforced only by
 * filtering the schema list handed to the model. That makes the model the
 * enforcer of its own permissions. Everything here is the deterministic half
 * of the answer — read at execution time, never derived from model output,
 * never influenced by anything inside a prompt or a tool result.
 *
 * The envelopes follow §17 of the production-readiness guide: the agent with
 * the widest visibility (Risk Analyst) gets the least mutation authority, and
 * no agent holds a write permission it does not need for its own job.
 */

/**
 * One capability, named as `<domain>.<action>`. Tools declare which one they
 * need (registry.ts); agents hold a set of them (below). A tool with no
 * matching permission in the caller's envelope cannot execute, whatever the
 * model asked for.
 */
export type Permission =
  | "tasks.manage"
  // read
  | "portfolio.read"
  | "accounting.read"
  | "leases.read"
  | "documents.read"
  | "maintenance.read"
  | "leasing.read"
  | "market.read"
  | "provenance.read"
  // write, low risk
  | "preferences.write"
  // write, gated — no tool claims these yet. They are declared now so the
  // first tool that needs one lands inside an envelope rather than beside it.
  | "documents.draft"
  | "messaging.send.external"
  | "listing.publish"
  | "vendor.dispatch"
  | "vendor.spend.authorize"
  | "lease.execute"
  | "payments.execute"
  | "permissions.modify"
  // Writes *into* a customer's PMS. Separate from the permissions above because
  // those describe an effect in the world (money moved, a lease executed) while
  // these describe an effect in someone else's system of record. An agent can
  // legitimately need one without the other, and the blast radius differs: a
  // wrong work order is an apology, a wrong ledger posting is a regulated event.
  // Holding one of these is still not sufficient — `lib/pms/capability.ts`
  // decides whether the tool exists for this org and provider at all.
  | "pms.maintenance.write"
  | "pms.arrears.write"
  | "pms.leasing.write";

/** Agents that exist as permission subjects. Mirrors `PersonaId` in lib/ask-aval/personas.ts; a custom persona resolves to `custom`. */
export type AgentRole =
  | "general"
  | "financial"
  | "brokerage"
  | "realEstate"
  | "marketResearch"
  | "maintenance"
  | "riskAnalyst"
  | "portfolioOutlook"
  | "leaseReview"
  | "custom";

const READ_EVERYTHING: readonly Permission[] = [
  "portfolio.read",
  "accounting.read",
  "leases.read",
  "documents.read",
  "maintenance.read",
  "leasing.read",
  "market.read",
  "provenance.read",
];

/**
 * The authoritative envelope per agent. Adding a permission here is the only
 * way an agent gains authority — a system prompt cannot, and neither can a
 * tool result that asks nicely.
 */
export const AGENT_PERMISSIONS: Record<AgentRole, readonly Permission[]> = {
  // The unspecialized assistant. Broad read, one narrow write (its own
  // behavioral memory), nothing external.
  general: [...READ_EVERYTHING, "preferences.write", "messaging.send.external", "listing.publish"],

  // Arrears is the financial agent's workflow, so it holds the permission —
  // which grants nothing until an org records a signed authorization, because
  // the matrix resolves every arrears write to `off` without one.
  financial: ["portfolio.read", "accounting.read", "leases.read", "market.read", "preferences.write", "messaging.send.external", "pms.arrears.write"],

  // Leasing writes are Fair Housing-exposed: every applicant-facing action this
  // permission reaches carries a mandatory human checkpoint that no setting can
  // remove (MANDATORY_HUMAN_CHECKPOINT in lib/pms/types.ts).
  brokerage: ["leasing.read", "portfolio.read", "leases.read", "market.read", "preferences.write", "messaging.send.external", "listing.publish", "pms.leasing.write"],

  realEstate: ["portfolio.read", "leasing.read", "leases.read", "preferences.write"],

  marketResearch: ["market.read", "portfolio.read", "leasing.read", "preferences.write"],

  // The only role holding a PMS write permission by default, matching the
  // workflow defaults in lib/pms/types.ts: maintenance writes on, everything
  // else off. `vendor.dispatch` is the pre-existing permission for the same act.
  maintenance: ["maintenance.read", "portfolio.read", "accounting.read", "preferences.write", "messaging.send.external", "vendor.dispatch", "pms.maintenance.write"],

  // §17: "The agent with the widest visibility should often have the least
  // mutation authority." Risk Analyst reads across every domain and holds no
  // write permission at all, not even preferences.
  riskAnalyst: [...READ_EVERYTHING],

  portfolioOutlook: ["portfolio.read", "accounting.read", "market.read", "provenance.read", "preferences.write"],

  // Document-heavy and deliberately narrow: a lease reviewer that could also
  // read the receivables ledger is a lease reviewer that can be talked into
  // reading the receivables ledger by the lease it is reading.
  leaseReview: ["documents.read", "leases.read"],

  // A workspace-defined persona (lib/ask-aval/custom-personas.ts). Read-only
  // and no broader than the general agent's reads: the tools it may actually
  // call are additionally narrowed by its own validated `toolNames`, but its
  // ceiling is fixed here in code where a workspace cannot raise it.
  custom: [...READ_EVERYTHING],
};

/** Resolves any persona id — built-in or a custom row's uuid — to a role. Unknown ids get the `custom` (read-only) envelope, never `general`. */
export function roleForPersona(personaId: string | undefined): AgentRole {
  if (!personaId) return "general";
  return personaId in AGENT_PERMISSIONS && personaId !== "custom" ? (personaId as AgentRole) : "custom";
}

export function permissionsFor(role: AgentRole): ReadonlySet<Permission> {
  return new Set(AGENT_PERMISSIONS[role]);
}

export function hasPermission(role: AgentRole, permission: Permission): boolean {
  return permission === "tasks.manage" || AGENT_PERMISSIONS[role].includes(permission);
}

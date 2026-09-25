/**
 * Aval's built-in organization, resolved into runtime actors.
 *
 * Every task names an actor in `agent_tasks.agent_id`. Before this module that
 * id was one of nine persona ids or a custom persona's uuid. It may now also be
 * a Lead or a Specialist, and this is the one place that says what each of them
 * is allowed to do:
 *
 *   - what it may exercise (`permissions`), which is authority;
 *   - what it may route to someone below it without exercising it
 *     (`orchestrates`), which is coordination;
 *   - whom it may hand work to (`delegatesTo`);
 *   - which tools frame its work (`toolNames`), which is curation, not authority.
 *
 * Historical ids keep meaning exactly what they meant. `general` is Aval One,
 * the eight legacy personas are eight of the Leads, and each keeps its
 * historical envelope and tool subset unchanged. `aval-one` and `lead.<domain>`
 * are aliases that resolve to those ids, never the other way round, so no
 * stored row is reinterpreted.
 *
 * No storage imports. Everything here is computed once, at module load, from
 * static definitions.
 */

import { AGENT_PERMISSIONS, ORCHESTRATION_PERMISSIONS, type AgentRole, type Permission } from "../permissions.ts";
import { LEGACY_DELEGATION_RULES as DELEGATION_RULES } from "../delegation-policy.ts";
import { getTool } from "../registry.ts";
import { PERSONAS, type PersonaId } from "../../ask-aval/persona-catalog.ts";
import { toolsForCapabilities, untooledCapabilities } from "./capabilities.ts";
import { AVAL_ONE, LEADS, leadForDomain, leadRuntimeId } from "./domains.ts";
import type { ActorKind, CustomerType, DomainId, LeadDefinition, Maturity, SpecialistDefinition } from "./types.ts";

import { SPECIALISTS as LEASING_MARKETING } from "./specialists/leasing-marketing.ts";
import { SPECIALISTS as SCREENING } from "./specialists/screening.ts";
import { SPECIALISTS as RESIDENT_EXPERIENCE } from "./specialists/resident-experience.ts";
import { SPECIALISTS as RENEWALS } from "./specialists/renewals.ts";
import { SPECIALISTS as MAINTENANCE } from "./specialists/maintenance.ts";
import { SPECIALISTS as TURNS } from "./specialists/turns.ts";
import { SPECIALISTS as INSPECTIONS } from "./specialists/inspections.ts";
import { SPECIALISTS as FINANCE } from "./specialists/finance.ts";
import { SPECIALISTS as RECEIVABLES } from "./specialists/receivables.ts";
import { SPECIALISTS as SPEND_VENDOR } from "./specialists/spend-vendor.ts";
import { SPECIALISTS as OWNER_SERVICES } from "./specialists/owner-services.ts";
import { SPECIALISTS as LEASE_ADMIN } from "./specialists/lease-admin.ts";
import { SPECIALISTS as RISK_COMPLIANCE } from "./specialists/risk-compliance.ts";
import { SPECIALISTS as AFFORDABLE } from "./specialists/affordable.ts";
import { SPECIALISTS as PROPERTY_OPERATIONS } from "./specialists/property-operations.ts";
import { SPECIALISTS as PORTFOLIO_STRATEGY } from "./specialists/portfolio-strategy.ts";
import { SPECIALISTS as MARKET_REVENUE } from "./specialists/market-revenue.ts";
import { SPECIALISTS as UTILITIES } from "./specialists/utilities.ts";
import { SPECIALISTS as HOA } from "./specialists/hoa.ts";
import { SPECIALISTS as COMMERCIAL } from "./specialists/commercial.ts";
import { SPECIALISTS as DATA_INTEGRATIONS } from "./specialists/data-integrations.ts";
import { SPECIALISTS as PEOPLE_OPERATIONS } from "./specialists/people-operations.ts";

export { AVAL_ONE, LEADS, leadForDomain, leadRuntimeId } from "./domains.ts";
export * from "./types.ts";
export * from "./capabilities.ts";

/** Bumped when a definition changes meaning. Recorded with work so history can say which catalogue it ran under. */
export const ORGANIZATION_VERSION = 1;

export const SPECIALISTS: readonly SpecialistDefinition[] = [
  ...LEASING_MARKETING, ...SCREENING, ...RESIDENT_EXPERIENCE, ...RENEWALS, ...MAINTENANCE,
  ...TURNS, ...INSPECTIONS, ...FINANCE, ...RECEIVABLES, ...SPEND_VENDOR, ...OWNER_SERVICES,
  ...LEASE_ADMIN, ...RISK_COMPLIANCE, ...AFFORDABLE, ...PROPERTY_OPERATIONS, ...PORTFOLIO_STRATEGY,
  ...MARKET_REVENUE, ...UTILITIES, ...HOA, ...COMMERCIAL, ...DATA_INTEGRATIONS, ...PEOPLE_OPERATIONS,
];

/** The runtime id of Aval One. Historical work was recorded under it. */
export const AVAL_ONE_ID = AVAL_ONE.legacyPersonaId;

/**
 * Permissions no actor may route, whoever holds them.
 *
 * Moving money, executing a contract and changing access are never delegated
 * onward by a coordinator. A task that needs one runs as the actor that holds
 * it, directly, where approval applies to it by name. `preferences.write` is a
 * workspace's own memory, not a domain act, so there is nothing to route.
 */
export const NEVER_ROUTABLE: ReadonlySet<Permission> = new Set<Permission>([
  "payments.execute", "lease.execute", "permissions.modify", "vendor.spend.authorize", "preferences.write", "tasks.manage",
]);

export interface BuiltInActor {
  /** The id work runs under. */
  id: string;
  kind: ActorKind;
  name: string;
  domain: DomainId | null;
  /** Other ids that resolve to this actor. */
  aliases: readonly string[];
  /** Tool framing. Null means no subset — every tool the envelope allows. */
  toolNames: readonly string[] | null;
  /** What this actor may exercise. */
  permissions: readonly Permission[];
  /** What this actor may route to a descendant without exercising it. */
  orchestrates: readonly Permission[];
  /** Runtime ids this actor may hand work to. */
  delegatesTo: ReadonlySet<string>;
  /** Appended to the base system prompt. Framing only; the hard rules never change. */
  instructions: string;
}

/* ── derivation ──────────────────────────────────────────────────────────── */

/** Registry tools a specialist can actually call today: mapped from its capabilities, implemented only. */
function implementedTools(capabilities: readonly string[]): string[] {
  return toolsForCapabilities(capabilities).filter((name) => {
    const tool = getTool(name);
    return tool !== undefined && !tool.unimplemented;
  });
}

/** The permissions a set of tools requires, which is the only way a derived actor holds anything. */
function permissionsOf(toolNames: readonly string[], { readsOnly = false } = {}): Permission[] {
  const held = new Set<Permission>();
  for (const name of toolNames) {
    const tool = getTool(name);
    if (!tool || tool.unimplemented || tool.requiredPermission === "tasks.manage") continue;
    if (readsOnly && tool.mutates) continue;
    held.add(tool.requiredPermission);
  }
  return [...held];
}

function routable(candidates: Iterable<Permission>, held: readonly Permission[]): Permission[] {
  const own = new Set(held);
  return [...new Set(candidates)].filter((permission) => !own.has(permission) && !NEVER_ROUTABLE.has(permission));
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "nothing listed" : items.join("; ");
}

const SPECIALISTS_BY_DOMAIN = new Map<DomainId, SpecialistDefinition[]>();
for (const specialist of SPECIALISTS) {
  const group = SPECIALISTS_BY_DOMAIN.get(specialist.domain) ?? [];
  group.push(specialist);
  SPECIALISTS_BY_DOMAIN.set(specialist.domain, group);
}

export function specialistsForDomain(domain: DomainId): readonly SpecialistDefinition[] {
  return SPECIALISTS_BY_DOMAIN.get(domain) ?? [];
}

const SPECIALIST_TOOLS = new Map(SPECIALISTS.map((specialist) => [specialist.id, implementedTools(specialist.capabilities)]));

function specialistInstructions(specialist: SpecialistDefinition, lead: LeadDefinition): string {
  const sibling = SPECIALISTS.find((candidate) => candidate.id === specialist.notThis.specialist);
  return [
    `\n\nYou are working as the Aval Specialist "${specialist.name}", coordinated by the ${lead.name}.`,
    `Task boundary: ${specialist.boundary}`,
    `This is not ${sibling?.name ?? specialist.notThis.specialist}: ${specialist.notThis.because}`,
    `The work is done when: ${specialist.completion.doneWhen} It is not done when: ${specialist.completion.notDoneWhen}`,
    `Never: ${list([...specialist.forbidden, ...lead.domainForbidden])}.`,
    specialist.approvals.length ? `Prepare these for a person's approval rather than doing them: ${list(specialist.approvals)}.` : "",
    lead.domainInstructions,
    "If the work belongs to a different specialist, say which one and stop rather than doing it yourself.",
  ].filter(Boolean).join(" ");
}

function leadInstructions(lead: LeadDefinition, legacy: string): string {
  const team = specialistsForDomain(lead.domain).map((specialist) => `${specialist.id} (${specialist.name})`).join(", ");
  return `${legacy}\n\nYou are the ${lead.name}: ${lead.summary} ${lead.domainInstructions} Never: ${list(lead.domainForbidden)}. You coordinate these Aval Specialists and may assign work to them by id: ${team}.`;
}

const ACTORS = new Map<string, BuiltInActor>();
const ALIASES = new Map<string, string>();

// Specialists first: a Lead's routable set is derived from what its team holds.
for (const specialist of SPECIALISTS) {
  const lead = leadForDomain(specialist.domain);
  const tools = SPECIALIST_TOOLS.get(specialist.id) ?? [];
  ACTORS.set(specialist.id, {
    id: specialist.id,
    kind: "specialist",
    name: specialist.name,
    domain: specialist.domain,
    aliases: [],
    toolNames: tools,
    permissions: permissionsOf(tools),
    // A specialist routes nothing. A peer it asks for help can therefore only
    // exercise what the asking specialist could itself — delegation narrows.
    orchestrates: [],
    delegatesTo: new Set([
      ...specialist.collaborators,
      leadRuntimeId(lead),
      ...lead.relatedDomains.map((domain) => leadRuntimeId(leadForDomain(domain))),
    ].filter((id) => id !== specialist.id)),
    instructions: specialistInstructions(specialist, lead),
  });
}

for (const lead of LEADS) {
  const id = leadRuntimeId(lead);
  const team = specialistsForDomain(lead.domain);
  const teamPermissions = team.flatMap((specialist) => ACTORS.get(specialist.id)?.permissions ?? []);
  const legacy = lead.legacyPersonaId ? PERSONAS[lead.legacyPersonaId as PersonaId] : undefined;
  const permissions = legacy
    ? [...AGENT_PERMISSIONS[lead.legacyPersonaId as AgentRole]]
    : [...permissionsOf(team.flatMap((specialist) => SPECIALIST_TOOLS.get(specialist.id) ?? []), { readsOnly: true }), "preferences.write" as Permission];
  const legacyTargets = lead.legacyPersonaId ? DELEGATION_RULES[lead.legacyPersonaId as AgentRole] ?? [] : [];
  ACTORS.set(id, {
    id,
    kind: "lead",
    name: lead.name,
    domain: lead.domain,
    aliases: lead.legacyPersonaId ? [lead.id] : [],
    // A legacy Lead keeps its historical subset exactly. A new Lead is framed
    // by what its team reads — a coordinator looks things up, it does not act.
    toolNames: legacy
      ? legacy.toolNames
      : [...new Set(team.flatMap((specialist) => SPECIALIST_TOOLS.get(specialist.id) ?? []).filter((name) => getTool(name)?.mutates === false))],
    permissions,
    orchestrates: routable(teamPermissions, permissions),
    delegatesTo: new Set([
      ...team.map((specialist) => specialist.id),
      ...lead.relatedDomains.map((domain) => leadRuntimeId(leadForDomain(domain))),
      ...legacyTargets,
    ].filter((target) => target !== id)),
    instructions: leadInstructions(lead, legacy?.systemPromptAddition ?? ""),
  });
  if (lead.legacyPersonaId) ALIASES.set(lead.id, id);
}

{
  const leads = LEADS.map((lead) => ACTORS.get(leadRuntimeId(lead))!);
  const permissions = [...AGENT_PERMISSIONS.general];
  ACTORS.set(AVAL_ONE_ID, {
    id: AVAL_ONE_ID,
    kind: "aval_one",
    name: AVAL_ONE.name,
    domain: null,
    aliases: [AVAL_ONE.id],
    toolNames: PERSONAS.general.toolNames,
    permissions,
    // Everything any Lead may exercise or route, plus the PMS writes the
    // coordinator has always routed. Never anything in NEVER_ROUTABLE, and
    // never exercisable by Aval One itself: `permissions` is unchanged.
    orchestrates: routable([
      ...(ORCHESTRATION_PERMISSIONS.general ?? []),
      ...leads.flatMap((lead) => [...lead.permissions, ...lead.orchestrates]),
    ], permissions),
    // Aval One may address any Lead or, where a Lead would only add a hop, any
    // Specialist directly (directive §6). Leads are not mandatory.
    delegatesTo: new Set([
      ...leads.map((lead) => lead.id),
      ...SPECIALISTS.map((specialist) => specialist.id),
      ...(DELEGATION_RULES.general ?? []),
    ]),
    instructions: PERSONAS.general.systemPromptAddition,
  });
  ALIASES.set(AVAL_ONE.id, AVAL_ONE_ID);
}

/* ── lookup ──────────────────────────────────────────────────────────────── */

/** The id an actor runs under. Aliases resolve to historical ids; anything else is returned unchanged. */
export function resolveActorId(id: string): string {
  return ALIASES.get(id) ?? id;
}

/** A built-in actor by runtime id or alias, or null for anything else (a custom persona, an employee, a typo). */
export function builtInActor(id: string | undefined | null): BuiltInActor | null {
  if (!id) return null;
  return ACTORS.get(resolveActorId(id)) ?? null;
}

export function builtInActors(): readonly BuiltInActor[] {
  return [...ACTORS.values()];
}

export function isOrchestrator(id: string | undefined | null): boolean {
  return builtInActor(id)?.kind === "aval_one";
}

/**
 * What an actor may exercise.
 *
 * A built-in actor has its derived envelope. Anything unrecognised gets the
 * read-only `custom` envelope, never Aval One's — a typo narrows authority, it
 * never widens it. That is the rule `roleForPersona` has always applied.
 */
export function actorPermissions(id: string | undefined | null): readonly Permission[] {
  if (!id) return AGENT_PERMISSIONS.general;
  return builtInActor(id)?.permissions ?? AGENT_PERMISSIONS.custom;
}

export function actorHolds(id: string | undefined | null, permission: Permission): boolean {
  return permission === "tasks.manage" || actorPermissions(id).includes(permission);
}

/** Whether `id` may appear in the ancestry of a task exercising `permission` without holding it. */
export function actorOrchestrates(id: string | undefined | null, permission: Permission): boolean {
  return builtInActor(id)?.orchestrates.includes(permission) ?? false;
}

/** Whether a built-in actor may hand work to another. Unknown actors delegate to nobody. */
export function actorMayDelegateTo(fromId: string, toId: string): boolean {
  const from = builtInActor(fromId);
  const to = resolveActorId(toId);
  if (!from || to === from.id || to === AVAL_ONE_ID) return false;
  return from.delegatesTo.has(to);
}

/* ── catalogue facts ─────────────────────────────────────────────────────── */

/**
 * How far a specialist has been taken (directive §32), from what the code can
 * show rather than what anyone claims. Every capability delivered by an
 * implemented tool is TOOLED; anything less is ROUTABLE, because the runtime
 * can still address it and brief a model with its boundary. Nothing here is
 * provider-tested: that is a property of a provider workflow, recorded by the
 * certification harness, not of a specialist definition.
 */
export function specialistMaturity(specialist: SpecialistDefinition): Maturity {
  return untooledCapabilities(specialist.capabilities).length === 0 ? "TOOLED" : "ROUTABLE";
}

/**
 * The domains a workspace's routing may reach. An empty list — a workspace that
 * has not said what business it runs — reaches every domain, which is what it
 * did before this existed.
 */
export function eligibleDomains(customerTypes: readonly CustomerType[]): ReadonlySet<DomainId> {
  if (customerTypes.length === 0) return new Set(LEADS.map((lead) => lead.domain));
  return new Set(LEADS
    .filter((lead) => lead.appliesTo.length === 0 || lead.appliesTo.some((type) => customerTypes.includes(type)))
    .map((lead) => lead.domain));
}

/**
 * The id PMS deployments are looked up under for an actor.
 *
 * Deployments (`agent_deployments.persona_id`) were configured against the
 * historical agents. A Specialist works inside its Lead's deployments, so the
 * maintenance specialists reach exactly the PMS workflows the Maintenance
 * agent was deployed to, and no others.
 */
export function deploymentActorId(id: string): string {
  const actor = builtInActor(id);
  if (!actor) return id;
  if (actor.kind === "specialist" && actor.domain) return leadRuntimeId(leadForDomain(actor.domain));
  return actor.id;
}

export function specialistById(id: string): SpecialistDefinition | null {
  return SPECIALISTS.find((specialist) => specialist.id === id) ?? null;
}

export function organizationCounts() {
  return { avalOne: 1, leads: LEADS.length, specialists: SPECIALISTS.length, domains: SPECIALISTS_BY_DOMAIN.size };
}

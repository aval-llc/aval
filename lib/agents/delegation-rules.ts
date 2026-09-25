/**
 * Controlled agent-to-agent delegation (§19).
 *
 * The useful case is real: a Financial Analyst working a liquidity goal finds
 * a lease-expiration cluster and wants Lease Review's reading of the actual
 * documents, rather than guessing at terms it cannot see. The dangerous case
 * is equally real: agents invoking each other without a bound, each hop
 * spending the workspace's money, none of them individually wrong.
 *
 * The limits, all deterministic and none of them advisory:
 *
 * 1. **A declared graph**, not a general capability. Who may hand work to whom
 *    is part of each actor's definition (lib/agents/organization): Aval One to
 *    any Lead or Specialist, a Lead to its own team and related Leads, a
 *    Specialist to its declared collaborators and related Leads. The historical
 *    persona pairs below are all still edges of that graph.
 * 2. **Controlled depth and size** (delegation-policy.ts), not one integer.
 * 3. **A shared budget.** The child's steps come out of the parent's
 *    remaining allowance, so a chain cannot cost more than one task.
 * 4. **The child never exercises authority the chain above it lacks.** A
 *    descendant may use a permission only if it holds it and every ancestor
 *    either holds it or may route it (task-boundary.ts). Delegation narrows;
 *    otherwise "ask Lease Review to read it for you" becomes the documented way
 *    around a permission boundary.
 */

import { AGENT_PERMISSIONS, type AgentRole, type Permission } from "./permissions.ts";
import { LEGACY_DELEGATION_RULES, MAX_DELEGATION_DEPTH } from "./delegation-policy.ts";
import { actorHolds, actorMayDelegateTo, actorOrchestrates, actorPermissions, builtInActor } from "./organization/index.ts";
import { roleForPersona } from "./permissions.ts";

/** The historical persona pairs. Every one remains an edge of the organization's graph. */
export const DELEGATION_RULES = LEGACY_DELEGATION_RULES;

export type DelegationRefusal =
  | { ok: false; code: "not_allowed"; reason: string }
  | { ok: false; code: "depth_exceeded"; reason: string }
  | { ok: false; code: "no_budget"; reason: string }
  | { ok: false; code: "cancelled"; reason: string };

export type DelegationCheck = { ok: true; permissions: readonly Permission[] } | DelegationRefusal;

/**
 * The permissions both envelopes hold — what a child could exercise if the
 * parent could not route anything. Delegation narrows, never widens.
 */
export function effectivePermissions(from: AgentRole, to: AgentRole): Permission[] {
  const parent = new Set(AGENT_PERMISSIONS[from]);
  return AGENT_PERMISSIONS[to].filter((permission) => parent.has(permission));
}

/**
 * What a child actor may actually exercise under a parent actor: its own
 * envelope, less anything the parent neither holds nor may route. The same
 * rule `taskBoundary` applies on every call, stated once for planning.
 */
export function delegatedAuthority(fromId: string, toId: string): Permission[] {
  return actorPermissions(toId).filter((permission) => actorHolds(fromId, permission) || actorOrchestrates(fromId, permission));
}

/** The parent facts a delegation decision needs. Structural, so this module never imports the storage layer. */
export interface DelegationParent {
  agentId: string;
  delegationDepth: number;
  maxSteps: number;
  stepCount: number;
  maxTokens: number;
  tokensUsed: number;
  cancelRequested: boolean;
}

/** Every check a delegation must pass that needs no storage, in one place, before any row is written. */
export function checkDelegation(parent: DelegationParent, toActorId: string): DelegationCheck {
  if (parent.cancelRequested) {
    return { ok: false, code: "cancelled", reason: "The parent task is cancelling; no new work may be started under it." };
  }

  if (!actorMayDelegateTo(parent.agentId, toActorId)) {
    const from = builtInActor(parent.agentId)?.name ?? roleForPersona(parent.agentId);
    const to = builtInActor(toActorId)?.name ?? roleForPersona(toActorId);
    return { ok: false, code: "not_allowed", reason: `"${from}" may not delegate to "${to}".` };
  }

  const depth = parent.delegationDepth + 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    return { ok: false, code: "depth_exceeded", reason: `Delegation depth ${depth} exceeds the limit of ${MAX_DELEGATION_DEPTH}.` };
  }

  const remainingSteps = parent.maxSteps - parent.stepCount;
  const remainingTokens = parent.maxTokens - parent.tokensUsed;
  // A child needs room to do something more than immediately conclude. Two
  // steps is the floor: one to read, one to answer.
  if (remainingSteps < 2 || remainingTokens <= 0) {
    return { ok: false, code: "no_budget", reason: "The parent task has no execution budget left to share." };
  }

  return { ok: true, permissions: delegatedAuthority(parent.agentId, toActorId) };
}

/** The delegation role for an actor, with what it may delegate to. Legacy personas only; see the organization for the full graph. */
export function roleForDelegation(actorId: string): { role: AgentRole; allowed: readonly AgentRole[] } {
  const role = roleForPersona(actorId);
  return { role, allowed: DELEGATION_RULES[role] ?? [] };
}

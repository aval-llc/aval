/**
 * Controlled agent-to-agent delegation (§19).
 *
 * The useful case is real: a Financial Analyst working a liquidity goal finds
 * a lease-expiration cluster and wants Lease Review's reading of the actual
 * documents, rather than guessing at terms it cannot see. The dangerous case
 * is equally real: agents invoking each other without a bound, each hop
 * spending the workspace's money, none of them individually wrong.
 *
 * Four limits, all deterministic and none of them advisory:
 *
 * 1. **An allow-list of pairs**, not a general capability. Delegation is a
 *    declared relationship between two roles, so the reachable graph is
 *    readable in one table instead of emergent at runtime.
 * 2. **A depth cap** (policy.ts). A → B → C is the most that can happen.
 * 3. **A shared budget.** The child's steps come out of the parent's
 *    remaining allowance, so a chain cannot cost more than one task.
 * 4. **The child never holds authority the parent lacks.** Its permissions are
 *    the intersection of the two envelopes, so delegation can only ever
 *    narrow. Otherwise "ask Lease Review to read it for you" becomes the
 *    documented way around a permission boundary.
 */

import { AGENT_PERMISSIONS, roleForPersona, type AgentRole, type Permission } from "./permissions.ts";
import { MAX_DELEGATION_DEPTH } from "./policy.ts";

/**
 * Who may ask whom. Read as: the key delegates to the values.
 *
 * Deliberately sparse. Each pair exists because there is a question the
 * delegator genuinely cannot answer with its own tools — not because the two
 * agents are topically adjacent.
 */
export const DELEGATION_RULES: Partial<Record<AgentRole, readonly AgentRole[]>> = {
  // Cash-flow work runs into lease terms it cannot read and maintenance spend
  // it cannot see the work orders behind.
  financial: ["leaseReview", "maintenance"],
  // The widest reader, so it is the most likely to need a specialist's depth —
  // and it holds no write permission, so nothing it delegates can mutate.
  riskAnalyst: ["leaseReview", "financial", "maintenance"],
  // Forward-looking work needs the expiration schedule read from the documents
  // themselves, not from the summary fields.
  portfolioOutlook: ["leaseReview", "financial"],
  // Renewal and expiration questions land here first and often need the lease.
  brokerage: ["leaseReview"],
  // Brokerage was absent, which left `pms.leasing.write` — the permission only
  // brokerage holds — unreachable from the coordinator. Leasing work could be
  // started by explicitly selecting the specialist but never by coordinating
  // toward it, which is the path event-driven work has to take.
  general: ["financial", "leaseReview", "maintenance", "riskAnalyst", "brokerage"],
};

export type DelegationRefusal =
  | { ok: false; code: "not_allowed"; reason: string }
  | { ok: false; code: "depth_exceeded"; reason: string }
  | { ok: false; code: "no_budget"; reason: string }
  | { ok: false; code: "cancelled"; reason: string };

export type DelegationCheck = { ok: true; permissions: readonly Permission[] } | DelegationRefusal;

/** The permissions a delegated child may hold: the intersection of both envelopes. Delegation narrows, never widens. */
export function effectivePermissions(from: AgentRole, to: AgentRole): Permission[] {
  const parent = new Set(AGENT_PERMISSIONS[from]);
  return AGENT_PERMISSIONS[to].filter((permission) => parent.has(permission));
}

/** Every check a delegation must pass, in one place, before any row is written. */
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

export function checkDelegation(parent: DelegationParent, toPersonaId: string): DelegationCheck {
  if (parent.cancelRequested) {
    return { ok: false, code: "cancelled", reason: "The parent task is cancelling; no new work may be started under it." };
  }

  const from = roleForPersona(parent.agentId);
  const to = roleForPersona(toPersonaId);
  const allowed = DELEGATION_RULES[from] ?? [];
  if (!allowed.includes(to)) {
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

  const permissions = effectivePermissions(from, to);
  if (permissions.length === 0) {
    return { ok: false, code: "not_allowed", reason: `"${from}" holds none of "${to}"'s permissions, so the delegation would grant nothing.` };
  }

  return { ok: true, permissions };
}

/** The delegation role for an actor, with what it may delegate to. */
export function roleForDelegation(actorId: string): { role: AgentRole; allowed: readonly AgentRole[] } {
  const role = roleForPersona(actorId);
  return { role, allowed: DELEGATION_RULES[role] ?? [] };
}

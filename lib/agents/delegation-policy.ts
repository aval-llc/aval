/**
 * Controlled delegation: the limits every hand-off of work is held to.
 *
 * This replaces a single integer. `MAX_DELEGATION_DEPTH = 2` allowed
 * coordinator → specialist → one more, which cannot express the organization:
 * Aval One → Lead → Specialist, and a Specialist asking a legitimate peer for
 * help. Raising the integer alone would have bought uncontrolled recursion, so
 * depth is now one limit among several, and each is enforced where the work is
 * created, not advised in a prompt.
 *
 * Depth counts the root as 0, which is how `agent_tasks.delegation_depth` has
 * always counted:
 *
 *   0  Aval One, or the customer AI Employee that owns the work
 *   1  a Lead, or a Specialist addressed directly
 *   2  a Specialist under a Lead
 *   3  a bounded peer or sub-problem that Specialist asked for
 *
 * The other limits live where their state lives:
 *
 *   fan-out and concurrency      here, checked at creation (goal-plan.ts, peer-help.ts)
 *   total size of one Work        here, counted by `agent_tasks.work_id`
 *   cycles                        delegation.ts, by walking the actors above
 *   duplicate sub-problems        work-identity.ts, reused rather than re-run
 *   token, step and time budget   carved from the parent's remaining allowance
 *   cancellation                  tasks.ts, cascaded down every generation
 *   authority                     task-boundary.ts, re-read on every tool call
 *   resource scope                inherited execution scope and employee scopes
 *   stagnation                    attempt-policy.ts, per task
 *
 * No runtime imports, so every module can depend on it without a cycle.
 */

import type { AgentRole } from "./permissions.ts";

export const DELEGATION_POLICY = {
  /** Deepest a task may sit below its root. */
  maxDepth: 3,
  /** Children one task may open in one plan or peer request. */
  maxFanout: 4,
  /** Children of one task that may be unfinished at the same time. */
  maxConcurrentChildren: 4,
  /** Every task in one Work, across every level and revision. */
  maxTasksPerWork: 24,
  /** Peer requests one task may make over its life. */
  maxPeerRequestsPerTask: 2,
  /** How long a task waiting on a peer sleeps before it checks again, if nothing woke it. */
  peerRecheckMs: 60_000,
  /**
   * The token ceiling of a root that coordinates work.
   *
   * Every hand-off gives the child half of what its parent has left, so a
   * Specialist two levels down holds a quarter of the root. Sized so that
   * Specialist holds what a single task always did (60k), and a bounded peer
   * beneath it half of that. A ceiling, not a spend: the workspace's own usage
   * caps are re-checked on every step (lib/ask-aval/usage.ts).
   */
  rootMaxTokens: 240_000,
} as const;

/** Kept under its historical name: callers compare depths against it. */
export const MAX_DELEGATION_DEPTH = DELEGATION_POLICY.maxDepth;

/**
 * The historical persona-to-persona pairs. Read as: the key delegates to the
 * values.
 *
 * Deliberately sparse. Each pair exists because there is a question the
 * delegator genuinely cannot answer with its own tools — not because the two
 * agents are topically adjacent. The organization (lib/agents/organization)
 * keeps every one of these edges; they are its Lead-to-Lead relationships.
 */
export const LEGACY_DELEGATION_RULES: Partial<Record<AgentRole, readonly AgentRole[]>> = {
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

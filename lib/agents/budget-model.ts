/**
 * Execution budgets for the organization, by the work each actor owns.
 *
 * The model this replaces gave every hand-off half of what its parent had
 * left and took it from the parent. That made a worker's budget a function of
 * its depth and of the order it was created in, not of its work: from a
 * 60-step root, a Lead fanning out to four Specialists left each about two
 * steps, and a replan split what was left of what was left. Raising the root
 * (24 → 60) moved the cliff without removing it.
 *
 * Now each kind of spend has its own budget:
 *
 *   orchestration   Aval One or a Lead: planning, reading its children's
 *                   results, synthesising, one replan. The same at every depth.
 *   execution       a Specialist, sized by what its contract says it does
 *                   (organization/contract.ts): acting, verifying and repairing
 *                   costs more than reading and concluding.
 *   peer help       a bounded question to a peer: smaller than execution, since
 *                   it answers one question rather than owning a piece of work.
 *   retry           a tool's own retries run inside the step that called it
 *                   (registry `maxRetries`) and cost no step.
 *   replan          counted by the attempt policy ('replan'); a replan's turns
 *                   come out of the coordinator's orchestration steps, and the
 *                   replacement nodes are funded from the Work's pool.
 *   waiting         a task waiting on a child, a peer, an approval or a plan
 *                   dependency is parked without a model step (the early
 *                   returns in runtime.ts); a provider or party wait re-enters
 *                   on its event or recheck time, bounded by the Work's
 *                   deadline, and the hierarchy E2E asserts it spends no step
 *                   while parked.
 *
 * A grant is never taken from the parent, so delegating cannot starve the
 * delegator, and no worker is funded by its position in a queue. What bounds
 * the whole is the Work: every task in it, at every level and revision, draws
 * on one pool. A child the pool cannot fully fund is not started — a
 * Specialist is either given the budget its work needs or refused, never
 * opened with too little to finish — and the refusal tells the coordinator to
 * conclude with what it has.
 *
 * Pure: no storage. The reservation that applies it is in work-identity.ts.
 */

import { builtInActor, specialistById } from "./organization/index.ts";
import { specialistContract, type Readiness } from "./organization/contract.ts";

export interface Grant { steps: number; tokens: number }

export const BUDGET_MODEL = {
  orchestration: { steps: 12, tokens: 60_000 },
  execution: {
    EXECUTION_READY: { steps: 12, tokens: 60_000 },
    ANALYSIS_ONLY_READY: { steps: 8, tokens: 40_000 },
    // It can still read what exists and say plainly what it cannot do.
    INCOMPLETE: { steps: 6, tokens: 30_000 },
  } satisfies Record<Readiness, Grant>,
  peerHelp: { steps: 6, tokens: 30_000 },
  /**
   * Everything one Work may commit across every task, level and revision:
   * Aval One, two Leads, six Specialists and two peers at full budget.
   */
  work: { steps: 120, tokens: 600_000 },
} as const;

/**
 * The budget an actor's own work needs, whatever its depth. A Specialist is
 * sized by its contract; Aval One, a Lead, an employee acting through Aval One
 * and a historical single agent coordinate or run one bounded piece of work.
 */
export function grantFor(actorId: string, options: { peer?: boolean } = {}): Grant {
  const actor = builtInActor(actorId);
  const specialist = actor?.kind === "specialist" ? specialistById(actor.id) : null;
  const own: Grant = specialist ? BUDGET_MODEL.execution[specialistContract(specialist).readiness] : BUDGET_MODEL.orchestration;
  if (!options.peer) return { ...own };
  return { steps: Math.min(own.steps, BUDGET_MODEL.peerHelp.steps), tokens: Math.min(own.tokens, BUDGET_MODEL.peerHelp.tokens) };
}

export interface BudgetedTask { status: string; maxSteps: number; stepCount: number; maxTokens: number; tokensUsed: number }

const SETTLED = new Set(["COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"]);

/**
 * What a Work has committed: the whole grant of every unsettled task, and only
 * what a settled one actually spent. A node superseded by a replan, or one that
 * failed early, gives its unused budget back to the pool.
 */
export function committed(tasks: readonly BudgetedTask[]): Grant {
  return tasks.reduce<Grant>((total, task) => SETTLED.has(task.status)
    ? { steps: total.steps + Math.min(task.stepCount, task.maxSteps), tokens: total.tokens + Math.min(task.tokensUsed, task.maxTokens) }
    : { steps: total.steps + task.maxSteps, tokens: total.tokens + task.maxTokens }, { steps: 0, tokens: 0 });
}

/** Whether a Work with this much committed can fully fund these grants. */
export function workCanFund(alreadyCommitted: Grant, grants: readonly Grant[], pool: Grant = BUDGET_MODEL.work): boolean {
  const asked = grants.reduce<Grant>((total, grant) => ({ steps: total.steps + grant.steps, tokens: total.tokens + grant.tokens }), { steps: 0, tokens: 0 });
  return alreadyCommitted.steps + asked.steps <= pool.steps && alreadyCommitted.tokens + asked.tokens <= pool.tokens;
}

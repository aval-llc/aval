/**
 * Raw predicates for the task queries, built as pure values.
 *
 * Kept as a pure value so the wake-up predicate can be inspected separately
 * from the queue operation that uses it.
 */

import { sql, type SQL } from "drizzle-orm";
import { agentTasks } from "../../db/postgres/schema.ts";

/**
 * True for a parked task whose most recent approval request has been settled
 * or has run out of time — the two conditions that make it worth waking.
 *
 * Scoped to the *latest* step's request so an older, already-decided approval
 * cannot wake a task that is parked on a newer one.
 */
export function latestApprovalSettledPredicate(now: Date): SQL {
  return sql`exists (
        select 1 from agent_approvals a
        where a.task_id = ${agentTasks.id}
          and a.step_index = (select max(a2.step_index) from agent_approvals a2 where a2.task_id = ${agentTasks.id})
          and (a.status <> 'pending' or a.expires_at < ${now})
      )`;
}

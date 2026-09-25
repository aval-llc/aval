/**
 * The deployment narrowing's decisions, with no storage in them.
 *
 * Same split as `capability-rules.ts` / `capability.ts`: the rules are pure so
 * they can be read and tested without a database, and `deployments.ts` does the
 * reads that feed them. Both rules here are one line and both are easy to
 * invert by accident, which is exactly why they are worth isolating.
 */

import type { AutonomyMode } from "@/lib/agents/autonomy.ts";
import { type PmsWorkflow, workflowFor, type PmsAction } from "./types.ts";

const WORKFLOWS: readonly PmsWorkflow[] = ["maintenance", "arrears", "leasing", "reporting"];

export interface AgentDeployment {
  id: string;
  provider: string;
  /** Which workflows this deployment owns in this system. */
  workflows: readonly PmsWorkflow[];
  autonomyMode: AutonomyMode;
}

export function parseWorkflows(json: string): readonly PmsWorkflow[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // An unrecognised workflow name is dropped, not treated as a wildcard. A
    // typo in an operator's payload must never widen what an agent owns.
    return parsed.filter((value): value is PmsWorkflow =>
      typeof value === "string" && (WORKFLOWS as readonly string[]).includes(value)
    );
  } catch {
    return [];
  }
}

/** Does this deployment own the workflow that this action belongs to? */
export function deploymentOwnsAction(deployment: AgentDeployment, action: PmsAction): boolean {
  return deployment.workflows.includes(workflowFor(action));
}

/**
 * What assembly does when an agent has no deployment row.
 *
 * Every other gate in lib/pms fails closed, and absence never reads as
 * permission (enablement.ts: "a workspace that has never been asked has not
 * consented"). Applied literally to a table that ships empty, that would remove
 * PMS writes from every already-configured workspace on the migration, with no
 * operator action and no message — a silent revocation nobody asked for.
 *
 * So the opt-in is per workspace rather than per agent. An empty table is nobody
 * having migrated yet, and behaves as before. The first deployment row is the
 * workspace saying "we govern agents this way now", and from that moment an
 * agent without a row was left out deliberately and gets nothing.
 *
 * The consequence worth knowing: creating a workspace's first deployment
 * narrows every *other* agent in it at the same time. That is the intended
 * reading of the switch, and the settings surface has to say so plainly before
 * the first row is written.
 */
export function unconfiguredAgentMayUseEveryProvider(hasAnyDeployment: boolean): boolean {
  return !hasAnyDeployment;
}

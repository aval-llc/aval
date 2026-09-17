/**
 * Which system an agent works inside — the deployment narrowing's reads.
 *
 * `pmsToolAvailability()` resolved across every connected PMS and let the tool
 * carry a `provider` argument, so an org with AppFolio and DoorLoop offered both
 * to every agent and let the model pick. A deployment answers the question the
 * persona never did: *this* agent works in *that* system, owning *these*
 * workflows, at *this* autonomy level.
 *
 * Strictly tighter than what it replaces. Nothing downstream is rewritten,
 * because a narrowing can only remove tools from the assembled set.
 *
 * Reads only, and the decisions live in `deployment-rules.ts`. Creating and
 * pausing deployments is an operator action and belongs with the settings
 * surface, not here.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDeployments } from "@/db/schema";
import { type AgentDeployment, parseWorkflows } from "./deployment-rules.ts";

export {
  type AgentDeployment,
  deploymentOwnsAction,
  unconfiguredAgentMayUseEveryProvider,
} from "./deployment-rules.ts";

/**
 * The active deployments for one agent in one workspace.
 *
 * `paused` rows are excluded here rather than filtered later, so pausing a
 * deployment removes its tools from assembly — the operator's "take this agent
 * out of this system" means the tools stop existing, not that they start being
 * refused.
 */
export async function deploymentsForAgent(
  organizationId: string,
  personaId: string,
): Promise<readonly AgentDeployment[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentDeployments)
    .where(
      and(
        eq(agentDeployments.organizationId, organizationId),
        eq(agentDeployments.personaId, personaId),
        eq(agentDeployments.status, "active"),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    workflows: parseWorkflows(row.workflowsJson),
    autonomyMode: row.autonomyMode === "supervised" || row.autonomyMode === "autonomous"
      ? row.autonomyMode
      : "assisted",
  }));
}

/** Whether this workspace has configured deployments at all. */
export async function organizationHasDeployments(organizationId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: agentDeployments.id })
    .from(agentDeployments)
    .where(eq(agentDeployments.organizationId, organizationId))
    .limit(1);
  return row !== undefined;
}

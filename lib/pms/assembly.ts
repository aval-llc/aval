/**
 * Per-request assembly of the PMS write tools (docs/PMS_INTEGRATION.md, P0.3).
 *
 * The brief is specific that this is *assembly*, not filtering at call time, and
 * the distinction is the whole security property: a tool absent from the list
 * cannot be called by a confused model, a prompt injection, or a bug. For an
 * AppFolio org, `create_work_order` is not refused — it does not exist.
 *
 * `lib/agents/runtime.ts` already intersects two narrowings (the persona's
 * declared subset and the permission envelope). This is the third, and it is the
 * only one that varies per provider and per customer rather than per agent.
 *
 * Fails closed. Any error reading connections, grants or authorizations yields
 * an empty set, because the failure mode of a permissive default here is a write
 * into a customer's system of record that nobody authorized.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationConnections } from "@/db/schema";
import { PMS_PROVIDERS } from "./providers/index.ts";
import { resolveMatrix } from "./capability.ts";
import { actionForTool, PMS_WRITE_TOOL_NAMES } from "./tool-map.ts";
import type { PmsAction } from "./types.ts";
import { ensurePmsAdaptersRegistered } from "./register.ts";
import {
  type AgentDeployment,
  deploymentOwnsAction,
  deploymentsForAgent,
  organizationHasDeployments,
  unconfiguredAgentMayUseEveryProvider,
} from "./deployments.ts";

const PMS_PROVIDER_IDS = PMS_PROVIDERS.map((provider) => provider.id);

/** Which PMS providers this workspace has actually connected. */
export async function connectedPmsProviders(organizationId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ provider: integrationConnections.provider })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.organizationId, organizationId),
        eq(integrationConnections.status, "connected"),
        inArray(integrationConnections.provider, PMS_PROVIDER_IDS),
      ),
    );
  return rows.map((row) => row.provider);
}

export interface PmsToolAvailability {
  /** Tool names to include in this request's registry. */
  toolNames: ReadonlySet<string>;
  /**
   * Per tool, the providers it may target. The tool schema takes a `provider`
   * argument and the executor re-resolves against this — so a model naming a
   * provider it was not offered gets denied at execution as well as excluded
   * from assembly.
   */
  providersByTool: ReadonlyMap<string, readonly string[]>;
  /** Tools whose every execution needs a named human approval, no exceptions. */
  mandatoryApproval: ReadonlySet<string>;
}

const NONE: PmsToolAvailability = {
  toolNames: new Set(),
  providersByTool: new Map(),
  mandatoryApproval: new Set(),
};

/**
 * The fourth narrowing, now scoped to where this agent actually works.
 *
 * `personaId` is optional only so callers that have no agent in hand (the
 * settings matrix previewing a workspace) keep working. A real request always
 * passes one; omitting it skips the deployment narrowing and nothing else.
 */
export async function pmsToolAvailability(
  organizationId: string,
  personaId?: string,
): Promise<PmsToolAvailability> {
  ensurePmsAdaptersRegistered();
  try {
    let providers = await connectedPmsProviders(organizationId);
    if (providers.length === 0) return NONE;

    // Deployments narrow both which providers this agent may target and which
    // workflows it owns there. A deployment owning "maintenance" in DoorLoop
    // does not thereby own arrears in DoorLoop, nor maintenance in AppFolio.
    let deployments: readonly AgentDeployment[] | null = null;
    if (personaId !== undefined) {
      const forAgent = await deploymentsForAgent(organizationId, personaId);
      if (forAgent.length > 0) {
        deployments = forAgent;
        const deployed = new Set(forAgent.map((deployment) => deployment.provider));
        providers = providers.filter((provider) => deployed.has(provider));
      } else if (!unconfiguredAgentMayUseEveryProvider(await organizationHasDeployments(organizationId))) {
        // The workspace governs agents by deployment and this one has none.
        // Not an error and not a refusal — it was left out on purpose.
        return NONE;
      }
    }
    if (providers.length === 0) return NONE;

    const matrices = await Promise.all(
      providers.map(async (provider) => [provider, await resolveMatrix(organizationId, provider)] as const),
    );

    const toolNames = new Set<string>();
    const providersByTool = new Map<string, string[]>();
    const mandatoryApproval = new Set<string>();

    for (const toolName of PMS_WRITE_TOOL_NAMES) {
      const action = actionForTool(toolName) as PmsAction;
      for (const [provider, matrix] of matrices) {
        const resolution = matrix.get(action);
        if (resolution?.state !== "allow") continue;
        // Owning the provider is not owning every workflow inside it.
        if (deployments && !deployments.some((deployment) =>
          deployment.provider === provider && deploymentOwnsAction(deployment, action)
        )) continue;
        toolNames.add(toolName);
        const list = providersByTool.get(toolName) ?? [];
        list.push(provider);
        providersByTool.set(toolName, list);
        if (resolution.mandatoryApproval) mandatoryApproval.add(toolName);
      }
    }

    return { toolNames, providersByTool, mandatoryApproval };
  } catch {
    return NONE;
  }
}

/**
 * Whether one tool may target one provider for this org, re-resolved from
 * scratch.
 *
 * The executor calls this even though assembly already excluded the tool. That
 * is not redundant: assembly happened at the top of a turn that may have run for
 * minutes, and an authorization can be suspended in between. The cheap re-check
 * is what makes "revoke within one business day" mean revoke now.
 */
export async function pmsWriteAllowed(
  organizationId: string,
  providerId: string,
  toolName: string,
): Promise<{ allowed: boolean; reason?: string; mandatoryApproval: boolean }> {
  ensurePmsAdaptersRegistered();
  const action = actionForTool(toolName);
  if (!action) return { allowed: false, reason: `"${toolName}" is not a PMS write tool.`, mandatoryApproval: false };
  try {
    const matrix = await resolveMatrix(organizationId, providerId);
    const resolution = matrix.get(action);
    if (!resolution) return { allowed: false, reason: "Unknown action.", mandatoryApproval: false };
    return {
      allowed: resolution.state === "allow",
      reason: resolution.state === "allow" ? undefined : resolution.reason,
      mandatoryApproval: resolution.mandatoryApproval === true,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "Capability resolution failed.",
      mandatoryApproval: false,
    };
  }
}

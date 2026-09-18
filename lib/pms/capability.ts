/**
 * Capability resolution, with the I/O (docs/PMS_INTEGRATION.md, P0.3).
 *
 * The decision itself lives in `capability-rules.ts` and is pure. This module
 * gathers what that decision needs — grants, authorizations, learned flows,
 * registered adapters — and nothing else. Keeping the fetch here is what lets
 * every state in the matrix be asserted directly in tests/pms-capability.test.ts
 * without a D1 binding.
 */

import { PMS_ACTIONS, type CapabilityResolution, type PmsAction, type ResolutionContext } from "./types.ts";
import { pmsProvider } from "./providers/index.ts";
import { resolveWithContext, UNKNOWN_PROVIDER } from "./capability-rules.ts";
import { hasGrantProbe, readGrants } from "./grants.ts";
import { hasWriteAdapter, learnedFlowActions } from "./flows.ts";
import { readAllEnablements } from "./enablement.ts";
import type { DbSession } from "@/db/postgres/session";

const ALL_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat();
const WRITE_ACTIONS: readonly PmsAction[] = ALL_ACTIONS.filter((action) => !action.endsWith(".read"));

/**
 * Gathers the context for one provider in one round of queries.
 *
 * `executablePaths` folds the two mechanisms into one set: for an `api`
 * provider it is the registered adapters, for a `ui` provider the learned
 * flows. The rules do not need to know which, only whether a path exists.
 */
async function loadContext(dbSession: DbSession, organizationId: string, providerId: string): Promise<ResolutionContext> {
  const descriptor = pmsProvider(providerId);
  const mechanism = descriptor?.write.mechanisms[0];

  const [grants, enablements, learnedFlows] = await Promise.all([
    readGrants(dbSession, organizationId, providerId),
    readAllEnablements(dbSession, organizationId),
    // A provider with no `ui` mechanism has no flows to look up, so skip the query.
    mechanism === "ui" ? learnedFlowActions(dbSession, organizationId, providerId) : Promise.resolve(new Set<PmsAction>()),
  ]);

  const executablePaths = mechanism === "api"
    ? new Set(WRITE_ACTIONS.filter((action) => hasWriteAdapter(providerId, action)))
    : learnedFlows;

  return { grants, enablements, executablePaths, grantProbeImplemented: hasGrantProbe(providerId) };
}

/** The signature the brief specifies. Three queries; use `resolveMatrix` for many actions. */
export async function resolveCapability(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  action: PmsAction,
): Promise<CapabilityResolution> {
  const descriptor = pmsProvider(providerId);
  if (!descriptor) return UNKNOWN_PROVIDER;
  return resolveWithContext(descriptor, action, await loadContext(dbSession, organizationId, providerId));
}

/**
 * Every action for one provider, on one set of reads.
 *
 * This is what the settings matrix renders and what the per-request tool
 * registry assembles from, so it has to be one round of queries rather than one
 * per action.
 */
export async function resolveMatrix(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
): Promise<Map<PmsAction, CapabilityResolution>> {
  const descriptor = pmsProvider(providerId);
  const resolved = new Map<PmsAction, CapabilityResolution>();

  if (!descriptor) {
    for (const action of ALL_ACTIONS) resolved.set(action, UNKNOWN_PROVIDER);
    return resolved;
  }

  const context = await loadContext(dbSession, organizationId, providerId);
  for (const action of ALL_ACTIONS) resolved.set(action, resolveWithContext(descriptor, action, context));
  return resolved;
}

/** The actions an org may actually execute on a provider right now. */
export async function allowedActions(dbSession: DbSession, organizationId: string, providerId: string): Promise<PmsAction[]> {
  const matrix = await resolveMatrix(dbSession, organizationId, providerId);
  return [...matrix.entries()].filter(([, resolution]) => resolution.state === "allow").map(([action]) => action);
}

export { resolveWithContext } from "./capability-rules.ts";
export { emptyContext } from "./types.ts";

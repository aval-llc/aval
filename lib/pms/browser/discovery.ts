/**
 * What the customer's own PMS user can actually reach.
 *
 * A descriptor says what AppFolio is. A grant says what *this* login gives us,
 * and for a customer-authorized browser connection there is no API to ask — the
 * only honest way to find out is to open the provider as the person Aval is
 * signed in as and see what is there.
 *
 * Two rules carried over from `grants.ts` and worth restating, because a browser
 * makes both easier to get wrong:
 *
 *   - **Discovery reports facts and never enables anything.** Finding that the
 *     customer's user can create work orders yields `available`, not `enabled`.
 *     A workspace still has to authorize the action, and for a provider whose
 *     terms forbid automation it still needs the signed override. An inference
 *     drawn from a page must never be what puts a customer in breach of their
 *     own PMS contract.
 *   - **Absence is not denial.** A probe that could not run reports an error and
 *     an empty list, and the resolver treats un-probed as unknown, which
 *     resolves away from `allow`. Unknown defaults to no.
 *
 * What is *not* here: nothing enumerates the provider's own permission screens
 * or reads a role out of its admin UI. The probe asks whether the session can
 * reach each action Aval has a workflow for, which is the smallest question
 * that answers the resolver's.
 */

import { registerGrantProbe } from "../grants.ts";
import { PMS_ACTIONS, type GrantSet, type PmsAction } from "../types.ts";
import { browserAdapter } from "./adapter.ts";

const ALL_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat();

/**
 * Ask a browser provider what this connection can do.
 *
 * Registered per provider by `registerBrowserAdapter`, so a provider gains a
 * probe exactly when it gains a way to be driven — which is what stops
 * `grantProbeImplemented` from being a promise the code cannot keep.
 */
export async function probeBrowserGrants(providerId: string, organizationId: string): Promise<Omit<GrantSet, "probedAt" | "probed">> {
  const adapter = browserAdapter(providerId);
  if (!adapter) return { available: [], error: "No browser workflow is available for this provider." };

  const ctx = { organizationId, providerId, runnerId: "capability-probe" };

  const health = await adapter.healthCheck(ctx);
  if (!health.usable) {
    // Reachable and refusing, or not reachable at all. Either way this is not
    // evidence that the customer's user lacks the permission, so nothing is
    // recorded as unavailable — the probe simply did not happen.
    return { available: [], error: health.detail ?? `The connection is ${health.session}.` };
  }

  const preflight = await adapter.preflight(ctx);
  if (!preflight.ready && preflight.session === "PERMISSION_DENIED") {
    // This one *is* evidence: the provider said no to the session, not to the
    // network. An empty grant with no error is a fact about the role.
    return { available: [] };
  }
  if (!preflight.ready) return { available: [], error: preflight.reason ?? "The provider session is not ready." };

  return { available: ALL_ACTIONS.filter((action) => adapter.supports(action)) };
}

/** Wire a provider's probe. Called when its adapter registers. */
export function registerBrowserGrantProbe(providerId: string): void {
  registerGrantProbe(providerId, async (_dbSession, organizationId, provider) =>
    probeBrowserGrants(provider, organizationId));
}

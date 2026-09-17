/**
 * The capability decision, pure (docs/PMS_INTEGRATION.md, P0.3).
 *
 * Split from `capability.ts` the way this codebase splits `approval-rules.ts`
 * from `approvals.ts` and `health-rules.ts` from `health.ts`: the rules decide,
 * the module beside them fetches. These rules decide whether a write into a
 * customer's system of record exists at all, and a rule nobody can run tests
 * against is a rule nobody can trust.
 *
 * Four layers, all four must say yes: the provider supports the mechanism, the
 * provider's terms permit it, the customer's connection grants it, and the
 * workspace enabled it. Plus a fifth question that is ours rather than anyone
 * else's — have we actually built the path.
 *
 * Order is deliberate. A row reports the *most upstream* cause, because that is
 * the one whose removal would change anything: telling an AppFolio customer
 * their PMS role is too narrow is useless when the terms forbid the write
 * whatever the role says.
 *
 * On `unlearned` versus `blocked`: an unimplemented probe or an unbuilt path
 * resolves to `unlearned`, never `blocked`. Blocked is something the customer
 * cannot fix. Unlearned is Aval's backlog. Reporting the second as the first
 * tells an operator their provider forbids something when the truth is we have
 * not got to it, and that is a lie with a sales consequence.
 */

import {
  enablementFor,
  isReadAction,
  MANDATORY_HUMAN_CHECKPOINT,
  WORKFLOW_WRITE_DEFAULT,
  workflowFor,
  type CapabilityResolution,
  type PmsAction,
  type ProviderDescriptor,
  type ResolutionContext,
} from "./types.ts";

export const UNKNOWN_PROVIDER: CapabilityResolution = {
  state: "unavailable",
  reason: "Aval has no capability descriptor for this system.",
  remediation: "Connect a supported PMS, or use email notification capture.",
  owner: "aval",
};

function actionUnsupported(descriptor: ProviderDescriptor, action: PmsAction): boolean {
  return descriptor.unsupportedActions?.includes(action) ?? false;
}

function resolveRead(descriptor: ProviderDescriptor, action: PmsAction): CapabilityResolution {
  if (actionUnsupported(descriptor, action)) {
    return { state: "unavailable", reason: `${descriptor.displayName} exposes no source for this data.`, owner: "provider" };
  }
  if (!descriptor.read.supported) {
    return {
      state: "unavailable",
      reason: descriptor.read.reason ?? `${descriptor.displayName} has no readable surface.`,
      owner: "provider",
    };
  }
  if (!descriptor.read.permitted) {
    return {
      state: "blocked",
      reason: descriptor.read.reason ?? `${descriptor.displayName}'s terms do not permit automated reads.`,
      remediation: "Requires a signed authorization from the customer before it can be used.",
      owner: "provider",
    };
  }
  // Reads are on from day one for all four workflows — that shared envelope is
  // what makes the unified view real rather than four features side by side.
  // Notification capture has no grant to discover: the PMS either copies the
  // seat address or it does not, and if it does, we can read it.
  return { state: "allow", mechanism: descriptor.read.mechanisms[0] };
}

function resolveWrite(
  descriptor: ProviderDescriptor,
  action: PmsAction,
  context: ResolutionContext,
): CapabilityResolution {
  const workflow = workflowFor(action);
  const mechanism = descriptor.write.mechanisms[0];
  const runner = descriptor.write.runner;
  const mandatoryApproval = MANDATORY_HUMAN_CHECKPOINT.has(action) || undefined;
  const enablement = enablementFor(context.enablements, descriptor.id, action);
  const trail = { mandatoryApproval, mechanism, runner };

  if (WORKFLOW_WRITE_DEFAULT[workflow] === "none") {
    return {
      state: "unavailable",
      reason: "Reporting is a read-only workflow by design. Every figure comes from a deterministic query.",
      owner: "aval",
    };
  }

  if (actionUnsupported(descriptor, action) || !descriptor.write.supported || !mechanism) {
    return {
      state: "unavailable",
      reason: descriptor.write.reason ?? `${descriptor.displayName} has no write surface for this action.`,
      owner: "provider",
    };
  }

  // Terms first: no grant and no workspace setting can outrank them. The single
  // exception is a countersigned override, and it must be a real one — approved,
  // with the approver's id on the row.
  if (!descriptor.write.permitted) {
    const overridable = descriptor.write.override === "signed_authorization";
    if (!overridable || !enablement.signedAuthorization) {
      return {
        ...trail,
        state: "blocked",
        reason: descriptor.write.reason ?? `${descriptor.displayName}'s terms do not permit automated writes.`,
        remediation: overridable
          ? "A countersigned authorization from the customer is required before this can be enabled."
          : "Not overridable. Use a provider whose terms permit API writes.",
        owner: "provider",
      };
    }
  }

  // Our work, before anyone else's.
  if (!context.executablePaths.has(action)) {
    return {
      ...trail,
      state: "unlearned",
      reason: mechanism === "api"
        ? `Aval has not implemented the ${descriptor.displayName} adapter for this action yet.`
        : `Aval has not recorded a flow for this action on ${descriptor.displayName} yet.`,
      remediation: mechanism === "api"
        ? "On the Aval roadmap. Nothing for the customer to do."
        : "The agent will propose a flow for approval the first time this action is needed.",
      owner: "aval",
    };
  }
  if (!context.grantProbeImplemented) {
    return {
      ...trail,
      state: "unlearned",
      reason: `Aval cannot yet verify what a ${descriptor.displayName} connection grants.`,
      remediation: "On the Aval roadmap. Nothing for the customer to do.",
      owner: "aval",
    };
  }

  // A probe that errored is not a probe that found nothing: keeping them
  // distinct is what stops a transient outage reading as a narrowed PMS role.
  if (context.grants.error && !context.grants.probed) {
    return {
      ...trail,
      state: "blocked",
      reason: context.grants.error,
      remediation: "Reconnect the integration to re-check what it grants.",
      owner: "aval",
    };
  }
  if (!context.grants.probed) {
    return {
      ...trail,
      state: "blocked",
      reason: "Aval has not yet confirmed what this connection grants.",
      remediation: "Reconnect the integration to run grant discovery.",
      owner: "aval",
    };
  }
  if (!context.grants.available.includes(action)) {
    return {
      ...trail,
      state: "blocked",
      reason: `This ${descriptor.displayName} connection's role does not grant this action.`,
      remediation: "Widen the PMS role or API key scope for the Aval user, then reconnect.",
      owner: "customer",
    };
  }

  if (!enablement.enabled) {
    const needsSignature = WORKFLOW_WRITE_DEFAULT[workflow] === "off";
    return {
      ...trail,
      state: "off",
      reason: needsSignature
        ? `Available — enabling ${workflow} writes requires a signed authorization.`
        : "Available — not yet enabled for this workspace.",
      remediation: needsSignature
        ? "Record a countersigned authorization in Settings to enable it."
        : "Enable it in Settings.",
      owner: "customer",
    };
  }

  // A flagged-off workflow that is enabled still needs the signature on file.
  // The settings API refuses this combination too; the resolver refuses it
  // anyway, because a UI invariant is not an authorization control.
  if (WORKFLOW_WRITE_DEFAULT[workflow] === "off" && !enablement.signedAuthorization) {
    return {
      ...trail,
      state: "off",
      reason: `${workflow} writes are enabled but no countersigned authorization is on file.`,
      remediation: "Record who signed for it, and when, in Settings.",
      owner: "customer",
    };
  }

  return { state: "allow", ...trail };
}

/** The whole decision, for one action, given a gathered context. */
export function resolveWithContext(
  descriptor: ProviderDescriptor,
  action: PmsAction,
  context: ResolutionContext,
): CapabilityResolution {
  return isReadAction(action) ? resolveRead(descriptor, action) : resolveWrite(descriptor, action, context);
}

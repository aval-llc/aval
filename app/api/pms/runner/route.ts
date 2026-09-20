/**
 * POST /api/pms/runner — the desktop runner's only door into cloud.
 *
 * The customer-authorized browser path is split across two machines on purpose.
 * Cloud holds the database, the policy and the approvals, and decides whether a
 * write may happen. The customer's own machine holds the PMS session and is the
 * only place the provider can be driven. Neither half can do the other's job,
 * and this endpoint is the whole of what passes between them.
 *
 * Two intents, and the asymmetry between them is the security model:
 *
 *   `claim`  — cloud hands back a provider, an action and the steps of an
 *              **already approved** flow. There is no shape of request that
 *              gets arbitrary browser instructions out of this endpoint: the
 *              steps come from `pms_action_flows`, their digest is checked
 *              against what was approved, and the step vocabulary itself
 *              refuses selectors and coordinates. Cloud cannot tell the desktop
 *              to do something a person did not approve, even if cloud is
 *              compromised.
 *   `result` — the runner reports what happened, in a closed set of shapes. It
 *              cannot report what should follow: it does not settle Work, grant
 *              anything, or widen its own claim. A report naming a row it does
 *              not hold the lease on is refused.
 *
 * Everything is scoped to the caller's organization. `runner` names the device
 * for leases and audit; it is never an authority of its own, and a runner id
 * from one workspace cannot reach another's queue because the organization
 * comes from the session rather than the body.
 */

import type { DbSession } from "@/db/postgres/session";
import { getApiIdentity, isGuestIdentity } from "@/lib/integrations/session";
import { ensureOrganization } from "@/lib/integrations/organizations";
import { roleFor } from "@/lib/organizations/membership";
import { withApiSession } from "@/lib/api/with-session";
import {
  claimForRunner,
  reportRunnerResult,
  type RunnerReport,
} from "@/lib/pms/browser/drain.ts";
import type { ProviderSessionState } from "@/lib/pms/browser/adapter.ts";

const SESSION_STATES: readonly ProviderSessionState[] = [
  "NEW", "AUTHENTICATING", "ACTIVE", "EXPIRED", "MFA_REQUIRED",
  "PERMISSION_DENIED", "PROVIDER_CHANGED", "BLOCKED",
];

function text(value: unknown, max = 400): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined;
}

function sessionState(value: unknown): ProviderSessionState | null {
  return SESSION_STATES.includes(value as ProviderSessionState) ? (value as ProviderSessionState) : null;
}

/**
 * Read a report off the wire into the closed union the runtime acts on.
 *
 * Rejects rather than coerces. A malformed report from a compromised or simply
 * out-of-date runner must not become a settled write, and "nearly executed" is
 * not a state this path has.
 */
function parseReport(body: Record<string, unknown>): RunnerReport | string {
  const queueId = text(body.queueId, 64);
  if (!queueId) return "A report names the write it is about.";

  const kind = body.kind;
  if (kind === "not_ready") {
    const session = sessionState(body.session);
    if (!session) return "A not_ready report carries a known session state.";
    return { queueId, kind, session, reason: text(body.reason) };
  }

  if (kind === "duplicate") {
    const externalId = text(body.externalId, 200);
    if (!externalId) return "A duplicate report names the record it found.";
    const matchedOn = Array.isArray(body.matchedOn)
      ? body.matchedOn.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
      : [];
    return { queueId, kind, externalId, matchedOn };
  }

  if (kind === "executed") {
    const execution = body.execution as Record<string, unknown> | undefined;
    const verification = body.verification as Record<string, unknown> | undefined;
    if (!execution || typeof execution !== "object") return "An executed report carries its execution.";
    const session = sessionState(execution.session);
    if (!session) return "An execution carries a known session state.";
    return {
      queueId,
      kind,
      execution: {
        ok: execution.ok === true,
        externalId: text(execution.externalId, 200),
        error: text(execution.error),
        retryable: execution.retryable === true,
        session,
        // Page text is deliberately not read back here. It is untrusted data
        // the runner may log locally; nothing cloud decides depends on it, and
        // not accepting it is simpler than carrying it safely.
      },
      verification: {
        confirmed: verification?.confirmed === true,
        pending: verification?.pending === true,
        externalId: text(verification?.externalId, 200),
        detail: text(verification?.detail),
      },
    };
  }

  return "Unknown report kind.";
}

async function POSTWithSession(dbSession: DbSession, request: Request) {
  const identity = await getApiIdentity(dbSession, request);
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (isGuestIdentity(identity)) {
    // A guest is a read-only view of somebody else's workspace. Draining a
    // write queue is acting as the workspace.
    return Response.json({ error: "A guest session cannot run provider work" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  await ensureOrganization(dbSession, identity);
  const role = await roleFor(dbSession, identity.userId, identity.organizationId).catch(() => null);
  if (!role) return Response.json({ error: "No membership in this workspace" }, { status: 403 });

  const runner = text(body.runner, 64);
  if (!runner) return Response.json({ error: "A runner identifies the device holding the lease" }, { status: 400 });

  if (body.intent === "claim") {
    const claimed = await claimForRunner(dbSession, identity.organizationId, runner);
    return "instruction" in claimed
      ? Response.json({ instruction: claimed.instruction })
      : Response.json({ outcome: claimed.outcome });
  }

  if (body.intent === "result") {
    const report = parseReport(body);
    if (typeof report === "string") return Response.json({ error: report }, { status: 422 });
    const outcome = await reportRunnerResult(dbSession, identity.organizationId, runner, report);
    return Response.json({ outcome });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

export const POST = withApiSession(POSTWithSession);

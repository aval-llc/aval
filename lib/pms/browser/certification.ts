/**
 * Proving a provider driver against a real authorized session, in that order.
 *
 * The first time Aval touches a customer's actual property management system
 * is the moment with the least margin for error and the most temptation to
 * skip steps. So this harness exists before the session does, and its shape is
 * the argument: **reads are certified first, and a write cannot be attempted
 * until they have passed and somebody has separately authorized one.**
 *
 * The rule it enforces that nothing else does: the first live-provider test is
 * never an uncontrolled autonomous write. A write run refuses unless a
 * read-only run passed, an explicit authorization is present, and the action is
 * one this login was observed to reach. Any of them missing is a refusal rather
 * than a prompt.
 *
 * The second rule is about what a run may claim. A run proposes a certification
 * level and can never propose one above what it actually did: exercising a
 * simulator proves Aval's path and says nothing about a provider, so a
 * simulated run is capped at `simulator_e2e_tested` however much of it passed.
 * The cap is applied here rather than left to the caller, because the caller is
 * exactly who would be tempted.
 */

import { isReadAction, PMS_ACTIONS, type PmsAction } from "../types.ts";
import { pmsProvider } from "../providers/index.ts";
import type { Certification } from "../flows.ts";
import type { BrowserContext, ProviderDriver } from "./adapter.ts";
import type { FlowStep } from "./steps.ts";

const ALL_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat();

export interface CertificationStep {
  name: string;
  /** False is a failure; null is a step deliberately not attempted. */
  ok: boolean | null;
  detail?: string;
  at: string;
}

export interface CertificationRun {
  phase: "read_only" | "write";
  provider: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  steps: CertificationStep[];
  /** What the driver says it implements. */
  declared: PmsAction[];
  /** What this customer's login actually reached. */
  discovered: PmsAction[];
  /** Reachable but undeclared — the descriptor is behind the provider. */
  unexpected: PmsAction[];
  /** Declared but unreachable — this login is narrower than the driver assumes. */
  missing: PmsAction[];
  /** The highest level this run justifies. Never more than it did. */
  certification: Certification;
  /** Set when the run refused to start, rather than ran and failed. */
  refused?: string;
}

const now = () => new Date().toISOString();
const step = (name: string, ok: boolean | null, detail?: string): CertificationStep =>
  ({ name, ok, detail, at: now() });

function finish(
  phase: CertificationRun["phase"],
  provider: string,
  startedAt: string,
  steps: CertificationStep[],
  certification: Certification,
  extra: Partial<CertificationRun> = {},
): CertificationRun {
  return {
    phase,
    provider,
    startedAt,
    finishedAt: now(),
    // A step that was not attempted is not a failure. A step that failed is.
    passed: steps.every((entry) => entry.ok !== false),
    steps,
    declared: [],
    discovered: [],
    unexpected: [],
    missing: [],
    certification,
    ...extra,
  };
}

/**
 * What a passing run is allowed to claim.
 *
 * A simulator proves Aval's own path and nothing about a provider, so it is
 * capped regardless of outcome. A read-only run against a real authorized
 * session earns `customer_authorized_ui_tested` — Aval operated inside a real
 * customer's session and read real data. Only a verified write earns
 * `live_provider_tested`, because only a write proves the provider accepted
 * something and showed it back.
 */
export function certificationFor(
  phase: CertificationRun["phase"],
  simulated: boolean,
  passed: boolean,
): Certification {
  if (!passed) return "unimplemented";
  if (simulated) return "simulator_e2e_tested";
  return phase === "write" ? "live_provider_tested" : "customer_authorized_ui_tested";
}

/**
 * The read half. Safe against a real tenancy: it changes nothing.
 *
 * Runs to the end rather than stopping at the first failure, because the point
 * of a certification run is the report. A session that is up but discovers
 * nothing and a session that is down are different findings, and
 * short-circuiting would make them look the same.
 */
export async function runReadOnlyCertification(
  driver: ProviderDriver,
  ctx: BrowserContext,
): Promise<CertificationRun> {
  const startedAt = now();
  const steps: CertificationStep[] = [];
  const descriptor = pmsProvider(driver.provider);
  const simulated = driver.simulated === true;

  const status = await driver.sessionStatus(ctx).catch((error: unknown) => ({
    ready: false,
    session: "BLOCKED" as const,
    reason: error instanceof Error ? error.message : "The session could not be read.",
  }));
  steps.push(step("session", status.ready, status.reason ?? `session is ${status.session}`));

  const health = await driver.healthCheck(ctx).catch(() => null);
  steps.push(step("health", health ? health.usable : false, health?.detail));

  if (!status.ready) {
    // Everything below depends on a usable session. Recording them as "not
    // attempted" rather than failed keeps the report truthful: nobody learned
    // anything about the customer's PMS role from a session that was down.
    for (const name of ["capabilities", "properties", "units", "residents", "work_orders", "descriptor"]) {
      steps.push(step(name, null, "not attempted: no usable session"));
    }
    return finish("read_only", driver.provider, startedAt, steps, "unimplemented");
  }

  const found = await driver.discoverCapabilities(ctx).catch((error: unknown) => ({
    available: [] as PmsAction[],
    error: error instanceof Error ? error.message : "Discovery failed.",
  }));
  steps.push(step("capabilities", !found.error, found.error ?? `${found.available.length} reachable`));

  // The per-entity checks report *reachability*, not an exercise. Saying a
  // resident read was performed when only its capability was observed would be
  // the exact overstatement this harness exists to avoid.
  const reachable = new Set(found.available);
  for (const [name, action] of [
    ["properties", "reporting.financials.read"],
    ["units", "leasing.applications.read"],
    ["residents", "arrears.ledger.read"],
    ["work_orders", "maintenance.work_orders.read"],
  ] as const) {
    steps.push(reachable.has(action)
      ? step(name, null, `${action} is reachable; not exercised by this run`)
      : step(name, null, `${action} was not reachable for this login`));
  }

  const declared = [...driver.capabilities];
  const discovered = found.available.filter((action) => ALL_ACTIONS.includes(action));
  const unexpected = discovered.filter((action) => !declared.includes(action));
  const missing = declared.filter((action) => !discovered.includes(action));

  // A descriptor that disagrees with the provider is a finding, not a failure:
  // it is how Aval learns its own model is out of date. The run still passes,
  // and the difference is on the record for somebody to reconcile.
  steps.push(step(
    "descriptor",
    true,
    descriptor
      ? `${unexpected.length} reachable but undeclared, ${missing.length} declared but unreachable`
      : "no provider descriptor to compare against",
  ));

  const run = finish("read_only", driver.provider, startedAt, steps, "unimplemented",
    { declared, discovered, unexpected, missing });
  return { ...run, certification: certificationFor("read_only", simulated, run.passed) };
}

export interface WriteCertificationRequest {
  /** The read-only run this is allowed to follow. */
  readOnly: CertificationRun;
  /** The action to exercise. */
  action: PmsAction;
  /** Proof somebody authorized a write against a real tenancy. */
  authorizedBy: string | null;
  /** The record to create, and the steps to create it with. */
  payload: unknown;
  steps: readonly FlowStep[];
  /** Called only after verification, and only if the caller authorized cleanup. */
  cleanUp?: (externalId: string) => Promise<void>;
}

/**
 * The write half, and the things it refuses to start without.
 *
 * A write against a customer's real system is the first action Aval takes that
 * somebody else has to live with. Each guard is a way this has gone wrong for
 * somebody: certifying writes without reads, an "exploratory" write nobody
 * signed for, and a test that reached for the most convenient action rather
 * than one the login was known to have.
 */
export async function runWriteCertification(
  driver: ProviderDriver,
  ctx: BrowserContext,
  request: WriteCertificationRequest,
): Promise<CertificationRun> {
  const startedAt = now();
  const simulated = driver.simulated === true;
  const refuse = (reason: string): CertificationRun => ({
    ...finish("write", driver.provider, startedAt, [step("preconditions", false, reason)], "unimplemented"),
    refused: reason,
  });

  if (request.readOnly.phase !== "read_only" || !request.readOnly.passed) {
    return refuse("Reads have not been certified against this session. A write is not the first thing to try.");
  }
  if (request.readOnly.provider !== driver.provider) {
    return refuse("The read-only certification was for a different provider.");
  }
  if (!request.authorizedBy) {
    return refuse("No one has authorized a write against this tenancy.");
  }
  if (isReadAction(request.action)) {
    return refuse("That is a read. Use the read-only certification.");
  }
  if (!driver.capabilities.includes(request.action)) {
    return refuse("This driver does not implement that action.");
  }
  if (!request.readOnly.discovered.includes(request.action)) {
    // The login could not reach it during the read run, so a write would be
    // testing a permission the customer does not have.
    return refuse("This login did not reach that action during the read-only run.");
  }

  const steps: CertificationStep[] = [step("preconditions", true, `authorized by ${request.authorizedBy}`)];

  // Look before writing, exactly as the drain does. A certification run that
  // created a second record because it skipped reconciliation would be a
  // demonstration of the wrong thing.
  let existing: { externalId: string } | null = null;
  try {
    existing = await driver.reconcile(request.action, request.payload, ctx);
    steps.push(step("reconcile_before", true, existing ? `already present as ${existing.externalId}` : "nothing present"));
  } catch (error) {
    steps.push(step("reconcile_before", false, error instanceof Error ? error.message : "the duplicate check failed"));
    return finish("write", driver.provider, startedAt, steps, "unimplemented");
  }
  if (existing) {
    steps.push(step("execute", null, "not attempted: the record already exists"));
    const run = finish("write", driver.provider, startedAt, steps, "unimplemented");
    return { ...run, certification: certificationFor("write", simulated, run.passed) };
  }

  const execution = await driver.execute(request.action, request.steps, request.payload, ctx);
  steps.push(step("execute", execution.ok, execution.error ?? execution.externalId));
  if (!execution.ok) {
    return finish("write", driver.provider, startedAt, steps, "unimplemented");
  }

  const verification = await driver.verify(request.action, execution, request.payload, ctx);
  steps.push(step("verify", verification.confirmed, verification.detail ?? verification.externalId));

  // Cleanup is the caller's decision and only ever runs after verification.
  // Removing a record Aval could not confirm it created is how a certification
  // run deletes something that was already there.
  const externalId = verification.externalId ?? execution.externalId;
  if (verification.confirmed && request.cleanUp && externalId) {
    try {
      await request.cleanUp(externalId);
      steps.push(step("clean_up", true, `removed ${externalId}`));
    } catch (error) {
      // A test record left behind is untidy; a failed cleanup reported as
      // success is a lie about somebody's data.
      steps.push(step("clean_up", false, error instanceof Error ? error.message : "cleanup failed"));
    }
  } else {
    steps.push(step("clean_up", null,
      request.cleanUp ? "not attempted: the write was not confirmed" : "no cleanup was authorized"));
  }

  const run = finish("write", driver.provider, startedAt, steps, "unimplemented", {
    declared: [...driver.capabilities],
    discovered: request.readOnly.discovered,
  });
  return { ...run, certification: certificationFor("write", simulated, run.passed) };
}

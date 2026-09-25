import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSimulator } from "../lib/pms/browser/simulator.ts";
import {
  certificationFor,
  runReadOnlyCertification,
  runWriteCertification,
  type CertificationRun,
} from "../lib/pms/browser/certification.ts";

/**
 * The harness that exists before the first real session does.
 *
 * Most of what is asserted here is a refusal, because the value of this thing
 * is entirely in what it will not do: the first live-provider test must never
 * be an uncontrolled autonomous write.
 */

const ACTION = "maintenance.work_order.create";
const CTX = { organizationId: "org_1", providerId: "appfolio", runnerId: "certification" };
const STEPS = [
  { kind: "open", page: "Maintenance" },
  { kind: "click", button: "New Work Order" },
  { kind: "fill", label: "Unit", from: "unit" },
  { kind: "click", button: "Create Work Order" },
  { kind: "capture", label: "Work Order #", as: "externalId" },
] as const;

function ready() {
  const simulator = new BrowserSimulator("appfolio", [ACTION]);
  simulator.signIn();
  return simulator;
}

/**
 * A driver whose session is fine and whose login is narrow.
 *
 * The simulator cannot express this: a permission fault there stops the session
 * itself, which is a different finding. What is wanted here is the common real
 * case — signed in perfectly well, with a PMS role narrower than the driver
 * assumes.
 */
function narrowLogin(declared: string[], reaches: string[]) {
  return {
    provider: "appfolio",
    accessModes: ["customer_desktop_session"] as const,
    capabilities: declared as never,
    simulated: true,
    sessionStatus: async () => ({ ready: true, session: "ACTIVE" as const }),
    recoverSession: async () => ({ session: "ACTIVE" as const, recovered: true }),
    healthCheck: async () => ({ session: "ACTIVE" as const, usable: true, checkedAt: new Date() }),
    discoverCapabilities: async () => ({ available: reaches as never }),
    reconcile: async () => null,
    execute: async () => ({ ok: true, session: "ACTIVE" as const }),
    verify: async () => ({ confirmed: true }),
  } as never;
}

const named = (run: CertificationRun, name: string) => run.steps.find((entry) => entry.name === name);

test("a read-only run changes nothing and reports what it found", async () => {
  const simulator = ready();
  const run = await runReadOnlyCertification(simulator, CTX);

  assert.equal(run.phase, "read_only");
  assert.equal(run.passed, true);
  assert.equal(simulator.external.length, 0, "a read-only run writes nothing");
  assert.equal(simulator.submits, 0);
  assert.deepEqual(run.discovered, [ACTION]);
});

test("a run that could not use the session says so, and claims nothing", async () => {
  // Never signed in. The session step fails and everything past it is recorded
  // as not attempted, because nothing was learned about the customer's role.
  const run = await runReadOnlyCertification(new BrowserSimulator("appfolio", [ACTION]), CTX);
  assert.equal(run.passed, false);
  assert.equal(named(run, "session")?.ok, false);
  assert.equal(named(run, "capabilities")?.ok, null, "not attempted is not the same as failed");
  assert.match(named(run, "residents")?.detail ?? "", /not attempted/);
  assert.equal(run.certification, "unimplemented");
});

test("per-entity checks report reachability and say they were not exercised", async () => {
  // The overstatement this harness exists to avoid: claiming a resident read
  // happened when only its capability was observed.
  const run = await runReadOnlyCertification(ready(), CTX);
  for (const name of ["properties", "units", "residents", "work_orders"]) {
    assert.equal(named(run, name)?.ok, null, `${name} is not a pass or a fail`);
  }
  assert.match(named(run, "work_orders")?.detail ?? "", /not reachable|not exercised/);
});

test("a descriptor that disagrees with the provider is a finding, not a failure", async () => {
  // A login that reaches less than the driver declares is how Aval learns its
  // own model is out of date. The run still passes and the gap is on the record.
  const run = await runReadOnlyCertification(
    narrowLogin([ACTION, "maintenance.work_order.close"], [ACTION, "arrears.ledger.read"]),
    CTX,
  );

  assert.equal(run.passed, true, "a disagreement is reported, not failed");
  assert.deepEqual(run.missing, ["maintenance.work_order.close"], "declared but out of reach");
  assert.deepEqual(run.unexpected, ["arrears.ledger.read"], "reachable but undeclared");
  assert.match(named(run, "descriptor")?.detail ?? "", /1 reachable but undeclared, 1 declared but unreachable/);
});

test("exercising a simulator can never claim to have exercised a provider", () => {
  // The cap lives in the harness rather than with the caller, because the
  // caller is exactly who would be tempted.
  assert.equal(certificationFor("read_only", true, true), "simulator_e2e_tested");
  assert.equal(certificationFor("write", true, true), "simulator_e2e_tested");
  // And only a verified write against a real provider is live.
  assert.equal(certificationFor("read_only", false, true), "customer_authorized_ui_tested");
  assert.equal(certificationFor("write", false, true), "live_provider_tested");
  assert.equal(certificationFor("write", false, false), "unimplemented");
});

test("a write refuses to be the first thing tried", async () => {
  const simulator = ready();
  const request = { action: ACTION as never, authorizedBy: "user_1", payload: { unit: "4B" }, steps: STEPS as never };

  // No read-only run at all.
  const unproven = await runWriteCertification(simulator, CTX, {
    ...request,
    readOnly: { phase: "read_only", passed: false, provider: "appfolio", discovered: [] } as unknown as CertificationRun,
  });
  assert.equal(unproven.passed, false);
  assert.match(unproven.refused ?? "", /not the first thing to try/i);
  assert.equal(simulator.submits, 0, "and nothing was submitted while refusing");
});

test("a write refuses without someone who authorized it", async () => {
  const simulator = ready();
  const readOnly = await runReadOnlyCertification(simulator, CTX);
  const outcome = await runWriteCertification(simulator, CTX, {
    readOnly, action: ACTION as never, authorizedBy: null, payload: { unit: "4B" }, steps: STEPS as never,
  });
  assert.match(outcome.refused ?? "", /No one has authorized/i);
  assert.equal(simulator.submits, 0);
});

test("a write refuses an action this login was never seen to reach", async () => {
  // Signed in, but the role is narrower than the driver. Writing anyway would
  // be testing a permission the customer does not have.
  const driver = narrowLogin([ACTION], ["arrears.ledger.read"]);
  const readOnly = await runReadOnlyCertification(driver, CTX);

  const outcome = await runWriteCertification(driver, CTX, {
    readOnly, action: ACTION as never, authorizedBy: "user_1", payload: { unit: "4B" }, steps: STEPS as never,
  });
  assert.match(outcome.refused ?? "", /did not reach that action/i);
});

test("an authorized write looks before it writes, and verifies after", async () => {
  const simulator = ready();
  const readOnly = await runReadOnlyCertification(simulator, CTX);
  const run = await runWriteCertification(simulator, CTX, {
    readOnly, action: ACTION as never, authorizedBy: "user_1",
    payload: { unit: "4B", description: "Certification run" }, steps: STEPS as never,
  });

  assert.equal(run.passed, true, JSON.stringify(run.steps));
  assert.equal(named(run, "reconcile_before")?.ok, true, "it looked first");
  assert.equal(named(run, "execute")?.ok, true);
  assert.equal(named(run, "verify")?.ok, true, "and read it back");
  assert.equal(simulator.submits, 1, "exactly one record");
  // A simulator run stays capped however well it went.
  assert.equal(run.certification, "simulator_e2e_tested");
});

test("cleanup runs only after a confirmed write, and never silently fails", async () => {
  const simulator = ready();
  const readOnly = await runReadOnlyCertification(simulator, CTX);
  const removed: string[] = [];
  const run = await runWriteCertification(simulator, CTX, {
    readOnly, action: ACTION as never, authorizedBy: "user_1",
    payload: { unit: "9Z" }, steps: STEPS as never,
    cleanUp: async (externalId) => { removed.push(externalId); },
  });
  assert.equal(removed.length, 1, "the test record was removed");
  assert.equal(named(run, "clean_up")?.ok, true);

  // A cleanup that throws is reported as a failure. A test record left behind
  // is untidy; a failed cleanup reported as success is a lie about data.
  const second = ready();
  const secondRead = await runReadOnlyCertification(second, CTX);
  const failed = await runWriteCertification(second, CTX, {
    readOnly: secondRead, action: ACTION, authorizedBy: "user_1",
    payload: { unit: "8Y" }, steps: STEPS as never,
    cleanUp: async () => { throw new Error("the provider refused the delete"); },
  });
  assert.equal(named(failed, "clean_up")?.ok, false);
  assert.equal(failed.passed, false);
});

test("without authorized cleanup the record is left and the report says so", async () => {
  const simulator = ready();
  const readOnly = await runReadOnlyCertification(simulator, CTX);
  const run = await runWriteCertification(simulator, CTX, {
    readOnly, action: ACTION as never, authorizedBy: "user_1", payload: { unit: "7X" }, steps: STEPS as never,
  });
  assert.equal(named(run, "clean_up")?.ok, null);
  assert.match(named(run, "clean_up")?.detail ?? "", /no cleanup was authorized/i);
  assert.equal(simulator.external.length, 1, "which is honest: the record is still there");
});

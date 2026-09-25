import assert from "node:assert/strict";
import test from "node:test";
import { resolveWithContext } from "../lib/pms/capability-rules.ts";
import { pmsProvider } from "../lib/pms/providers/index.ts";
import { actionForTool, PMS_WRITE_TOOL_NAMES } from "../lib/pms/tool-map.ts";
import {
  emptyContext,
  PMS_ACTIONS,
  type Enablement,
  type PmsAction,
  type ProviderDescriptor,
  type ResolutionContext,
} from "../lib/pms/types.ts";

/**
 * The acceptance tests from docs/PMS_INTEGRATION.md.
 *
 * Every one of these asserts a *denial* the model cannot argue its way out of,
 * because the failure this layer exists to prevent is a write into a customer's
 * system of record that their PMS contract forbids. The pure resolver means each
 * state is asserted directly rather than inferred from mocks.
 */

const WRITE_ACTIONS: readonly PmsAction[] = Object.values(PMS_ACTIONS).flat().filter((a) => !a.endsWith(".read"));

function approved(overrides: Partial<Enablement> = {}): Enablement {
  return {
    enabled: true,
    signedAuthorization: false,
    approvedByUserId: "user_1",
    approvedAt: new Date("2026-09-17T00:00:00Z"),
    status: "approved",
    authorizationReference: null,
    ...overrides,
  };
}

/** A context where every layer except the descriptor says yes. */
function permissive(descriptor: ProviderDescriptor, actions: readonly PmsAction[] = WRITE_ACTIONS): ResolutionContext {
  return {
    grants: { available: actions, probedAt: new Date().toISOString(), probed: true },
    enablements: new Map(actions.map((action) => [`${descriptor.id}:${action}`, approved({ signedAuthorization: true })])),
    executablePaths: new Set(actions),
    grantProbeImplemented: true,
  };
}

const appfolio = pmsProvider("appfolio")!;
const doorloop = pmsProvider("doorloop")!;

test("an AppFolio workspace is offered zero PMS write tools, even when every other layer says yes", () => {
  // The headline acceptance test. Grants probed and permissive, workspace
  // enabled, flows learned, signature on file — and still nothing, because the
  // terms are upstream of all of it.
  const context = { ...permissive(appfolio) };
  // Strip the signature: without it the override cannot apply.
  context.enablements = new Map(WRITE_ACTIONS.map((a) => [`appfolio:${a}`, approved({ signedAuthorization: false })]));

  const allowed = WRITE_ACTIONS.filter((action) => resolveWithContext(appfolio, action, context).state === "allow");
  assert.deepEqual(allowed, [], "an AppFolio org was offered a write tool");

  for (const toolName of PMS_WRITE_TOOL_NAMES) {
    const action = actionForTool(toolName)!;
    const resolution = resolveWithContext(appfolio, action, context);
    assert.notEqual(resolution.state, "allow", `"${toolName}" resolved to allow on AppFolio`);
  }
});

test("an AppFolio write is blocked by the clause, and the clause is what the operator is shown", () => {
  const resolution = resolveWithContext(appfolio, "maintenance.work_order.create", emptyContext());
  assert.equal(resolution.state, "blocked");
  assert.equal(resolution.owner, "provider");
  assert.match(resolution.reason ?? "", /5\.4\(ix\)/);
  // The runner is reported even while blocked, so the settings page can explain
  // where the write *would* run if it were ever authorized.
  assert.equal(resolution.runner, "desktop");
});

test("flipping only `permitted` makes the write tools appear", () => {
  // The brief's second acceptance test, and the reason `permitted` is one field
  // in one file: the day AppFolio's partner program opens, this is the diff.
  const permitted: ProviderDescriptor = { ...appfolio, write: { ...appfolio.write, permitted: true } };
  const context = permissive(permitted);

  for (const action of ["maintenance.work_order.create", "maintenance.work_order.close"] as PmsAction[]) {
    assert.equal(
      resolveWithContext(permitted, action, context).state,
      "allow",
      `${action} should be allowed once the terms permit it`,
    );
  }
  // And nothing else about the descriptor had to change.
  assert.equal(permitted.write.supported, appfolio.write.supported);
  assert.equal(permitted.write.runner, appfolio.write.runner);
});

test("a signed authorization is the only thing that opens a permitted:false write, and it must name its approver", () => {
  const withSignature = permissive(appfolio);
  assert.equal(resolveWithContext(appfolio, "maintenance.work_order.create", withSignature).state, "allow");

  // An enablement row that claims a signature without an approved status is not
  // an authorization. `enablementFor` would not produce this, but the resolver
  // must not depend on that.
  const unsigned = { ...withSignature };
  unsigned.enablements = new Map([
    ["appfolio:maintenance.work_order.create", approved({ signedAuthorization: false })],
  ]);
  assert.equal(resolveWithContext(appfolio, "maintenance.work_order.create", unsigned).state, "blocked");
});

test("all five states are reachable, and each names a different owner", () => {
  const seen = new Map<string, string | undefined>();

  // unavailable — reporting has no writes by design.
  const unavailable = resolveWithContext(doorloop, "reporting.financials.read" as PmsAction, emptyContext());
  assert.equal(unavailable.state, "allow", "reporting reads are on");
  const reportingWrite = resolveWithContext(
    { ...doorloop, unsupportedActions: ["maintenance.work_order.create"] },
    "maintenance.work_order.create",
    permissive(doorloop),
  );
  seen.set(reportingWrite.state, reportingWrite.owner);
  assert.equal(reportingWrite.state, "unavailable");

  // blocked — terms.
  const blocked = resolveWithContext(appfolio, "maintenance.work_order.create", emptyContext());
  seen.set(blocked.state, blocked.owner);

  // unlearned — nothing built yet. Aval's work, never dressed up as a refusal.
  const unlearned = resolveWithContext(doorloop, "maintenance.work_order.create", emptyContext());
  assert.equal(unlearned.state, "unlearned");
  assert.equal(unlearned.owner, "aval");
  assert.doesNotMatch(unlearned.reason ?? "", /prohibit|terms|permit/i, "unlearned must not read as a policy refusal");
  seen.set(unlearned.state, unlearned.owner);

  // off — everything permits it, the workspace has not enabled it.
  const offContext: ResolutionContext = {
    ...permissive(doorloop),
    enablements: new Map(),
  };
  const off = resolveWithContext(doorloop, "maintenance.work_order.create", offContext);
  assert.equal(off.state, "off");
  assert.equal(off.owner, "customer");
  seen.set(off.state, off.owner);

  // allow.
  const allow = resolveWithContext(doorloop, "maintenance.work_order.create", permissive(doorloop));
  assert.equal(allow.state, "allow");
  seen.set(allow.state, allow.owner);

  assert.deepEqual(
    [...seen.keys()].sort(),
    ["allow", "blocked", "off", "unavailable", "unlearned"],
    "not every state is reachable",
  );
});

test("a narrow PMS role blames the customer's role, not the provider's terms", () => {
  // Grants probed, and this action simply is not in them.
  const context: ResolutionContext = {
    ...permissive(doorloop, ["maintenance.work_order.close"]),
    executablePaths: new Set(WRITE_ACTIONS),
  };
  const resolution = resolveWithContext(doorloop, "maintenance.work_order.create", context);
  assert.equal(resolution.state, "blocked");
  assert.equal(resolution.owner, "customer");
  assert.match(resolution.remediation ?? "", /role|scope/i);
});

test("a failed grant probe is not read as a narrowed role", () => {
  // A transient outage must not look like a denial, or a customer spends an
  // afternoon widening a PMS role that was never the problem.
  const context: ResolutionContext = {
    grants: { available: [], probedAt: null, probed: false, error: "DoorLoop returned 503." },
    enablements: new Map(),
    executablePaths: new Set(WRITE_ACTIONS),
    grantProbeImplemented: true,
  };
  const resolution = resolveWithContext(doorloop, "maintenance.work_order.create", context);
  assert.equal(resolution.state, "blocked");
  assert.equal(resolution.owner, "aval");
  assert.match(resolution.reason ?? "", /503/);
});

test("arrears and leasing writes stay off without a signature, even where the provider permits them", () => {
  // Built completely, left off. The flag is the only difference between these
  // and maintenance — same descriptor, same context, same machinery.
  const context: ResolutionContext = {
    ...permissive(doorloop),
    enablements: new Map(
      WRITE_ACTIONS.map((action) => [`doorloop:${action}`, approved({ signedAuthorization: false })]),
    ),
  };

  assert.equal(resolveWithContext(doorloop, "maintenance.work_order.create", context).state, "allow");
  for (const action of ["arrears.payment.post", "leasing.application.send"] as PmsAction[]) {
    const resolution = resolveWithContext(doorloop, action, context);
    assert.equal(resolution.state, "off", `${action} must not be on without a signed authorization`);
    assert.match(resolution.reason ?? "", /authorization/i);
  }
});

test("applicant-facing leasing actions carry a mandatory approval that no context can remove", () => {
  // Fair Housing liability lands on the design partner, not on Aval, so this is
  // not an org setting. Asserted across every possible context shape.
  for (const context of [emptyContext(), permissive(doorloop)]) {
    for (const action of ["leasing.inquiry.reply", "leasing.application.send"] as PmsAction[]) {
      const resolution = resolveWithContext(doorloop, action, context);
      assert.equal(resolution.mandatoryApproval, true, `${action} lost its human checkpoint`);
    }
  }
});

test("no PMS action accepts a protected-class attribute", () => {
  // "If a tool's arguments could carry one, the tool is wrong." Checked on the
  // action taxonomy so a future action name cannot smuggle one in.
  const forbidden = /race|religio|national|origin|familial|disab|sex|gender|handicap|children|ethnic/i;
  for (const action of Object.values(PMS_ACTIONS).flat()) {
    assert.doesNotMatch(action, forbidden, `"${action}" names a protected-class concept`);
  }
  for (const tool of PMS_WRITE_TOOL_NAMES) {
    assert.doesNotMatch(tool, forbidden, `"${tool}" names a protected-class concept`);
  }
});

test("an undescribed provider resolves to unavailable, never to allow", () => {
  assert.equal(pmsProvider("some_pms_that_does_not_exist"), undefined);
});

test("an unassessed PMS can still be read through the seat but never written", () => {
  // The universality claim, as an assertion: a system nobody researched is
  // readable via notification capture and has no write path at all.
  const reapit = pmsProvider("reapit");
  assert.ok(reapit, "reapit should have a derived descriptor");
  assert.equal(reapit.read.supported, true);
  assert.equal(reapit.read.permitted, true);
  assert.deepEqual(reapit.read.mechanisms, ["notification"]);
  assert.equal(reapit.write.supported, false);

  assert.equal(resolveWithContext(reapit, "maintenance.work_orders.read", emptyContext()).state, "allow");
  const write = resolveWithContext(reapit, "maintenance.work_order.create", permissive(reapit));
  assert.equal(write.state, "unavailable");
  // Unassessed is not prohibited: no clause is quoted, because there is none.
  assert.match(write.reason ?? "", /not assessed/i);
});

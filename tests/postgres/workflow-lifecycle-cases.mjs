import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { pmsActionFlows } from "../../db/postgres/schema.ts";
import { listWorkflows, promoteFlow, recordFlow, transitionAllowed } from "../../lib/pms/flows.ts";

/**
 * How a provider workflow gets into service, and what stops it.
 *
 * A workflow drives a customer's own PMS as their own signed-in user. The
 * lifecycle exists so that no single act can take something from an idea to
 * doing that, and most of what is asserted here is a refusal.
 *
 * The interesting property of the transition table is what it omits: nothing
 * reaches `active` except from `testing`. A draft cannot be put into service,
 * and a workflow that broke cannot be waved back into it.
 */

const PROVIDER = "appfolio";
const ACTION = "maintenance.work_order.create";
const STEPS = [
  { kind: "open", page: "Maintenance" },
  { kind: "click", button: "New Work Order" },
  { kind: "fill", label: "Unit", from: "unit" },
  { kind: "click", button: "Create Work Order" },
  { kind: "capture", label: "Work Order #", as: "externalId" },
];

export async function runWorkflowLifecycleCases(t, { session, userA, userB }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(userB, (s) => work(s, s.identity.organizationId));
  const proven = { certification: "simulator_e2e_tested" };

  await t.test("the transition table refuses the shortcuts, not just the nonsense", () => {
    assert.equal(transitionAllowed("draft", "testing"), true);
    assert.equal(transitionAllowed("testing", "active"), true);
    // The one that matters: nothing goes from somebody's draft straight to
    // driving a customer's PMS.
    assert.equal(transitionAllowed("draft", "active"), false);
    // A workflow that broke goes back for work; it does not return to service
    // because somebody decided it was probably fine now.
    assert.equal(transitionAllowed("degraded", "active"), false);
    assert.equal(transitionAllowed("degraded", "testing"), true);
    assert.equal(transitionAllowed("active", "degraded"), true);
    assert.equal(transitionAllowed("disabled", "draft"), true);
  });

  await t.test("a workflow nobody has exercised cannot be put into service", async () => {
    // `recordFlow` claims nothing on a workflow's behalf: certification starts
    // at unimplemented, and that is a bar activation has to clear.
    const unproven = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA));
    await run((s, o) => promoteFlow(s, o, unproven.id, userA, "testing"));
    const refused = await run((s, o) => promoteFlow(s, o, unproven.id, userA, "active"));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /never been exercised/i);
    await run((s, o) => promoteFlow(s, o, unproven.id, userA, "disabled"));
  });

  await t.test("activation names its author and retires what it replaces", async () => {
    const first = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA, proven));
    await run((s, o) => promoteFlow(s, o, first.id, userA, "testing"));
    const promoted = await run((s, o) => promoteFlow(s, o, first.id, userA, "active"));
    assert.equal(promoted.ok, true, promoted.reason);

    const [row] = await run((s) => s.db.select().from(pmsActionFlows).where(eq(pmsActionFlows.id, first.id)));
    assert.equal(row.status, "active");
    assert.equal(row.promotedByUserId, userA, "activation is an act with an author");
    assert.ok(row.promotedAt);

    // A second version supersedes the first rather than racing it: two active
    // rows would make which one runs a matter of ordering.
    const second = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA, proven));
    assert.equal(second.version, first.version + 1, "versions accumulate");
    await run((s, o) => promoteFlow(s, o, second.id, userA, "testing"));
    const replaced = await run((s, o) => promoteFlow(s, o, second.id, userA, "active"));
    assert.equal(replaced.ok, true);
    assert.equal(replaced.retired, 1, "the version it replaced was taken out of service");

    const [previous] = await run((s) => s.db.select().from(pmsActionFlows).where(eq(pmsActionFlows.id, first.id)));
    assert.equal(previous.status, "disabled");
    await run((s, o) => promoteFlow(s, o, second.id, userA, "disabled"));
  });

  await t.test("a workflow Aval ships is usable everywhere and editable nowhere", async () => {
    // Seeded by migration with a null organization. Both workspaces see it;
    // neither may promote it, because promoting a shipped workflow is a
    // deployment rather than a request.
    const shipped = "flow_appfolio_work_order_create_v1";
    for (const scope of [run, other]) {
      const visible = await scope((s, o) => listWorkflows(s, o, PROVIDER));
      const seeded = visible.find((flow) => flow.id === shipped);
      assert.ok(seeded, "every workspace can see the workflow Aval ships");
      assert.equal(seeded.shipped, true);
      assert.equal(seeded.organizationId, null);
      // It says what has actually been proven, and what has not.
      assert.equal(seeded.certification, "simulator_e2e_tested");
      assert.equal(seeded.status, "draft", "it is not in service on anyone's behalf yet");
      assert.match(seeded.knownIssues, /simulator, not from AppFolio/i);
    }

    const refused = await run((s, o) => promoteFlow(s, o, shipped, userA, "testing"));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /deployment, not at runtime/i);
  });

  await t.test("one workspace cannot promote another workspace workflow", async () => {
    const mine = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA, proven));
    const theirs = await other((s, o) => promoteFlow(s, o, mine.id, userB, "testing"));
    assert.equal(theirs.ok, false, "and it is not told the workflow exists");
    assert.match(theirs.reason, /No such workflow/i);

    const [row] = await run((s) => s.db.select({ status: pmsActionFlows.status })
      .from(pmsActionFlows).where(eq(pmsActionFlows.id, mine.id)));
    assert.equal(row.status, "draft", "and nothing moved");
    await run((s, o) => promoteFlow(s, o, mine.id, userA, "disabled"));
  });

  await t.test("the listing carries what a person needs to judge a workflow", async () => {
    const detailed = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA, {
      ...proven,
      requiredRole: "A PMS user who can create maintenance work orders.",
      riskClass: "high",
      verificationStrategy: "read_after_write",
      reconciliationStrategy: "external_id",
      fallback: "email",
      knownIssues: "Unit picker differs on older tenancies.",
    }));

    const listed = (await run((s, o) => listWorkflows(s, o, PROVIDER))).find((flow) => flow.id === detailed.id);
    assert.ok(listed);
    assert.equal(listed.accessMode, "customer_desktop_session");
    assert.equal(listed.riskClass, "high");
    assert.equal(listed.verificationStrategy, "read_after_write");
    assert.equal(listed.reconciliationStrategy, "external_id");
    assert.equal(listed.fallback, "email", "what happens instead when this cannot run");
    assert.match(listed.requiredRole, /create maintenance work orders/);
    assert.match(listed.knownIssues, /older tenancies/);
    assert.equal(listed.promotedByUserId, null, "a draft has no promoter");
    await run((s, o) => promoteFlow(s, o, detailed.id, userA, "disabled"));
  });

  await t.test("a workflow that broke is degraded, which is not the same as switched off", async () => {
    const live = await run((s, o) => recordFlow(s, o, PROVIDER, ACTION, STEPS, userA, proven));
    await run((s, o) => promoteFlow(s, o, live.id, userA, "testing"));
    await run((s, o) => promoteFlow(s, o, live.id, userA, "active"));

    // The provider moved its screen. That is a thing that happened, not a
    // decision somebody made, and the two states are kept apart so the
    // difference between "look at this" and "we turned it off" survives.
    const degraded = await run((s, o) => promoteFlow(s, o, live.id, userA, "degraded"));
    assert.equal(degraded.ok, true);
    const backToService = await run((s, o) => promoteFlow(s, o, live.id, userA, "active"));
    assert.equal(backToService.ok, false, "a degraded workflow does not go straight back into service");
    assert.equal((await run((s, o) => promoteFlow(s, o, live.id, userA, "testing"))).ok, true);
    await run((s, o) => promoteFlow(s, o, live.id, userA, "disabled"));
  });

  await t.test("a recorded workflow still cannot carry a selector or a coordinate", async () => {
    // The vocabulary guard holds at the authoring boundary too: the lifecycle
    // governs *whether* a workflow runs, and the step rules govern what it can
    // possibly say.
    await assert.rejects(
      () => run((s, o) => recordFlow(s, o, PROVIDER, ACTION,
        [{ kind: "click", button: "Create", selector: "#submit" }], userA, proven)),
      /name things, they do not address them/i,
    );
  });
}

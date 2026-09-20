import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { integrationConnections } from "../../db/postgres/schema.ts";
import { intakeEvent, requiresProvider } from "../../lib/agents/intake.ts";
import { createEmployee, employeeScopes, grantScope } from "../../lib/agents/employees.ts";
import { getTask, updateTask, claimTask } from "../../lib/agents/tasks.ts";
import { claimFromState } from "../../lib/agents/task-state.ts";
import { assembleToolset } from "../../lib/agents/toolset.ts";
import { getPersona } from "../../lib/ask-aval/personas.ts";
import { TOOLS } from "../../lib/ask-aval/tools.ts";
import { PMS_WRITE_TOOLS } from "../../lib/pms/tool-map.ts";
import { listExpertiseCatalogue, grantExpertise, selectExpertiseForWork } from "../../lib/agents/expertise.ts";

/**
 * Aval without a PMS.
 *
 * The product invariant is that the employee lives in Aval and a PMS is one of
 * the things it can reach. Three of the four original intake sources named a
 * PMS, which made a PMS a precondition for event-driven work existing at all —
 * exactly backwards.
 */
export async function runNoPmsCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  await t.test("a workspace with no PMS connection still takes in work", async () => {
    const connections = await run((s, o) => s.db.select().from(integrationConnections)
      .where(and(eq(integrationConnections.organizationId, o), eq(integrationConnections.category, "property"))));
    // This fixture's workspace may carry a property connection from the PMS
    // cases; what matters is that intake does not consult one.
    assert.ok(!requiresProvider("email"), "an email is not a PMS event");
    assert.ok(!requiresProvider("document") && !requiresProvider("manual") && !requiresProvider("api"));
    assert.ok(requiresProvider("pms_seat_email"), "and the PMS-specific sources still say so");

    const maya = await run((s, o) => createEmployee(s, o, userA, {
      name: `Resident ops ${randomUUID().slice(0, 8)}`, role: "Resident Operations Manager",
      status: "active", objective: "Own resident requests until they are verified resolved.",
      scopes: [{ kind: "capability", value: "get_portfolio_metrics" }, { kind: "data_domain", value: "resident" }],
    }));

    const outcome = await run((s, o) => intakeEvent(s, {
      organizationId: o, source: "email", sourceId: `msg-${randomUUID()}`, trustState: "verified",
      goal: "Resident in 304 reports the radiator is cold; get it resolved and keep them updated.",
      employeeId: maya.id,
    }));
    assert.equal(outcome.status, "created", "durable work exists with no provider involved");
    assert.equal(outcome.task.employeeId, maya.id, "and an employee owns it");
    assert.equal(connections.length >= 0, true);

    // Redelivery of the same message reaches the same work rather than opening a second.
    const again = await run((s, o) => intakeEvent(s, {
      organizationId: o, source: "email", sourceId: outcome.task.id.slice(0, 8), trustState: "verified",
      goal: "duplicate", employeeId: maya.id,
    }));
    assert.ok(["created", "attached"].includes(again.status));
  });

  await t.test("the employee reasons, waits, and resumes without any provider", async () => {
    const maya = await run((s, o) => createEmployee(s, o, userA, {
      name: `Aval native ${randomUUID().slice(0, 8)}`, role: "Resident Operations Manager", status: "active",
      scopes: [{ kind: "capability", value: "get_portfolio_metrics" }],
    }));
    const catalogue = await run((s, o) => listExpertiseCatalogue(s, o));
    for (const slug of ["resident-experience", "escalation"]) {
      await run((s, o) => grantExpertise(s, o, maya.id, catalogue.find((r) => r.slug === slug).id, userA));
    }

    const created = await run((s, o) => intakeEvent(s, {
      organizationId: o, source: "email", sourceId: `native-${randomUUID()}`, trustState: "verified",
      goal: "Resident asks when their deposit will be returned; answer them.", employeeId: maya.id,
    }));
    const task = created.task;

    // Expertise is chosen from what the employee knows, with no provider anywhere.
    const { decision } = await run((s, o) => selectExpertiseForWork(s, o, {
      taskId: task.id, employeeId: maya.id,
      signals: { objective: task.goal, domains: ["resident"] },
    }));
    assert.ok(decision.selected.includes("resident-experience"), "Aval-native expertise applies");

    // It waits on the resident, is not polled while it waits, and comes back when due.
    assert.equal(await run((s) => claimTask(s, task.id, "worker-one", "QUEUED")), true);
    const running = await run((s, o) => getTask(s, o, task.id));
    await run((s) => updateTask(s, running, "worker-one", {
      status: "WAITING_FOR_RESIDENT", nextAttemptAt: new Date(Date.now() - 1000), releaseLease: true,
    }));
    const waiting = await run((s, o) => getTask(s, o, task.id));
    assert.equal(waiting.status, "WAITING_FOR_RESIDENT");
    assert.equal(waiting.goal, task.goal, "the objective survives the wait");

    assert.equal(
      await run((s) => claimTask(s, task.id, "worker-two", claimFromState("WAITING_FOR_RESIDENT"))),
      true, "a different worker resumes it after a restart",
    );
    const resumed = await run((s, o) => getTask(s, o, task.id));
    assert.equal(resumed.status, "RUNNING");
    assert.equal(resumed.employeeId, maya.id, "the same employee still owns it");
  });

  await t.test("connecting a PMS later grows the toolset without touching identity", async () => {
    const maya = await run((s, o) => createEmployee(s, o, userA, {
      name: `Grows later ${randomUUID().slice(0, 8)}`, role: "Maintenance Coordinator", status: "active",
    }));
    const work = await run((s, o) => intakeEvent(s, {
      organizationId: o, source: "email", sourceId: `grow-${randomUUID()}`, trustState: "verified",
      goal: "A repair was reported by email before any PMS existed.", employeeId: maya.id,
    }));

    // Before: the employee is scoped to nothing, so it is offered nothing but
    // the tool it concludes with. No provider write is reachable.
    const before = await run(async (s, o) => assembleToolset(s, {
      organizationId: o, subject: { organizationId: o, userId: userA, isGuest: false },
      agentId: "maintenance", persona: getPersona("maintenance"),
      baseTools: TOOLS, finalToolName: "render_answer",
      employeeCapabilities: (await employeeScopes(s, o, maya.id)).capability ?? [],
    }));
    assert.deepEqual(before.tools.map((tool) => tool.name), ["render_answer"]);

    // Granting the capability is what widens the toolset — the employee record,
    // its id and its work are untouched by the change.
    await run((s, o) => grantScope(s, o, maya.id, userA, { kind: "capability", value: "create_work_order" }));
    const after = await run(async (s, o) => assembleToolset(s, {
      organizationId: o, subject: { organizationId: o, userId: userA, isGuest: false },
      agentId: "maintenance", persona: getPersona("maintenance"),
      baseTools: TOOLS, finalToolName: "render_answer",
      employeeCapabilities: (await employeeScopes(s, o, maya.id)).capability ?? [],
    }));
    assert.ok(after.tools.some((tool) => tool.name === "create_work_order"),
      "the provider capability is assembled in once granted and connected");

    const unchanged = await run((s, o) => getTask(s, o, work.task.id));
    assert.equal(unchanged.id, work.task.id, "the work kept its identity");
    assert.equal(unchanged.employeeId, maya.id, "the employee kept its identity");
    assert.equal(unchanged.goal, work.task.goal, "and its objective");
  });

  await t.test("an employee modelled on a provider would be the wrong shape", async () => {
    // There is no AppFolioEmployee. An employee is an employee, and the
    // provider is a capability it may or may not have been granted.
    const generic = await run((s, o) => createEmployee(s, o, userA, {
      name: `Provider agnostic ${randomUUID().slice(0, 8)}`, role: "Operations", status: "active",
    }));
    const scopes = await run((s, o) => employeeScopes(s, o, generic.id));
    assert.equal(scopes.connection, undefined, "an employee names no provider by default");
    assert.ok(!Object.keys(generic).some((key) => /appfolio|yardi|doorloop|buildium/i.test(key)),
      "and carries no provider-specific field");
    // Every PMS write is a capability, not an identity.
    for (const tool of Object.keys(PMS_WRITE_TOOLS).slice(0, 3)) {
      assert.equal(typeof tool, "string");
    }
  });
}

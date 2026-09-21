import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { organizations, agentTasks as agentTasksRef } from "../../db/postgres/schema.ts";
import {
  createEmployee, listEmployees, getEmployee, updateEmployee, setEmployeeStatus,
  employeeCount, employeeScopes, grantScope, revokeScope, openWorkCount, reassignWork,
  canTransitionEmployee, EmployeeQuotaError, EmployeeHasOpenWorkError, InvalidEmployeeInputError,
} from "../../lib/agents/employees.ts";
import { createTask, getTask } from "../../lib/agents/tasks.ts";
import { assembleToolset } from "../../lib/agents/toolset.ts";
import { ancestorActors, delegationRefusal } from "../../lib/agents/delegation.ts";
import { employeeEnvelope, evaluate } from "../../lib/agents/policy.ts";
import { roleForPersona } from "../../lib/agents/permissions.ts";
import { TOOLS } from "../../lib/ask-aval/tools.ts";
import { getPersona } from "../../lib/ask-aval/personas.ts";

/**
 * AI employees as durable actors.
 *
 * The property worth proving is not that an employee can be created — it is
 * that nothing anywhere varies with how many exist. The hundred-and-first
 * employee is exercised through the identical schema, API, permission and
 * routing path as the first.
 */
export async function runEmployeeCases(t, { session, userA, userB, administrator }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(userB, (s) => work(s, s.identity.organizationId));

  await t.test("a customer invents a role the code has never heard of", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, {
      name: "Maya",
      role: "Resident Operations Manager",
      objective: "Own resident service requests across the Berkeley portfolio until they are verified resolved.",
      autonomyMode: "assisted",
    }));
    assert.equal(employee.role, "Resident Operations Manager");
    assert.equal(employee.status, "draft", "an employee starts inert");
    // Creating an employee grants nothing. Authority is added deliberately.
    assert.deepEqual(await run((s, org) => employeeScopes(s, org, employee.id)), {});
    assert.equal(employee.mayCommunicateExternally, false);
    assert.equal(employee.mayDelegate, false);
    assert.equal(employee.spendLimitCents, null, "an employee commits no money until told it may");

    for (const role of ["Turnover Coordinator", "Collections Assistant", "Vendor Coordinator", "Regional Operations Analyst"]) {
      const made = await run((s, org) => createEmployee(s, org, userA, { name: role, role }));
      assert.equal(made.role, role, `${role} needed no source change`);
    }
  });

  await t.test("employee #1 and employee #101 take the identical path", async () => {
    const before = await run((s, org) => employeeCount(s, org));
    const created = [];
    for (let index = 1; index <= 101; index++) {
      created.push(await run((s, org) => createEmployee(s, org, userA, {
        name: `Scale ${index}`, role: `Role ${index}`, objective: `Objective ${index}`,
      })));
    }
    assert.equal(created.length, 101);
    assert.equal(await run((s, org) => employeeCount(s, org)), before + 101);

    // Same schema, same shape, same resolution — the only difference is the row.
    const first = await run((s, org) => getEmployee(s, org, created[0].id));
    const hundredAndFirst = await run((s, org) => getEmployee(s, org, created[100].id));
    assert.deepEqual(Object.keys(first).sort(), Object.keys(hundredAndFirst).sort());
    assert.equal(first.status, hundredAndFirst.status);
    assert.equal(first.autonomyMode, hundredAndFirst.autonomyMode);

    // And the directory pages rather than assuming a small fixed roster.
    const page = await run((s, org) => listEmployees(s, org, { limit: 25 }));
    assert.equal(page.length, 25, "the directory pages");
    const searched = await run((s, org) => listEmployees(s, org, { search: "Scale 10" }));
    assert.ok(searched.length >= 2, "search finds Scale 10, 100 and 101");
  });

  await t.test("a quota is configuration, and absent by default", async () => {
    await other(async (s, org) => {
      assert.equal(
        (await s.db.select({ limit: organizations.aiEmployeeLimit }).from(organizations).where(eq(organizations.id, org)))[0].limit,
        null,
        "a workspace has no employee ceiling unless one is configured",
      );
    });

    const org = await other((_s, o) => o);
    await administrator.query("UPDATE public.organizations SET ai_employee_limit = 2 WHERE id = $1", [org]);
    await other((s, o) => createEmployee(s, o, userB, { name: "Quota one", role: "First" }));
    await other((s, o) => createEmployee(s, o, userB, { name: "Quota two", role: "Second" }));
    await assert.rejects(
      other((s, o) => createEmployee(s, o, userB, { name: "Quota three", role: "Third" })),
      (error) => error instanceof EmployeeQuotaError && error.limit === 2,
    );
    // Lifting the limit is a configuration change, not a deploy.
    await administrator.query("UPDATE public.organizations SET ai_employee_limit = NULL WHERE id = $1", [org]);
    const third = await other((s, o) => createEmployee(s, o, userB, { name: "Quota three", role: "Third" }));
    assert.ok(third.id);
  });

  await t.test("one workspace cannot see or reach another's employees", async () => {
    const mine = await run((s, org) => createEmployee(s, org, userA, { name: "Isolated", role: "Private" }));
    assert.equal(await other((s, org) => getEmployee(s, org, mine.id)), null, "not readable across the boundary");
    const theirs = await other((s, org) => listEmployees(s, org));
    assert.ok(!theirs.some((row) => row.id === mine.id));
  });

  await t.test("two employees in one workspace cannot share a name", async () => {
    await run((s, org) => createEmployee(s, org, userA, { name: "Unique Name", role: "First" }));
    await assert.rejects(run((s, org) => createEmployee(s, org, userA, { name: "Unique Name", role: "Second" })));
    // The same name in a different workspace is somebody else's business.
    assert.ok(await other((s, org) => createEmployee(s, org, userB, { name: "Unique Name", role: "Elsewhere" })));
  });

  await t.test("a nameless or roleless employee is refused", async () => {
    for (const bad of [{ name: "  ", role: "Something" }, { name: "Someone", role: "" }]) {
      await assert.rejects(run((s, org) => createEmployee(s, org, userA, bad)), InvalidEmployeeInputError);
    }
  });

  await t.test("authority is granted and revoked one piece at a time", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, {
      name: "Scoped", role: "Analyst",
      scopes: [{ kind: "property", value: "property-a" }, { kind: "capability", value: "get_portfolio_metrics" }],
    }));
    let scopes = await run((s, org) => employeeScopes(s, org, employee.id));
    assert.deepEqual(scopes.property, ["property-a"]);
    assert.deepEqual(scopes.capability, ["get_portfolio_metrics"]);
    assert.equal(scopes.connection, undefined, "a kind with no grant is absent, never empty-meaning-everything");

    await run((s, org) => grantScope(s, org, employee.id, userA, { kind: "property", value: "property-b" }));
    // Granting the same thing twice is one grant.
    await run((s, org) => grantScope(s, org, employee.id, userA, { kind: "property", value: "property-b" }));
    scopes = await run((s, org) => employeeScopes(s, org, employee.id));
    assert.deepEqual(scopes.property, ["property-a", "property-b"]);

    await run((s, org) => revokeScope(s, org, employee.id, { kind: "property", value: "property-a" }));
    scopes = await run((s, org) => employeeScopes(s, org, employee.id));
    assert.deepEqual(scopes.property, ["property-b"]);
    await assert.rejects(
      run((s, org) => grantScope(s, org, employee.id, userA, { kind: "invented", value: "x" })),
      InvalidEmployeeInputError,
    );
  });

  await t.test("lifecycle: pausing stops new work, archiving never orphans it", async () => {
    assert.equal(canTransitionEmployee("draft", "active"), true);
    assert.equal(canTransitionEmployee("archived", "active"), false, "archived is the end of the line");

    const employee = await run((s, org) => createEmployee(s, org, userA, { name: "Lifecycle", role: "Coordinator" }));
    const active = await run((s, org) => setEmployeeStatus(s, org, employee.id, "active"));
    assert.equal(active.status, "active");

    const task = await run(async (s, org) => {
      const created = await createTask(s, {
        organizationId: org, userId: userA, agentId: "maintenance", goal: "Owned work",
        check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
      });
      await s.db.update(agentTasksRef).set({ employeeId: employee.id }).where(eq(agentTasksRef.id, created.id));
      return created;
    });
    assert.equal(await run((s, org) => openWorkCount(s, org, employee.id)), 1);

    const paused = await run((s, org) => setEmployeeStatus(s, org, employee.id, "paused"));
    assert.equal(paused.status, "paused");
    assert.equal(await run((s, org) => openWorkCount(s, org, employee.id)), 1, "pausing preserves the work and its history");

    await run((s, org) => setEmployeeStatus(s, org, employee.id, "active"));
    await assert.rejects(
      run((s, org) => setEmployeeStatus(s, org, employee.id, "archived")),
      (error) => error instanceof EmployeeHasOpenWorkError && error.openWork === 1,
    );

    const successor = await run((s, org) => createEmployee(s, org, userA, { name: "Successor", role: "Coordinator", status: "active" }));
    assert.equal(await run((s, org) => reassignWork(s, org, employee.id, successor.id)), 1);
    assert.equal(await run((s, org) => openWorkCount(s, org, employee.id)), 0);
    assert.equal(await run((s, org) => openWorkCount(s, org, successor.id)), 1);
    assert.equal((await run((s, org) => getTask(s, org, task.id))).employeeId, successor.id, "the work kept its identity and changed hands");

    const archived = await run((s, org) => setEmployeeStatus(s, org, employee.id, "archived"));
    assert.equal(archived.status, "archived");
    await assert.rejects(run((s, org) => updateEmployee(s, org, employee.id, { role: "Rewritten" })), InvalidEmployeeInputError);
    assert.ok(await run((s, org) => getEmployee(s, org, employee.id)), "an archived employee is still part of the record");
  });

  await t.test("work records its owner at creation and keeps it across a restart", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, {
      name: "Durable owner", role: "Coordinator", status: "active",
    }));
    const task = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance", employeeId: employee.id,
      goal: "Owned from the start",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));
    assert.equal(task.employeeId, employee.id, "ownership is durable from creation");

    // A restart re-reads the row rather than re-deriving who owns it.
    const reloaded = await run((s, org) => getTask(s, org, task.id));
    assert.equal(reloaded.employeeId, employee.id);
    assert.equal(reloaded.goal, task.goal, "and the objective comes back with it");
  });

  await t.test("an employee's capability grants decide what its work is offered", async () => {
    // The join that makes scopes mean something: a grant of one capability is a
    // grant of exactly that one.
    const narrow = await run((s, org) => createEmployee(s, org, userA, {
      name: "Narrowly scoped", role: "Reader", status: "active",
      scopes: [{ kind: "capability", value: "get_portfolio_metrics" }],
    }));
    const scopes = await run((s, org) => employeeScopes(s, org, narrow.id));
    const { tools } = await run((s, org) => assembleToolset(s, {
      organizationId: org,
      subject: { organizationId: org, userId: userA, isGuest: false },
      agentId: "maintenance", persona: getPersona("maintenance"),
      baseTools: TOOLS, finalToolName: "render_answer",
      employeeCapabilities: scopes.capability ?? [],
      employeeId: narrow.id,
    }));
    const offered = new Set(tools.map((tool) => tool.name));
    assert.ok(offered.has("get_portfolio_metrics"), "the granted capability is offered");
    assert.ok(offered.has("render_answer"), "and the model can always conclude");
    assert.equal(offered.has("get_delinquent_accounts"), false, "an ungranted capability is absent");
    assert.equal(offered.size, 2, "nothing arrived that nobody granted");
    await run((s, org) => revokeScope(s, org, narrow.id, { kind: "capability", value: "get_portfolio_metrics" }));
    const revoked = await run((s, org) => assembleToolset(s, {
      organizationId: org,
      subject: { organizationId: org, userId: userA, isGuest: false },
      agentId: "maintenance", persona: getPersona("maintenance"),
      baseTools: TOOLS, finalToolName: "render_answer",
      employeeId: narrow.id,
      employeeCapabilities: scopes.capability ?? [],
    }));
    assert.deepEqual(revoked.tools.map(tool => tool.name), ["render_answer"], "fresh employee access overrides a stale capability snapshot");
    assert.equal(revoked.excluded.get_portfolio_metrics, "employee");
  });

  await t.test("an employee delegates only to colleagues it was granted", async () => {
    const maya = await run((s, org) => createEmployee(s, org, userA, {
      name: "Delegating Maya", role: "Resident Operations Manager", status: "active", mayDelegate: true,
    }));
    const david = await run((s, org) => createEmployee(s, org, userA, {
      name: "Delegate David", role: "Maintenance Coordinator", status: "active",
    }));
    const stranger = await run((s, org) => createEmployee(s, org, userA, {
      name: "Ungranted stranger", role: "Analyst", status: "active",
    }));
    const parent = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "general", employeeId: maya.id,
      goal: "Own the resident issue",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));

    // Absence of a grant is never permission.
    assert.ok(await run((s, org) => delegationRefusal(s, org, parent, { agentId: "maintenance", employeeId: stranger.id })),
      "an employee with no delegate_to grants delegates to nobody");

    await run((s, org) => grantScope(s, org, maya.id, userA, { kind: "delegate_to", value: david.id }));
    assert.equal(await run((s, org) => delegationRefusal(s, org, parent, { agentId: "maintenance", employeeId: david.id })),
      null, "the granted colleague is reachable");
    assert.ok(await run((s, org) => delegationRefusal(s, org, parent, { agentId: "maintenance", employeeId: stranger.id })),
      "and granting one colleague did not grant the rest");
  });

  await t.test("delegation cannot close a loop back onto an ancestor", async () => {
    // Nothing prevented this before. MAX_DELEGATION_DEPTH bounded how long a
    // cycle could run, which is not the same as refusing one: A delegating to B
    // delegating back to A was legal, and merely shallow.
    const alice = await run((s, org) => createEmployee(s, org, userA, {
      name: "Cycle Alice", role: "Coordinator", status: "active", mayDelegate: true,
    }));
    const bob = await run((s, org) => createEmployee(s, org, userA, {
      name: "Cycle Bob", role: "Analyst", status: "active", mayDelegate: true,
    }));
    await run((s, org) => grantScope(s, org, alice.id, userA, { kind: "delegate_to", value: bob.id }));
    await run((s, org) => grantScope(s, org, bob.id, userA, { kind: "delegate_to", value: alice.id }));

    const root = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "general", employeeId: alice.id,
      goal: "Alice starts", check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));
    const child = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "general", employeeId: bob.id,
      goal: "Bob continues", check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
      parentTaskId: root.id, delegationDepth: 1,
    }));

    const ancestry = await run((s, org) => ancestorActors(s, org, child.id));
    assert.ok(ancestry.has(alice.id) && ancestry.has(bob.id), "the chain is visible from the child");

    const refusal = await run((s, org) => delegationRefusal(s, org, child, { agentId: "general", employeeId: alice.id }));
    assert.match(refusal ?? "", /loop/i, "Bob may not hand the work back to Alice");
    // And the mutual grant is genuinely there — the refusal is the cycle, not a
    // missing permission.
    const bobScopes = await run((s, org) => employeeScopes(s, org, bob.id));
    assert.deepEqual(bobScopes.delegate_to, [alice.id]);
  });

  await t.test("a role the code has never heard of holds real authority", async () => {
    // The point of the whole migration. `roleForPersona` resolves any
    // unrecognised id to the read-only `custom` envelope, so before employees a
    // customer-defined actor could only ever read — inventing "Turnover
    // Coordinator" got you something that could not turn over anything.
    assert.equal(roleForPersona("Turnover Coordinator"), "custom",
      "the persona path still collapses an invented role to read-only");

    const turnover = await run((s, org) => createEmployee(s, org, userA, {
      name: "Authority turnover", role: "Turnover Coordinator", status: "active",
      scopes: [
        { kind: "capability", value: "create_work_order" },
        { kind: "capability", value: "get_portfolio_metrics" },
      ],
    }));
    const scopes = await run((s, org) => employeeScopes(s, org, turnover.id));
    const envelope = employeeEnvelope(scopes.capability ?? [], {
      mayCommunicateExternally: turnover.mayCommunicateExternally,
    });
    assert.ok(envelope.includes("pms.maintenance.write"),
      "an employee granted the tool holds the permission that tool needs");

    // And the policy engine honours it where the persona path would not.
    const asEmployee = evaluate(
      "create_work_order", { provider: "doorloop" },
      { organizationId: "org", userId: userA, isGuest: false },
      { personaId: "Turnover Coordinator", employeePermissions: envelope, delegationDepth: 0 },
    );
    // High-risk tools still require a person; what matters is that authority is
    // no longer the thing refusing it.
    assert.notEqual(asEmployee.code, "permission_denied",
      `employee authority should not be the refusal: ${JSON.stringify(asEmployee)}`);

    const asPersona = evaluate(
      "create_work_order", { provider: "doorloop" },
      { organizationId: "org", userId: userA, isGuest: false },
      { personaId: "Turnover Coordinator", delegationDepth: 0 },
    );
    assert.equal(asPersona.code, "permission_denied",
      "the same invented role holds nothing without an employee record");
  });

  await t.test("an employee cannot hold a permission no granted tool needs", async () => {
    // The envelope is derived from grants, so there is nowhere to write an
    // authority that no tool actually uses.
    const reader = await run((s, org) => createEmployee(s, org, userA, {
      name: "Reader only", role: "Analyst", status: "active",
      scopes: [{ kind: "capability", value: "get_portfolio_metrics" }],
    }));
    const scopes = await run((s, org) => employeeScopes(s, org, reader.id));
    const envelope = employeeEnvelope(scopes.capability ?? [], { mayCommunicateExternally: false });
    assert.deepEqual(envelope, ["portfolio.read"], "exactly what the one granted tool requires");
    assert.ok(!envelope.includes("pms.maintenance.write"));
  });

  await t.test("external contact is a separate decision from holding the tool", async () => {
    // "May use the messaging tool" and "may contact a resident on the
    // workspace's behalf" are different grants, and conflating them is how an
    // employee ends up emailing people because somebody wanted it to read a
    // thread.
    const granted = ["send_external_message"];
    assert.deepEqual(employeeEnvelope(granted, { mayCommunicateExternally: false }), [],
      "the capability alone does not authorize contacting anyone");
    assert.deepEqual(employeeEnvelope(granted, { mayCommunicateExternally: true }), ["messaging.send.external"]);
  });

  await t.test("work is never handed to an employee that cannot run it", async () => {
    const from = await run((s, org) => createEmployee(s, org, userA, { name: "Handing over", role: "A", status: "active" }));
    const dormant = await run((s, org) => createEmployee(s, org, userA, { name: "Still a draft", role: "B" }));
    await assert.rejects(run((s, org) => reassignWork(s, org, from.id, dormant.id)), InvalidEmployeeInputError);
  });
}

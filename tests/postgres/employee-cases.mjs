import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { organizations, agentTasks as agentTasksRef } from "../../db/postgres/schema.ts";
import {
  createEmployee, listEmployees, getEmployee, updateEmployee, setEmployeeStatus,
  employeeCount, employeeScopes, grantScope, revokeScope, openWorkCount, reassignWork,
  canTransitionEmployee, EmployeeQuotaError, EmployeeHasOpenWorkError, InvalidEmployeeInputError,
} from "../../lib/agents/employees.ts";
import { createTask, getTask } from "../../lib/agents/tasks.ts";

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

  await t.test("work is never handed to an employee that cannot run it", async () => {
    const from = await run((s, org) => createEmployee(s, org, userA, { name: "Handing over", role: "A", status: "active" }));
    const dormant = await run((s, org) => createEmployee(s, org, userA, { name: "Still a draft", role: "B" }));
    await assert.rejects(run((s, org) => reassignWork(s, org, from.id, dormant.id)), InvalidEmployeeInputError);
  });
}

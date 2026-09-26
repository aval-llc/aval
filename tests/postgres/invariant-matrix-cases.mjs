import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTask, getTask, requestCancel } from "../../lib/agents/tasks.ts";
import { delegate } from "../../lib/agents/delegation.ts";
import { executeTool } from "../../lib/agents/executor.ts";
import { createEmployee, grantScope } from "../../lib/agents/employees.ts";
import { grantFor } from "../../lib/agents/budget-model.ts";
import { actorHolds } from "../../lib/agents/organization/index.ts";
import { withDbSession } from "../../db/postgres/session.ts";

/**
 * The same middleware invariants, asserted at every level of one real chain:
 *
 *   depth 0  Aval One
 *   depth 1  Lead (Maintenance)
 *   depth 2  Specialist (Work Order Creation)
 *   depth 3  a related Lead asked as a peer (Spend & Vendor)
 *
 * Every level executes through one function, executeTool, which re-reads
 * ancestry authority, employee grants, membership and policy on every call.
 * These probes call it at each level with the same inputs, so a level that
 * skipped a check would fail here by name.
 *
 * Every level is given checked work rather than a plan: a planner is refused
 * every operational tool before any other rule is reached ("a planner only
 * manages its plan"), which would make each probe below pass for that reason
 * instead of the one it names. Each denial's reason is asserted for the same
 * cause.
 */
const EVIDENCE = { kind: "evidence", tools: ["get_maintenance_performance"] };
const refusedFor = (outcome, pattern, label) => {
  assert.equal(outcome.result.status, "denied", `${label}: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.result.reason, pattern, `${label} was refused, but for: ${outcome.result.reason}`);
  assert.doesNotMatch(outcome.result.reason, /planner only manages/, `${label} was refused only because it is a planner`);
};
export async function runInvariantMatrixCases(t, { session, userA, userB, config, administrator }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const call = (task, toolName, args = {}) => run((s, org) => executeTool(s, { toolName, args, subject: { organizationId: org, userId: userA }, context: { personaId: task.agentId, delegationDepth: task.delegationDepth }, task: { id: task.id, stepIndex: 0 } }));

  async function chain(employeeId, as = { run, user: userA }) {
    const root = await as.run((s, org) => createTask(s, { organizationId: org, userId: as.user, agentId: "general", employeeId, goal: `Invariant root ${randomUUID()}`, check: EVIDENCE, maxSteps: 12, maxTokens: 60_000 }));
    const lead = await as.run((s) => delegate(s, root, "maintenance", `Coordinate ${randomUUID()}`, { check: EVIDENCE }));
    assert.equal(lead.ok, true, lead.reason);
    const specialist = await as.run((s) => delegate(s, lead.task, "maintenance.work-order-creation", `Raise a work order ${randomUUID()}`, { check: { kind: "evidence", tools: ["get_maintenance_performance"] } }));
    assert.equal(specialist.ok, true, specialist.reason);
    const peer = await as.run((s) => delegate(s, specialist.task, "lead.spend-vendor", `Vendor history ${randomUUID()}`, { scope: { peerOf: specialist.task.id }, check: { kind: "evidence", tools: ["get_vendors"] } }));
    assert.equal(peer.ok, true, peer.reason);
    return { "Aval One": root, Lead: lead.task, Specialist: specialist.task, peer: peer.task };
  }

  const plain = await chain(null);
  const levels = Object.entries(plain);

  await t.test("a permission nobody in the chain holds is refused at every level", async () => {
    for (const [level, task] of levels) {
      // pms.arrears.write: held by no actor in this chain (asserted, not assumed).
      assert.equal([plain["Aval One"], plain.Lead, plain.Specialist, plain.peer].some((row) => actorHolds(row.agentId, "pms.arrears.write")), false);
      refusedFor(await call(task, "post_payment", { lease_id: "l1", amount_cents: 100, currency: "USD" }), /does not grant|permission/i, level);
    }
  });

  await t.test("authority never widens: a level's own missing permission is refused even when an ancestor holds it", async () => {
    // Spend & Vendor, asked as a peer, does not hold pms.maintenance.write; the
    // Maintenance Lead above it does. Asking a peer must not become the way
    // around that.
    assert.equal(actorHolds("lead.spend-vendor", "pms.maintenance.write"), false);
    assert.equal(actorHolds("maintenance", "pms.maintenance.write"), true);
    refusedFor(await call(plain.peer, "create_work_order", { property_id: "p1", summary: "Leak" }), /permission|does not grant|not permitted/i, "peer");
  });

  await t.test("an act a level holds is gated by policy and approval at every level, never executed outright", async () => {
    for (const [level, task] of levels.filter(([, task]) => actorHolds(task.agentId, "pms.maintenance.write"))) {
      const outcome = await call(task, "create_work_order", { provider: "appfolio", property_id: "p1", summary: "Leak under the sink" });
      assert.notEqual(outcome.result.status, "ok", `${level} executed a PMS write with no connection, approval or matrix allow`);
    }
  });

  await t.test("another person's work cannot be driven from their workspace at any level", async () => {
    for (const [level, task] of levels) {
      refusedFor(await run((s, org) => executeTool(s, { toolName: "get_vendors", args: {}, subject: { organizationId: org, userId: userB }, context: { personaId: task.agentId }, task: { id: task.id, stepIndex: 0 } })), /does not belong/i, level);
    }
  });

  await t.test("peer help cannot close a loop back up the chain", async () => {
    const back = await run((s) => delegate(s, plain.peer, "maintenance.work-order-creation", "Ask the asker back"));
    assert.equal(back.ok, false);
    const toRoot = await run((s) => delegate(s, plain.peer, "maintenance", "Ask the Lead above"));
    assert.equal(toRoot.ok, false, "nor back to an ancestor Lead");
  });

  await t.test("an employee's grants bound every level of the work it owns, and are the only difference", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, { name: `Invariant ${randomUUID().slice(0, 8)}`, role: "Coordinator" }));
    await run((s, org) => grantScope(s, org, employee.id, userA, { kind: "capability", value: "get_maintenance_performance" }));
    const owned = await chain(employee.id);
    for (const [level, task] of Object.entries(owned)) {
      assert.equal(task.employeeId, employee.id, `${level} inherits its owner`);
      // Control: the same tool at the same level of the same chain without an
      // owner is not refused for authority — so the grant is the cause.
      const control = await call(plain[level], "get_vendors");
      assert.ok(control.result.status !== "denied" || !/does not grant|employee|capabilit/i.test(control.result.reason), `${level} control: ${JSON.stringify(control.result)}`);
      refusedFor(await call(task, "get_vendors"), /employee|capabilit|does not grant/i, level);
      const granted = await call(task, "get_maintenance_performance");
      assert.notEqual(granted.result.status === "denied" && /employee/i.test(granted.result.reason), true, `${level}: the granted capability is not refused as an employee grant`);
    }
  });

  await t.test("cancelling the root reaches every level before any further call", async () => {
    const doomed = await chain(null);
    await run((s, org) => requestCancel(s, org, doomed["Aval One"].id));
    for (const [level, task] of Object.entries(doomed)) {
      const fresh = await run((s, org) => getTask(s, org, task.id));
      assert.equal(fresh.cancelRequested, true, `${level} was asked to stop`);
      refusedFor(await call(fresh, "get_maintenance_performance"), /cancel|stopped/i, level);
    }
  });

  await t.test("revoking the person's membership stops every level from changing anything", async () => {
    // A second person, a member of this workspace by an explicit grant, owns
    // the Work. Their session is opened directly (no bootstrap), so removing
    // the membership row really leaves them a non-member.
    const org = await run(async (_s, organizationId) => organizationId);
    const person = `member_${randomUUID()}`;
    await session(person, async () => {});
    const membership = `membership_${randomUUID()}`;
    await administrator.query("insert into access_grants (id,organization_id,principal_id,role,organization_scope,created_at,updated_at) values ($1,$2,$3,'operator',true,now(),now())", [randomUUID(), org, person]);
    const template = (await administrator.query("select * from organization_members where organization_id=$1 and user_id=$2", [org, userA])).rows[0];
    const row = { ...template, id: membership, user_id: person, role: "operator" };
    const columns = Object.keys(row);
    await administrator.query(`insert into organization_members (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")})`, columns.map((column) => row[column]));
    const memberRun = (work) => withDbSession(config, { principalId: person, organizationId: org, actorId: person, requestId: randomUUID() }, (s) => work(s, org));
    const theirs = await chain(null, { run: memberRun, user: person });
    await administrator.query("delete from organization_members where id=$1", [membership]);
    for (const [level, task] of Object.entries(theirs)) {
      const outcome = await memberRun((s) => executeTool(s, { toolName: "record_preference", args: { topic: "reporting_style", statement: "keep_summaries_brief" }, subject: { organizationId: org, userId: person }, context: { personaId: task.agentId }, task: { id: task.id, stepIndex: 0 } }));
      refusedFor(outcome, /no longer a member|membership/i, level);
    }
  });

  await t.test("every level is funded for its own work", () => {
    assert.equal(plain.Lead.maxSteps, grantFor("maintenance").steps);
    assert.equal(plain.Specialist.maxSteps, grantFor("maintenance.work-order-creation").steps);
    assert.ok(plain.peer.maxSteps <= 6);
  });
}

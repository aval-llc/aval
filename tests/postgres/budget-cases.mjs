import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTasks } from "../../db/postgres/schema.ts";
import { createTask, getTask } from "../../lib/agents/tasks.ts";
import { delegate } from "../../lib/agents/delegation.ts";
import { BUDGET_MODEL, grantFor } from "../../lib/agents/budget-model.ts";
import { specialistsForDomain } from "../../lib/agents/organization/index.ts";

/**
 * The budget model through the real delegation path and the real Work-level
 * reservation: every worker funded for its own work whatever its depth or
 * position, the delegator never drained, a peer bounded, the Work's pool
 * binding — including when two delegations race for its last room.
 */
export async function runBudgetCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const root = () => run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "general", goal: `Budget root ${randomUUID()}`, check: { kind: "plan" }, maxSteps: grantFor("general").steps, maxTokens: grantFor("general").tokens }));
  const team = specialistsForDomain("maintenance").slice(0, 4).map((specialist) => specialist.id);
  const tasksInWork = (workId) => run((s) => s.db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.workId, workId)));

  await t.test("Aval One → Lead → four Specialists: each is funded in full and the Lead keeps its own budget", async () => {
    const top = await root();
    const lead = await run((s) => delegate(s, top, "maintenance", "Coordinate the maintenance backlog"));
    assert.equal(lead.ok, true, lead.reason);
    assert.deepEqual({ steps: lead.task.maxSteps, tokens: lead.task.maxTokens }, grantFor("maintenance"));
    for (const [index, specialist] of team.entries()) {
      const child = await run((s) => delegate(s, lead.task, specialist, `Backlog piece ${index + 1}`));
      assert.equal(child.ok, true, child.reason);
      assert.deepEqual({ steps: child.task.maxSteps, tokens: child.task.maxTokens }, grantFor(specialist), `Specialist ${index + 1} gets its full grant`);
    }
    assert.equal((await run((s, org) => getTask(s, org, lead.task.id))).maxSteps, lead.task.maxSteps, "delegating took nothing from the Lead");
    assert.equal((await run((s, org) => getTask(s, org, top.id))).maxSteps, top.maxSteps, "nor from Aval One");
  });

  await t.test("Aval One → Lead → Specialist → peer: the peer is bounded and the asker keeps its budget", async () => {
    const top = await root();
    const lead = await run((s) => delegate(s, top, "maintenance", "Coordinate a vendor question"));
    const asker = await run((s) => delegate(s, lead.task, "maintenance.vendor-dispatch", "Dispatch a plumber for 4B"));
    assert.equal(asker.ok, true, asker.reason);
    // A Specialist may always ask its own Lead's related Leads; ask one as a peer.
    const peer = await run((s) => delegate(s, asker.task, "lead.spend-vendor", "Has this plumber missed an SLA this year?", { scope: { peerOf: asker.task.id } }));
    assert.equal(peer.ok, true, peer.reason);
    assert.deepEqual({ steps: peer.task.maxSteps, tokens: peer.task.maxTokens }, BUDGET_MODEL.peerHelp, "a peer answers one question, on a peer's budget");
    assert.equal((await run((s, org) => getTask(s, org, asker.task.id))).maxSteps, asker.task.maxSteps, "asking cost the asker nothing");
  });

  await t.test("two delegations racing for a Work's last room: exactly one is funded, and nothing is underfunded", async () => {
    const top = await root();
    // Fill the Work to one Lead-sized grant short of its pool.
    const filler = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "maintenance", parentTaskId: top.id, delegationDepth: 1, goal: `Filler lead ${randomUUID()}`, check: { kind: "plan" }, maxSteps: 12, maxTokens: 60_000 }));
    const fillers = [];
    for (let i = 0; i < 7; i++) fillers.push(await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: team[i % team.length], parentTaskId: filler.id, delegationDepth: 2, goal: `Filler ${i} ${randomUUID()}`, check: { kind: "evidence", tools: ["get_maintenance_performance"] }, maxSteps: 12, maxTokens: 60_000 })));
    // Committed: root 12 + filler Lead 12 + 7 × 12 = 108 of 120.
    const [first, second] = await Promise.all([
      run((s, org) => getTask(s, org, top.id).then((fresh) => delegate(s, fresh, "lead.spend-vendor", "Review vendor spend this quarter"))),
      run((s, org) => getTask(s, org, top.id).then((fresh) => delegate(s, fresh, "lead.risk-compliance", "Review open incidents this quarter"))),
    ]);
    const outcomes = [first, second].map((result) => result.ok ? "funded" : result.code).sort();
    assert.deepEqual(outcomes, ["funded", "no_budget"], "the lock lets one spend the room, not both");
    const funded = [first, second].find((result) => result.ok);
    assert.deepEqual({ steps: funded.task.maxSteps, tokens: funded.task.maxTokens }, BUDGET_MODEL.orchestration, "the winner is funded in full");

    // A third ask is refused, and refusing writes nothing.
    const before = (await tasksInWork(top.id)).length;
    const third = await run((s, org) => getTask(s, org, top.id).then((fresh) => delegate(s, fresh, "lead.finance", "Close the month")));
    assert.equal(third.ok, false);
    assert.equal(third.code, "no_budget");
    assert.equal((await tasksInWork(top.id)).length, before, "a refused delegation creates no task");

    // The Work is now at 120 of 120. Superseding two fillers that spent one
    // step each returns 22 — what they spent stays committed.
    for (const spent of fillers.slice(0, 2)) await run((s) => s.db.update(agentTasks).set({ status: "SUPERSEDED", stepCount: 1 }).where(eq(agentTasks.id, spent.id)));
    const afterReplan = await run((s, org) => getTask(s, org, top.id).then((fresh) => delegate(s, fresh, "lead.finance", "Close the month")));
    assert.equal(afterReplan.ok, true, afterReplan.reason ?? "the returned budget funds new work");
  });
}

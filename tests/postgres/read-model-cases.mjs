import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTasks } from "../../db/postgres/schema.ts";
import { createTask } from "../../lib/agents/tasks.ts";
import { recordFact } from "../../lib/agents/facts.ts";
import { openWork, operationalStatus, pendingApprovals } from "../../lib/agents/read-model.ts";

/**
 * The canonical read path.
 *
 * Every assertion here is about persisted state: if a future dashboard reads
 * this module it reads the same rows an agent does, which is the property that
 * stops a UI and a runtime from disagreeing about one tenant.
 */
export async function runReadModelCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  const task = (goal, status) => run(async (s, org) => {
    const created = await createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance", goal,
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    });
    if (status && status !== "QUEUED") {
      await s.db.update(agentTasks).set({ status }).where(eq(agentTasks.id, created.id));
    }
    return created;
  });

  await t.test("open work reports state, owner and why it is not moving", async () => {
    const goal = `read-model ${randomUUID()}`;
    await task(goal, "WAITING_FOR_HUMAN");
    const work = await run((s, org) => openWork(s, org));
    const mine = work.find((w) => w.goal === goal);
    assert.ok(mine, "the item is in the open set");
    assert.equal(mine.state, "WAITING_FOR_HUMAN");
    assert.equal(mine.owner, "maintenance");
    assert.ok(mine.waitingOn, "a waiting state always says what it waits on");
  });

  await t.test("settled work leaves the open set", async () => {
    const goal = `settled ${randomUUID()}`;
    const created = await task(goal, "QUEUED");
    assert.ok((await run((s, org) => openWork(s, org))).some((w) => w.id === created.id));
    await run((s) => s.db.update(agentTasks).set({ status: "COMPLETED" }).where(eq(agentTasks.id, created.id)));
    assert.ok(!(await run((s, org) => openWork(s, org))).some((w) => w.id === created.id));
  });

  await t.test("work awaiting proof is counted apart from work awaiting a person", async () => {
    const before = await run((s, org) => operationalStatus(s, org));
    await task(`pending ${randomUUID()}`, "PENDING_VERIFICATION");
    await task(`human ${randomUUID()}`, "WAITING_FOR_HUMAN");
    const after = await run((s, org) => operationalStatus(s, org));
    assert.equal(after.awaitingVerification, before.awaitingVerification + 1);
    assert.equal(after.needsPerson, before.needsPerson + 1);
    assert.equal(after.open, before.open + 2);
  });

  await t.test("a disagreement between sources surfaces in operational status", async () => {
    const before = await run((s, org) => operationalStatus(s, org));
    const id = `unit_${randomUUID().slice(0, 8)}`;
    for (const [provider, value] of [["doorloop", "occupied"], ["yardi", "vacant"]]) {
      await run((s, org) => recordFact(s, {
        organizationId: org, entityType: "unit", entityId: id, factType: "status",
        value, sourceType: "provider", sourceProvider: provider,
      }));
    }
    const after = await run((s, org) => operationalStatus(s, org));
    assert.equal(after.conflictedFacts, before.conflictedFacts + 2, "both sides of the disagreement are visible");
  });

  await t.test("the read model is tenant-scoped", async () => {
    // Every query is filtered by the session's organization; a second workspace
    // cannot appear in the first one's view.
    const work = await run((s, org) => openWork(s, org).then((rows) => ({ rows, org })));
    const rows = await run((s) => s.db.select({ org: agentTasks.organizationId }).from(agentTasks));
    assert.ok(rows.every((r) => r.org === work.org), "no row from another workspace is reachable");
  });

  await t.test("pending approvals are readable without opening the conversation that made them", async () => {
    const approvals = await run((s, org) => pendingApprovals(s, org));
    assert.ok(Array.isArray(approvals), "the approval queue is a first-class read");
    for (const approval of approvals) {
      assert.ok(approval.taskId, "an approval always names the work it belongs to");
      assert.ok(approval.expiresAt, "and when it stops being valid");
    }
  });
}

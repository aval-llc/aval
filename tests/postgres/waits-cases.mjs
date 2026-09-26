import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTasks } from "../../db/postgres/schema.ts";
import { claimTask, createTask, getTask } from "../../lib/agents/tasks.ts";
import { claimFromState, TASK_STATES, TERMINAL_STATES } from "../../lib/agents/task-state.ts";
import { PERSON_RESUMABLE, WAIT_STATES, parkForWait, resumeByPerson, wakeContext, wakeOnConfiguration, wakeOnDocument, wakeOnInboundMessage } from "../../lib/agents/waits.ts";

/**
 * Every waiting state has a producer and a way to wake. Each case parks a
 * real task the way the runtime does, proves it is not claimable before its
 * wake, fires the event, and proves it is claimable after — with the reason it
 * woke available to its next run.
 */
export async function runWaitsCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const worker = () => `worker_${randomUUID()}`;

  /** A root and one operational child under it, the child ready to wait. */
  const chain = async () => {
    const root = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "general", goal: `Wait root ${randomUUID()}`, check: { kind: "plan" } }));
    const leaf = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "maintenance", parentTaskId: root.id, delegationDepth: 1, goal: "Follow up the repair", check: { kind: "evidence", tools: ["get_maintenance_performance"] } }));
    return { root, leaf };
  };
  /** Parks as the runtime's finish() does: the named state and its wake time. */
  const park = async (taskId, args) => {
    const parked = await run((s, org) => parkForWait(s, org, taskId, args));
    await run((s) => s.db.update(agentTasks).set({ status: parked.state, nextAttemptAt: parked.nextAttemptAt, leaseOwner: null, leaseExpiresAt: null }).where(eq(agentTasks.id, taskId)));
    return parked;
  };
  const claimable = async (taskId) => {
    const task = await run((s, org) => getTask(s, org, taskId));
    return run((s) => claimTask(s, taskId, worker(), claimFromState(task.status)));
  };

  await t.test("every waiting state is produced by wait_for or a runtime hand-off, and a person can resume each", () => {
    const produced = new Set(Object.values(WAIT_STATES));
    for (const state of ["WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT", "WAITING_FOR_DOCUMENT", "SCHEDULED", "BLOCKED", "WAITING_FOR_HUMAN"]) {
      assert.ok(produced.has(state), `${state} has a producer`);
      assert.ok(PERSON_RESUMABLE.includes(state), `${state} can be resumed by a person`);
    }
    assert.equal(TASK_STATES.includes("PLANNING"), false, "a state with no job was removed rather than kept");
    for (const state of TASK_STATES) if (!TERMINAL_STATES.has(state)) assert.notEqual(claimFromState(state), undefined);
  });

  await t.test("a resident wait wakes on a reply in its conversation, and extends the chain's deadline", async () => {
    const { root, leaf } = await chain();
    const conversationId = `conv_${randomUUID()}`;
    const parked = await park(leaf.id, { party: "resident", reason: "Waiting for the resident to confirm access", conversation_id: conversationId });
    assert.equal(parked.state, "WAITING_FOR_RESIDENT");
    assert.ok(parked.nextAttemptAt > new Date(Date.now() + 23 * 3600_000), "a recheck timer backs the event");
    const [rootNow, leafNow] = [await run((s, org) => getTask(s, org, root.id)), await run((s, org) => getTask(s, org, leaf.id))];
    for (const task of [rootNow, leafNow]) assert.ok(task.deadlineAt > parked.nextAttemptAt, `${task.agentId}'s deadline outlives the wait`);
    assert.equal(await claimable(leaf.id), false, "not claimable while it waits");
    assert.equal(await run((s, org) => wakeOnInboundMessage(s, org, `conv_${randomUUID()}`)), 0, "a message elsewhere wakes nothing");
    assert.equal(await run((s, org) => wakeOnInboundMessage(s, org, conversationId)), 1);
    const woken = await run((s, org) => getTask(s, org, leaf.id));
    assert.match(wakeContext(woken), /woken by a new message/);
    assert.equal(await claimable(leaf.id), true, "and claimable once the resident writes");
  });

  await t.test("a document wait wakes when a document is added", async () => {
    const { leaf } = await chain();
    await park(leaf.id, { party: "document", reason: "Waiting for the signed lease addendum" });
    assert.equal(await claimable(leaf.id), false);
    assert.ok(await run((s, org) => wakeOnDocument(s, org)) >= 1);
    assert.equal(await claimable(leaf.id), true);
  });

  await t.test("a scheduled wait wakes only at its time", async () => {
    const { leaf } = await chain();
    await assert.rejects(run((s, org) => parkForWait(s, org, leaf.id, { party: "time", reason: "Follow up next week", wake_at: "2020-01-01T00:00:00Z" })), /future wake_at/);
    const parked = await park(leaf.id, { party: "time", reason: "Follow up after the vendor's appointment", wake_at: new Date(Date.now() + 3 * 86400_000).toISOString() });
    assert.equal(parked.state, "SCHEDULED");
    assert.equal(await claimable(leaf.id), false);
    await run((s) => s.db.update(agentTasks).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(agentTasks.id, leaf.id)));
    assert.equal(await claimable(leaf.id), true, "its own clock is its wake");
  });

  await t.test("blocked work has no timer and wakes when a connection is verified", async () => {
    const { leaf } = await chain();
    const parked = await park(leaf.id, { party: "configuration", reason: "The PMS is not connected, so the work order cannot be raised there" });
    assert.equal(parked.state, "BLOCKED");
    assert.equal(parked.nextAttemptAt, null, "no polling: only a change can move it");
    assert.equal(await claimable(leaf.id), false);
    assert.ok(await run((s, org) => wakeOnConfiguration(s, org)) >= 1);
    assert.equal(await claimable(leaf.id), true);
  });

  await t.test("a person resumes human-dependent work with a note that is context, not authority", async () => {
    const { leaf } = await chain();
    await park(leaf.id, { party: "person", reason: "Needs the owner's decision on the repair budget" });
    assert.equal(await claimable(leaf.id), false);
    const resumed = await run((s, org) => resumeByPerson(s, org, leaf.id, "Owner approved up to $800 by phone"));
    assert.equal(resumed.ok, true);
    const woken = await run((s, org) => getTask(s, org, leaf.id));
    assert.match(wakeContext(woken), /Owner approved up to \$800/);
    assert.match(wakeContext(woken), /not a new authority/);
    assert.equal(await claimable(leaf.id), true);
  });

  await t.test("a conversational wait must have a way to end", async () => {
    const { leaf } = await chain();
    await assert.rejects(run((s, org) => parkForWait(s, org, leaf.id, { party: "vendor", reason: "Waiting for the vendor's quote" })), /conversation|recheck_hours/);
    await assert.rejects(run((s, org) => parkForWait(s, org, leaf.id, { party: "vendor", reason: "Waiting for the vendor's quote", recheck_hours: 900 })), /recheck_hours/);
  });
}

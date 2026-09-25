import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTasks, organizations } from "../../db/postgres/schema.ts";
import { intakeEvent } from "../../lib/agents/intake.ts";
import { deterministicTaskId, COORDINATOR_AGENT_ID } from "../../lib/agents/intake-rules.ts";

/**
 * Event intake against a real PostgreSQL instance.
 *
 * These are the proofs the unit tests could not give: the deduplication is
 * enforced by a primary key, so it only means anything when a database is
 * present to enforce it. Two deliveries of the same message race here rather
 * than being reasoned about.
 */
export async function runIntakeCases(t, { session, userA, organizationId }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  // Intake resolves the accountable principal from the workspace owner, so the
  // row has to exist. Auth bootstrap may already have created it.
  await run(async (s, org) => {
    const existing = await s.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org));
    if (existing.length === 0) {
      const now = new Date();
      await s.db.insert(organizations).values({ id: org, ownerUserId: userA, name: "Intake fixture", createdAt: now, updatedAt: now }).onConflictDoNothing();
    }
  });

  const digestFor = (label) => createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");

  await t.test("a verified seat message creates durable work owned by the coordinator", async () => {
    const sourceId = digestFor("verified");
    const outcome = await run((s, org) => intakeEvent(s, {
      organizationId: org,
      source: "pms_seat_email",
      sourceId,
      trustState: "verified",
      goal: "Establish what operational work this message represents.",
    }));
    assert.equal(outcome.status, "created");
    const task = outcome.task;
    assert.equal(task.agentId, COORDINATOR_AGENT_ID);
    // QUEUED is what lets the scheduled worker batch pick it up. Work that
    // arrived while nobody was chatting still progresses.
    assert.equal(task.status, "QUEUED");
    assert.equal(task.userId, userA, "the workspace owner is the accountable principal");
    assert.equal(task.parentTaskId, null);
    const scope = JSON.parse(task.executionScopeJson);
    assert.equal(scope.source, "pms_event");
    assert.equal(scope.origin, "pms_seat_email");
    assert.equal(scope.sourceId, sourceId);
    assert.equal(scope.trustState, "verified");
    // A plan root: task-boundary.ts refuses operational tools to it, so the
    // coordinator must decompose into specialist children.
    assert.equal(JSON.parse(task.checkJson).kind, "plan");
  });

  await t.test("a redelivered message reaches the existing work rather than opening a second", async () => {
    const sourceId = digestFor("redelivered");
    const event = { organizationId, source: "pms_seat_email", sourceId, trustState: "verified", goal: "Same goal." };
    const first = await run((s, org) => intakeEvent(s, { ...event, organizationId: org }));
    const second = await run((s, org) => intakeEvent(s, { ...event, organizationId: org }));
    assert.equal(first.status, "created");
    assert.equal(second.status, "attached");
    assert.equal(second.task.id, first.task.id);
    const rows = await run((s) => s.db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.id, first.task.id)));
    assert.equal(rows.length, 1, "one event is one work item");
  });

  await t.test("concurrent duplicate delivery yields exactly one work item", async () => {
    const sourceId = digestFor("concurrent");
    const event = { source: "pms_seat_email", sourceId, trustState: "verified", goal: "Concurrent delivery." };
    // Both callers miss the pre-read; the primary key decides, not the race.
    const results = await Promise.all([
      run((s, org) => intakeEvent(s, { ...event, organizationId: org })),
      run((s, org) => intakeEvent(s, { ...event, organizationId: org })),
    ]);
    const ids = new Set(results.map((r) => r.task.id));
    assert.equal(ids.size, 1, "both deliveries resolve to the same task");
    const expected = await deterministicTaskId(organizationId, "pms_seat_email", sourceId);
    assert.equal([...ids][0], expected, "the id is derived, not random");
    const rows = await run((s) => s.db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.id, expected)));
    assert.equal(rows.length, 1);
  });

  await t.test("an unverified message creates no work at all", async () => {
    for (const trustState of ["unverified", "quarantined"]) {
      const sourceId = digestFor(trustState);
      const outcome = await run((s, org) => intakeEvent(s, {
        organizationId: org, source: "pms_seat_email", sourceId, trustState, goal: "Should not exist.",
      }));
      assert.equal(outcome.status, "refused");
      const id = await deterministicTaskId(organizationId, "pms_seat_email", sourceId);
      const rows = await run((s) => s.db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.id, id)));
      assert.equal(rows.length, 0, `${trustState} must not reach the database`);
    }
  });

  await t.test("the same message to two workspaces is two separate work items", async () => {
    const sourceId = digestFor("cross-tenant");
    const mine = await deterministicTaskId(organizationId, "pms_seat_email", sourceId);
    const theirs = await deterministicTaskId("org_someone_else", "pms_seat_email", sourceId);
    assert.notEqual(mine, theirs, "the derived id is tenant-scoped");
  });

  await t.test("intake refuses a workspace that does not exist", async () => {
    const outcome = await run((s) => intakeEvent(s, {
      organizationId: "org_does_not_exist",
      source: "pms_seat_email",
      sourceId: digestFor("missing-org"),
      trustState: "verified",
      goal: "Should be refused.",
    }));
    assert.equal(outcome.status, "refused");
  });
}

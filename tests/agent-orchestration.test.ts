import assert from "node:assert/strict";
import test from "node:test";

import { hasPermission, roleForPersona } from "../lib/agents/permissions.ts";
import { DELEGATION_RULES } from "../lib/agents/delegation-rules.ts";
import { actorHolds, actorMayDelegateTo, actorOrchestrates, builtInActor, NEVER_ROUTABLE, SPECIALISTS } from "../lib/agents/organization/index.ts";
import { deterministicTaskId, COORDINATOR_AGENT_ID } from "../lib/agents/intake-rules.ts";

/**
 * The coordinator routes domain work; it never performs it. Both halves
 * matter: without routing there is no orchestration, and without the refusal
 * the coordinator has quietly become an agent with every write permission.
 *
 * These read the resolver the runtime actually uses (lib/agents/organization),
 * not a parallel table — a test of a function production no longer calls
 * would pass while the real boundary moved.
 */

test("the coordinator cannot itself exercise any domain write", () => {
  assert.equal(roleForPersona(COORDINATOR_AGENT_ID), "general");
  for (const permission of ["pms.maintenance.write", "pms.arrears.write", "pms.leasing.write", "maintenance.create", "vendor.dispatch"] as const) {
    assert.equal(actorHolds(COORDINATOR_AGENT_ID, permission), false, `general must not hold ${permission}`);
  }
});

test("the coordinator may route each PMS write to the Lead or Specialist that holds it", () => {
  for (const permission of ["pms.maintenance.write", "pms.arrears.write", "pms.leasing.write"] as const) {
    assert.equal(actorOrchestrates(COORDINATOR_AGENT_ID, permission), true, `general must be able to route ${permission}`);
  }
});

test("routing is not a back door to authority nobody below may exercise", () => {
  // Money movement, contract execution and access changes are never routed,
  // and neither is the workspace's own memory.
  for (const permission of NEVER_ROUTABLE) {
    assert.equal(actorOrchestrates(COORDINATOR_AGENT_ID, permission), false, `general must not route ${permission}`);
  }
  // Everything the coordinator may route is held by some actor it may reach.
  for (const permission of builtInActor(COORDINATOR_AGENT_ID)!.orchestrates) {
    const holder = [...builtInActor(COORDINATOR_AGENT_ID)!.delegatesTo].find((id) => actorHolds(id, permission));
    assert.ok(holder, `nothing the coordinator reaches holds ${permission}`);
  }
});

test("no specialist may route anything", () => {
  // A specialist that could route would reach a peer's authority, which
  // invariant 8 forbids: a peer can do no more than the specialist asking.
  for (const specialist of SPECIALISTS) {
    assert.deepEqual(builtInActor(specialist.id)!.orchestrates, [], `${specialist.id} routes`);
  }
  assert.equal(actorOrchestrates("custom", "pms.maintenance.write"), false);
});

test("the coordinator can delegate to brokerage", () => {
  // pms.leasing.write is held only by brokerage among the historical agents.
  // Before this edge existed the permission was unreachable from the coordinator.
  assert.ok(actorMayDelegateTo(COORDINATOR_AGENT_ID, "brokerage"));
  assert.equal(hasPermission("brokerage", "pms.leasing.write"), true);
});

test("delegation remains a narrowing graph", () => {
  for (const [from, targets] of Object.entries(DELEGATION_RULES)) {
    assert.ok(!(targets ?? []).includes(from as never), `${from} delegates to itself`);
  }
});

test("one event yields one stable task id", async () => {
  const a = await deterministicTaskId("org_1", "pms_seat_email", "digest_abc");
  const b = await deterministicTaskId("org_1", "pms_seat_email", "digest_abc");
  assert.equal(a, b, "a redelivered event must reach the same row");
});

test("task ids do not collide across workspaces, sources, or events", async () => {
  const base = await deterministicTaskId("org_1", "pms_seat_email", "digest_abc");
  assert.notEqual(await deterministicTaskId("org_2", "pms_seat_email", "digest_abc"), base);
  assert.notEqual(await deterministicTaskId("org_1", "pms_notification", "digest_abc"), base);
  assert.notEqual(await deterministicTaskId("org_1", "pms_seat_email", "digest_abd"), base);
});

test("a derived id is shaped like the random ids every other task carries", async () => {
  const id = await deterministicTaskId("org_1", "pms_seat_email", "digest_abc");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

import { admissible } from "../lib/agents/intake-rules.ts";

test("only a verified event creates work", () => {
  assert.equal(admissible({ trustState: "verified", sourceId: "d1" }), true);
});

test("an unverified or quarantined message never creates work", () => {
  // Receiving a message is not permission to act on it (AVAL_AGENT.md §7.1).
  for (const trustState of ["unverified", "quarantined"] as const) {
    const verdict = admissible({ trustState, sourceId: "d1" });
    assert.notEqual(verdict, true);
    assert.match((verdict as { reason: string }).reason, /does not create work/);
  }
});

test("an event without a stable id is refused rather than deduplicated by guess", () => {
  const verdict = admissible({ trustState: "verified", sourceId: "" });
  assert.notEqual(verdict, true);
  assert.match((verdict as { reason: string }).reason, /deduplicated/);
});

import { getTool } from "../lib/agents/registry.ts";

test("a tool that only changes Aval's own state is not an external effect", () => {
  // plan_goal mutates — it creates child tasks and reserves an idempotency key
  // — but nothing leaves Aval, so the write succeeding is the proof. Treating
  // it as external held every planned task at PENDING_VERIFICATION.
  assert.equal(getTool("plan_goal")?.mutates, true);
  assert.notEqual(getTool("plan_goal")?.externalEffect, true);
});

test("every tool that reaches a provider declares an external effect", () => {
  for (const name of ["send_external_message", "place_call", "publish_listing", "create_work_order",
                      "post_payment", "reply_to_inquiry", "dispatch_vendor", "execute_lease"]) {
    assert.equal(getTool(name)?.externalEffect, true, `${name} must declare externalEffect`);
  }
});

test("an external effect always mutates", () => {
  // The reverse does not hold, which is the entire point of the distinction.
  assert.ok(getTool("create_work_order")?.mutates);
  assert.ok(getTool("send_external_message")?.mutates);
});

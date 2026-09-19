import assert from "node:assert/strict";
import test from "node:test";

import { canOrchestrate, hasPermission, roleForPersona, ORCHESTRATION_PERMISSIONS } from "../lib/agents/permissions.ts";
import { DELEGATION_RULES } from "../lib/agents/delegation-rules.ts";
import { deterministicTaskId, COORDINATOR_AGENT_ID } from "../lib/agents/intake-rules.ts";

/**
 * The coordinator routes domain writes; it never performs them. Both halves
 * matter: without routing there is no orchestration, and without the refusal
 * the coordinator has quietly become an agent with every write permission.
 */

test("the coordinator cannot itself exercise any PMS write", () => {
  const general = roleForPersona(COORDINATOR_AGENT_ID);
  assert.equal(general, "general");
  for (const permission of ["pms.maintenance.write", "pms.arrears.write", "pms.leasing.write"] as const) {
    assert.equal(hasPermission(general, permission), false, `general must not hold ${permission}`);
  }
});

test("the coordinator may route each PMS write to a specialist", () => {
  const general = roleForPersona(COORDINATOR_AGENT_ID);
  for (const permission of ["pms.maintenance.write", "pms.arrears.write", "pms.leasing.write"] as const) {
    assert.equal(canOrchestrate(general, permission), true, `general must be able to route ${permission}`);
  }
});

test("routing is not a back door to unrelated authority", () => {
  const general = roleForPersona(COORDINATOR_AGENT_ID);
  // Routing covers PMS domain writes only. Nothing else is routable.
  assert.equal(canOrchestrate(general, "vendor.dispatch"), false);
  assert.equal(canOrchestrate(general, "maintenance.create"), false);
  assert.equal(canOrchestrate(general, "preferences.write"), false);
});

test("no specialist may route anything", () => {
  // Only the coordinator orchestrates. A specialist that could route would be
  // able to reach a peer's authority, which invariant 8 forbids.
  for (const role of Object.keys(ORCHESTRATION_PERMISSIONS)) {
    assert.equal(role, "general", `only general may orchestrate; found ${role}`);
  }
  for (const role of ["maintenance", "financial", "brokerage", "riskAnalyst", "custom"] as const) {
    assert.equal(canOrchestrate(role, "pms.maintenance.write"), false);
  }
});

test("every routable permission is held by some specialist the coordinator may delegate to", () => {
  // A routable permission no reachable specialist holds would be a dead edge:
  // the coordinator could plan work that nothing can execute.
  const reachable = DELEGATION_RULES.general ?? [];
  for (const permission of ORCHESTRATION_PERMISSIONS.general ?? []) {
    const holder = reachable.find((role) => hasPermission(role, permission));
    assert.ok(holder, `no delegate of general holds ${permission}`);
  }
});

test("the coordinator can delegate to brokerage", () => {
  // pms.leasing.write is held only by brokerage. Before this edge existed the
  // permission was unreachable from the coordinator entirely.
  assert.ok((DELEGATION_RULES.general ?? []).includes("brokerage"));
  assert.equal(hasPermission("brokerage", "pms.leasing.write"), true);
});

test("delegation remains a narrowing graph", () => {
  // Adding brokerage must not have made the graph reflexive or cyclic at depth 1.
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

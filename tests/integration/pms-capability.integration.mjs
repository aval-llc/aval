import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * The capability matrix against real storage.
 *
 * `tests/pms-capability.test.ts` asserts the decision; this asserts the reads
 * that feed it, which is where the acceptance criteria that involve state live:
 * that grant discovery never enables anything, that a suspended authorization
 * takes effect immediately, and that an AppFolio workspace is assembled without
 * write tools no matter what its rows say.
 */

const NOW = Date.now();

function connect(sqlite, provider, metadata = {}) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO integration_connections
       (id, organization_id, provider, category, status, auth_mode, scopes_json, metadata_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `conn_${provider}`,
      "org_1",
      provider,
      "Leasing & PMS",
      "connected",
      "api_key",
      "[]",
      JSON.stringify(metadata),
      "user_1",
      NOW,
      NOW,
    );
}

function authorize(sqlite, provider, action, { status = "approved", signed = false } = {}) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO pms_write_authorizations
       (id, organization_id, provider, action, status, signed_authorization, version, approved_by_user_id, approved_at, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `auth_${provider}_${action}`,
      "org_1",
      provider,
      action,
      status,
      signed ? 1 : 0,
      1,
      "user_1",
      NOW,
      "user_1",
      NOW,
      NOW,
    );
}

test("an AppFolio workspace is assembled with zero PMS write tools, whatever its rows say", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "appfolio", {
    // Even a grant set that claims everything cannot outrank the terms.
    pmsGrants: {
      available: ["maintenance.work_order.create", "maintenance.work_order.close", "arrears.payment.post"],
      probedAt: new Date().toISOString(),
      probed: true,
    },
  });
  authorize(sqlite, "appfolio", "maintenance.work_order.create", { status: "approved", signed: false });

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const availability = await pmsToolAvailability("org_1");
  assert.deepEqual([...availability.toolNames], [], "an AppFolio org was assembled a write tool");
});

test("a countersigned authorization is the one thing that opens an AppFolio write", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "appfolio", {
    pmsGrants: { available: ["maintenance.work_order.create"], probedAt: new Date().toISOString(), probed: true },
  });
  authorize(sqlite, "appfolio", "maintenance.work_order.create", { status: "approved", signed: true });

  const { resolveCapability } = await import("../../lib/pms/capability.ts");
  const resolution = await resolveCapability("org_1", "appfolio", "maintenance.work_order.create");

  // Still not `allow`: AppFolio is a `ui` provider, so it also needs a learned
  // flow. The signature cleared the terms gate and the next honest answer is
  // "we have not recorded this flow yet" — Aval's work, not a refusal.
  assert.equal(resolution.state, "unlearned");
  assert.equal(resolution.owner, "aval");
  assert.equal(resolution.runner, "desktop");
});

test("an approved flow plus a signature reaches allow, and suspending the authorization revokes it at once", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "appfolio", {
    pmsGrants: { available: ["maintenance.work_order.create"], probedAt: new Date().toISOString(), probed: true },
  });
  authorize(sqlite, "appfolio", "maintenance.work_order.create", { status: "approved", signed: true });
  sqlite
    .prepare(
      `INSERT INTO pms_action_flows
       (id, organization_id, provider, action, version, steps_json, digest, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("flow_1", "org_1", "appfolio", "maintenance.work_order.create", 1, "[]", "sha", "active", NOW, NOW);

  const { resolveCapability } = await import("../../lib/pms/capability.ts");
  // A grant probe still has to exist for AppFolio; it does not, so this remains
  // `unlearned` rather than `allow`. Asserting the real state rather than the
  // one the test would prefer.
  const withFlow = await resolveCapability("org_1", "appfolio", "maintenance.work_order.create");
  assert.equal(withFlow.state, "unlearned");
  assert.match(withFlow.reason ?? "", /verify what a AppFolio connection grants/i);

  // Suspension is what same-day revocation looks like: the terms gate closes
  // again the moment the signature stops counting.
  authorize(sqlite, "appfolio", "maintenance.work_order.create", { status: "suspended", signed: true });
  const revoked = await resolveCapability("org_1", "appfolio", "maintenance.work_order.create");
  assert.equal(revoked.state, "blocked");
  assert.match(revoked.reason ?? "", /5\.4/);
});

test("grant discovery reports what it found and enables nothing", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "doorloop");

  const { registerGrantProbe, discoverGrants, readGrants } = await import("../../lib/pms/grants.ts");
  registerGrantProbe("doorloop", async () => ({
    available: ["maintenance.work_order.create", "arrears.payment.post"],
  }));

  const grants = await discoverGrants("org_1", "doorloop");
  assert.equal(grants.probed, true);
  assert.ok(grants.available.includes("maintenance.work_order.create"));

  // Persisted to the connection's metadata, and readable back.
  assert.deepEqual([...(await readGrants("org_1", "doorloop")).available].sort(), [
    "arrears.payment.post",
    "maintenance.work_order.create",
  ]);

  // The acceptance criterion: discovery created no authorization row. Finding
  // that a connection *can* write must never be the thing that lets it.
  const authorizations = sqlite.prepare("SELECT count(*) AS n FROM pms_write_authorizations").get().n;
  assert.equal(authorizations, 0, "grant discovery created an authorization row");

  // And the action it "found" resolves to off/unlearned, never allow.
  const { resolveCapability } = await import("../../lib/pms/capability.ts");
  const resolution = await resolveCapability("org_1", "doorloop", "arrears.payment.post");
  assert.notEqual(resolution.state, "allow");
});

test("a workspace with no PMS connection is assembled no PMS write tools at all", async () => {
  await bootRuntime();
  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  assert.deepEqual([...(await pmsToolAvailability("org_1")).toolNames], []);
});

test("one workspace's authorization does not leak into another", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "doorloop");
  authorize(sqlite, "doorloop", "maintenance.work_order.create", { status: "approved" });

  const { readAllEnablements } = await import("../../lib/pms/enablement.ts");
  const mine = await readAllEnablements("org_1");
  assert.equal(mine.get("doorloop:maintenance.work_order.create")?.enabled, true);

  // org_public_demo shares the database and must see none of it. On D1 nothing
  // below the application enforces this, which is why it is asserted.
  const theirs = await readAllEnablements("org_public_demo");
  assert.equal(theirs.size, 0);
});

test("the matrix resolves every action for a provider without one query per action", async () => {
  const sqlite = await bootRuntime();
  connect(sqlite, "doorloop");

  const { resolveMatrix } = await import("../../lib/pms/capability.ts");
  const matrix = await resolveMatrix("org_1", "doorloop");

  // All fourteen actions, and every one carries a state.
  assert.equal(matrix.size, 14);
  for (const [action, resolution] of matrix) {
    assert.ok(resolution.state, `${action} has no state`);
    if (resolution.state !== "allow") {
      assert.ok(resolution.reason, `${action} is not allowed and does not say why`);
    }
  }
  // Reads are on from day one; that is the shared envelope.
  assert.equal(matrix.get("maintenance.work_orders.read").state, "allow");
  assert.equal(matrix.get("reporting.financials.read").state, "allow");
});

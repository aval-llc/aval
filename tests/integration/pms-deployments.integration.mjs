import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * Binding an agent to the system it works inside.
 *
 * Before deployments, `pmsToolAvailability()` resolved across every connected
 * PMS and let the model name one as a tool argument — so an org with two PMSs
 * offered every agent both. These assert the narrowing, and the one thing that
 * makes it safe to ship onto existing workspaces: an empty table changes
 * nothing, and the first row changes everything for that workspace.
 */

const NOW = Date.now();

function connect(sqlite, provider) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO integration_connections
       (id, organization_id, provider, category, status, auth_mode, scopes_json, metadata_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `conn_${provider}`, "org_1", provider, "Leasing & PMS", "connected", "api_key", "[]",
      JSON.stringify({
        pmsGrants: {
          available: ["maintenance.work_order.create", "arrears.payment.post"],
          probedAt: new Date().toISOString(),
          probed: true,
        },
      }),
      "user_1", NOW, NOW,
    );
}

/**
 * Countersigned, because arrears defaults to `off` and only a signed
 * authorization lifts it. Maintenance does not need the signature; signing both
 * keeps these tests about deployments rather than about enablement.
 */
function authorize(sqlite, provider, action) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO pms_write_authorizations
       (id, organization_id, provider, action, status, signed_authorization, version, approved_by_user_id, approved_at, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(`auth_${provider}_${action}`, "org_1", provider, action, "approved", 1, 1, "user_1", NOW, "user_1", NOW, NOW);
}

function deploy(sqlite, { persona, provider, workflows, status = "active", autonomy = "supervised" }) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO agent_deployments
       (id, organization_id, persona_id, provider, workflows_json, autonomy_mode, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `dep_${persona}_${provider}`, "org_1", persona, provider,
      JSON.stringify(workflows), autonomy, status, "user_1", NOW, NOW,
    );
}

/** Both PMSs write-capable, so narrowing is the only thing that can separate them. */
const ACTIONS = ["maintenance.work_order.create", "arrears.payment.post"];

async function twoConnectedPms(sqlite) {
  const { registerWriteAdapter } = await import("../../lib/pms/flows.ts");
  const { registerGrantProbe } = await import("../../lib/pms/grants.ts");
  for (const provider of ["doorloop", "buildium"]) {
    connect(sqlite, provider);
    // Stored grant metadata is not enough on its own: without a probe the
    // provider resolves `unlearned` ("Aval cannot yet verify what a Buildium
    // connection grants"), which would make every assertion below vacuous.
    registerGrantProbe(provider, async () => ({ available: ACTIONS }));
    for (const action of ACTIONS) {
      authorize(sqlite, provider, action);
      registerWriteAdapter(provider, action, async () => ({ ok: true }));
    }
  }
}

test("an empty deployments table leaves assembly exactly as it was", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const availability = await pmsToolAvailability("org_1", "maintenance");

  // The migration must not silently revoke PMS writes from a workspace that
  // configured grants and authorizations before deployments existed.
  assert.ok(availability.toolNames.has("create_work_order"), "an unmigrated workspace lost its write tools");
  assert.deepEqual(
    [...(availability.providersByTool.get("create_work_order") ?? [])].sort(),
    ["buildium", "doorloop"],
    "an unmigrated workspace should still resolve across every connected PMS",
  );
});

test("a deployment binds the agent to one PMS and the other disappears", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);
  deploy(sqlite, { persona: "maintenance", provider: "doorloop", workflows: ["maintenance", "arrears"] });

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const availability = await pmsToolAvailability("org_1", "maintenance");

  assert.deepEqual(
    [...(availability.providersByTool.get("create_work_order") ?? [])],
    ["doorloop"],
    "a deployed agent was still offered a provider it is not deployed into",
  );
});

test("owning a PMS is not owning every workflow inside it", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);
  deploy(sqlite, { persona: "maintenance", provider: "doorloop", workflows: ["maintenance"] });

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const availability = await pmsToolAvailability("org_1", "maintenance");

  assert.ok(availability.toolNames.has("create_work_order"));
  // post_payment is arrears. Same provider, same connection, same signature —
  // and absent, because this deployment does not own that workflow.
  assert.equal(
    availability.toolNames.has("post_payment"),
    false,
    "a maintenance-only deployment was assembled an arrears tool",
  );
});

test("pausing a deployment removes the tools rather than refusing them later", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);
  deploy(sqlite, { persona: "maintenance", provider: "doorloop", workflows: ["maintenance"], status: "paused" });
  deploy(sqlite, { persona: "other", provider: "buildium", workflows: ["maintenance"] });

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const availability = await pmsToolAvailability("org_1", "maintenance");

  // The workspace has a deployment (the other agent's), so it is governed; this
  // agent's only deployment is paused, which is not the same as having none.
  assert.deepEqual([...availability.toolNames], [], "a paused deployment still assembled tools");
});

test("once a workspace deploys anything, an undeployed agent gets nothing", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);
  deploy(sqlite, { persona: "maintenance", provider: "doorloop", workflows: ["maintenance"] });

  const { pmsToolAvailability } = await import("../../lib/pms/assembly.ts");
  const undeployed = await pmsToolAvailability("org_1", "financial");

  // This is the whole of the migration decision: the first deployment row is
  // the workspace saying it governs agents this way, and an agent without a row
  // there was left out on purpose.
  assert.deepEqual([...undeployed.toolNames], [], "an undeployed agent kept write tools in a governed workspace");
});

test("one workspace's deployments never widen another's", async () => {
  const sqlite = await bootRuntime();
  await twoConnectedPms(sqlite);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO agent_deployments
       (id, organization_id, persona_id, provider, workflows_json, autonomy_mode, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("dep_other_org", "org_public_demo", "maintenance", "doorloop", '["maintenance"]', "supervised", "active", "user_1", NOW, NOW);

  const { organizationHasDeployments } = await import("../../lib/pms/deployments.ts");
  assert.equal(await organizationHasDeployments("org_1"), false, "another org's deployment governed this one");
});

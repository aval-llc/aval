import assert from "node:assert/strict";
import test from "node:test";
import { PMS_PROVIDERS, pmsProvider } from "../lib/pms/providers/index.ts";
import { integrationCatalog } from "../lib/integrations/catalog.ts";
import { providerIsReadOnly, providerWriteBlocker } from "../lib/pms/derive.ts";
import { PMS_ACTIONS } from "../lib/pms/types.ts";
import { PMS_WRITE_TOOL_NAMES, PMS_WRITE_TOOLS } from "../lib/pms/tool-map.ts";
import { TOOL_REGISTRY } from "../lib/agents/registry.ts";

/**
 * The descriptors are a legal document as much as a config file, so these are
 * invariants about honesty rather than about behavior: that we never claim a
 * permission we cannot name, never route a UI write through our own servers,
 * and never let a provider exist in two places saying two things.
 */

test("a UI write is always driven from the customer's own machine, never from our servers", () => {
  // This is the arrangement the whole design exists to avoid: `ui` + `cloud`
  // would mean Aval storing a customer's PMS password and driving their PMS
  // from a datacenter IP. No descriptor may ever express it.
  for (const provider of PMS_PROVIDERS) {
    if (provider.write.mechanisms.includes("ui")) {
      assert.equal(
        provider.write.runner,
        "desktop",
        `"${provider.id}" drives a UI from the cloud, which would put Aval in custody of a PMS credential`,
      );
    }
  }
});

test("every permitted:false carries the reason it is false", () => {
  // "If we can't name why, we don't know, and unknown defaults to false" — the
  // brief. An unexplained denial is indistinguishable from a bug.
  for (const provider of PMS_PROVIDERS) {
    if (!provider.read.permitted) {
      assert.ok(provider.read.reason?.trim(), `"${provider.id}" forbids reads without saying why`);
    }
    if (!provider.write.permitted) {
      assert.ok(provider.write.reason?.trim(), `"${provider.id}" forbids writes without saying why`);
    }
  }
});

test("supported and permitted are genuinely independent, not one field wearing two names", () => {
  // AppFolio is the case that proves the distinction is load-bearing: a write
  // path physically exists and its terms forbid using it. If no provider ever
  // held this combination, the two fields could be collapsed and someone
  // eventually would.
  const appfolio = pmsProvider("appfolio");
  assert.ok(appfolio);
  assert.equal(appfolio.write.supported, true);
  assert.equal(appfolio.write.permitted, false);
  assert.equal(appfolio.write.override, "signed_authorization");
  assert.match(appfolio.write.reason ?? "", /5\.4/);
});

test("a descriptor with no write mechanism does not claim to support writes", () => {
  for (const provider of PMS_PROVIDERS) {
    if (provider.write.mechanisms.length === 0) {
      assert.equal(provider.write.supported, false, `"${provider.id}" supports writes with no mechanism to do them`);
    }
  }
});

test("every PMS in the connection catalog has a descriptor, and vice versa", () => {
  // Leaving one catalog-only recreates the split-brain this layer replaced,
  // where readiness.ts and the catalog each answered the same question.
  const catalogPms = integrationCatalog
    .filter((provider) => provider.category === "Leasing & PMS")
    .map((provider) => provider.id as string);
  const described = new Set(PMS_PROVIDERS.map((provider) => provider.id));

  for (const id of catalogPms) {
    assert.ok(described.has(id), `catalog PMS "${id}" has no descriptor in lib/pms/providers/`);
  }
  for (const provider of PMS_PROVIDERS) {
    // generic_email is a real catalog entry; everything else must be too.
    assert.ok(
      catalogPms.includes(provider.id),
      `descriptor "${provider.id}" is not connectable because it is missing from the catalog`,
    );
  }
});

test("no PMS catalog entry stores readOnly by hand any more", () => {
  // The field was `true` on all seven PMS providers and enforced by nothing.
  // Its absence is what forces every caller through providerIsReadOnly.
  for (const provider of integrationCatalog) {
    if (provider.category !== "Leasing & PMS") continue;
    assert.equal(
      Object.prototype.hasOwnProperty.call(provider, "readOnly"),
      false,
      `"${provider.id}" still stores readOnly instead of deriving it`,
    );
  }
});

test("readOnly is derived from the descriptor, and says the opposite of what the catalog used to", () => {
  // DoorLoop was marked readOnly: true while having a documented, permitted
  // write API. That is the concrete bug this derivation fixes.
  assert.equal(providerIsReadOnly("doorloop"), false);
  assert.equal(providerWriteBlocker("doorloop"), null);

  // AppFolio is read-only for a reason that is now stated rather than asserted.
  assert.equal(providerIsReadOnly("appfolio"), true);
  assert.match(providerWriteBlocker("appfolio") ?? "", /5\.4/);

  // An undescribed provider defaults to read-only. Unknown defaults to no.
  assert.equal(providerIsReadOnly("some_pms_we_have_never_heard_of"), true);
});

test("every PMS write tool maps to exactly one action, and every action to one tool", () => {
  const actions = Object.values(PMS_ACTIONS).flat();
  const writeActions = actions.filter((action) => !action.endsWith(".read"));
  const mapped = new Set(Object.values(PMS_WRITE_TOOLS));

  for (const action of writeActions) {
    assert.ok(mapped.has(action), `write action "${action}" has no tool`);
  }
  assert.equal(mapped.size, Object.keys(PMS_WRITE_TOOLS).length, "two tools share one action");
});

test("every PMS write tool is registered with an approval requirement and no retry budget", () => {
  for (const name of PMS_WRITE_TOOL_NAMES) {
    const tool = TOOL_REGISTRY.get(name);
    assert.ok(tool, `"${name}" is mapped but not registered`);
    assert.equal(tool.mutates, true, `"${name}" writes to a PMS but claims not to mutate`);
    assert.equal(tool.requiresApproval, true, `"${name}" writes to a PMS without requiring approval`);
    // The queue owns retries; a tool-level retry would race the drainer.
    assert.equal(tool.maxRetries, 0, `"${name}" carries a retry budget it must not have`);
    assert.equal(tool.unimplemented, undefined, `"${name}" is gated by the matrix, not by being unwired`);
  }
});

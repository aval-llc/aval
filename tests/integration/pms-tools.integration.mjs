import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime } from "./harness.mjs";

/**
 * The PMS write path, connected end to end.
 *
 * `tests/pms-tools.test.ts` pins the pure joins. These cover the half that
 * needs the module graph and storage, and in particular the assertion that
 * would have caught P0.3 shipping half-wired: a write tool that is not in
 * `TOOLS` cannot be reached at all, however correct every other layer is.
 */

test("every PMS write tool reaches the list the model is actually given", async () => {
  await bootRuntime();
  const { TOOLS, TOOL_SCHEMAS } = await import("../../lib/ask-aval/tools.ts");
  const { PMS_WRITE_TOOL_NAMES } = await import("../../lib/pms/tool-map.ts");

  const offered = new Set(TOOLS.map((tool) => tool.name));
  for (const name of PMS_WRITE_TOOL_NAMES) {
    // `runtime.ts` filters TOOLS against the capability matrix. A tool missing
    // from TOOLS is not "filtered out for safety" — it is unreachable, and the
    // filter above it is narrowing a set it was never in.
    assert.ok(offered.has(name), `${name} is absent from TOOLS, so no request can ever include it`);
    // TOOL_SCHEMAS is what lib/agents/tool-schema.ts validates arguments
    // against. In TOOLS but absent here means unvalidated arguments.
    assert.ok(TOOL_SCHEMAS.has(name), `${name} has no schema for argument validation`);
  }
});

test("every PMS write tool is a registered mutating tool needing approval", async () => {
  await bootRuntime();
  const { getTool } = await import("../../lib/agents/registry.ts");
  const { PMS_WRITE_TOOL_NAMES } = await import("../../lib/pms/tool-map.ts");

  for (const name of PMS_WRITE_TOOL_NAMES) {
    const descriptor = getTool(name);
    assert.ok(descriptor, `${name} has a schema but no registry descriptor`);
    // `mutates` is what routes it through idempotency reservation and the
    // approval gate in the executor. A write tool that claims otherwise would
    // skip both.
    assert.equal(descriptor.mutates, true, `${name} does not declare that it mutates`);
    assert.equal(descriptor.maxRetries, 0, `${name} would retry a write`);
  }
});

test("a PMS write outside a durable task is refused, not given an invented key", async () => {
  await bootRuntime();
  const { runPmsWriteTool } = await import("../../lib/pms/tools.ts");
  // The idempotency key comes from the task row. Without one a retry would
  // create a second work order rather than colliding with its own first
  // attempt, so there is no safe default and the call must not proceed.
  await assert.rejects(
    () => runPmsWriteTool(
      "create_work_order",
      { provider: "doorloop", property_id: "p1", summary: "Leak" },
      "org_1",
      undefined,
    ),
    /durable task/,
  );
});

test("a tool that is not a PMS write cannot be run through this path", async () => {
  await bootRuntime();
  const { runPmsWriteTool } = await import("../../lib/pms/tools.ts");
  await assert.rejects(
    () => runPmsWriteTool("get_portfolio_metrics", {}, "org_1", "key_1"),
    /not a PMS write tool/,
  );
});

test("naming no provider is an outcome the model reads, not an exception", async () => {
  await bootRuntime();
  const { runPmsWriteTool } = await import("../../lib/pms/tools.ts");
  // A refusal the agent must explain to a person, rather than a thrown error
  // that ends the step with a stack trace.
  const result = await runPmsWriteTool("create_work_order", { property_id: "p1", summary: "Leak" }, "org_1", "key_1");
  assert.match(String(result.error), /provider/i);
});

test("an unconnected workspace gets a denial, never a silent success", async () => {
  await bootRuntime();
  const { runPmsWriteTool } = await import("../../lib/pms/tools.ts");
  // No integration_connections row, so the matrix cannot resolve `allow`.
  const result = await runPmsWriteTool(
    "create_work_order",
    { provider: "doorloop", property_id: "p1", summary: "Leak" },
    "org_nothing_connected",
    "key_1",
  );
  assert.equal(result.status, "denied");
  assert.equal(result.written, false);
  assert.ok(String(result.detail).length > 0, "a denial must carry a reason the agent can relay");
});

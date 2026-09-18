import assert from "node:assert/strict";
import test from "node:test";
import { PMS_WRITE_TOOL_SCHEMAS, SPEC_BY_NAME } from "../lib/pms/tool-schemas.ts";
import { PMS_WRITE_TOOLS, PMS_WRITE_TOOL_NAMES } from "../lib/pms/tool-map.ts";

/**
 * The model-facing half of the PMS write path.
 *
 * These exist because of how P0.3 failed the first time: the registry, the
 * tool-map and the runtime filter all carried the ten write tools, every test
 * passed, and no schema was ever offered to the model. Each piece was
 * individually correct and the path was not connected. So the assertions here
 * are about the *joins* rather than about any one module.
 *
 * `tests/integration/pms-tools.integration.mjs` covers the half that needs
 * storage — that the schemas reach the list the model is actually given, and
 * what the dispatch refuses.
 */

function schemaFor(name: string) {
  return PMS_WRITE_TOOL_SCHEMAS.find((schema) => schema.name === name);
}

test("every PMS write tool has a schema, and every schema is a PMS write tool", () => {
  // The exact gap that shipped: tool-map knew about ten tools, the model was
  // offered none of them. Either direction of drift is a broken path.
  assert.deepEqual(
    PMS_WRITE_TOOL_SCHEMAS.map((schema) => schema.name).sort(),
    [...PMS_WRITE_TOOL_NAMES].sort(),
  );
});

test("every write tool requires a provider it cannot invent", () => {
  for (const schema of PMS_WRITE_TOOL_SCHEMAS) {
    assert.ok(
      schema.input_schema.required?.includes("provider"),
      `${schema.name} does not require a provider`,
    );
    const provider = schema.input_schema.properties.provider as { enum?: unknown[] };
    // A closed enum is the one narrowing a static schema can do. The per-org
    // narrowing happens in assembly and again in pmsWriteAllowed.
    assert.ok(Array.isArray(provider.enum) && provider.enum.length > 0, `${schema.name} takes a free-form provider`);
  }
});

test("a write tool maps to exactly one capability action", () => {
  // Two tools sharing an action would make the matrix's answer ambiguous.
  const actions = Object.values(PMS_WRITE_TOOLS);
  assert.equal(new Set(actions).size, actions.length);
});

test("the payload mapping matches the keys the DoorLoop adapter reads", () => {
  // The silent-drift case this file exists for. The model speaks snake_case and
  // the adapters read camelCase; if these stop agreeing, the write fails at the
  // provider with a message about a missing field nobody can trace back.
  const workOrder = SPEC_BY_NAME.get("create_work_order")!.payload({
    provider: "doorloop",
    property_id: "prop_1",
    unit_id: "unit_2",
    summary: "Kitchen leak",
    description: "Under the sink",
    priority: "high",
  });
  assert.deepEqual(workOrder, {
    propertyId: "prop_1",
    unitId: "unit_2",
    summary: "Kitchen leak",
    description: "Under the sink",
    priority: "high",
  });

  const dispatch = SPEC_BY_NAME.get("dispatch_vendor")!.payload({
    provider: "doorloop", work_order_id: "wo_9", vendor_id: "v_3",
  });
  assert.deepEqual(dispatch, { workOrderId: "wo_9", vendorId: "v_3" });
});

test("an omitted optional stays omitted rather than becoming null", () => {
  // The adapters test `typeof payload.x === "string"` and send `undefined` to
  // omit a field. A null here would be forwarded to the provider as a real
  // value and clear a field the agent never meant to touch.
  const payload = SPEC_BY_NAME.get("create_work_order")!.payload({
    provider: "doorloop", property_id: "prop_1", summary: "Leak",
  });
  assert.deepEqual(payload, { propertyId: "prop_1", summary: "Leak" });
  assert.equal("unitId" in payload, false);
  assert.equal("description" in payload, false);
});

test("a blank string is treated as absent, not as a value", () => {
  // A model that emits "" for a field it does not know must not have that
  // forwarded as an intentional empty summary.
  const payload = SPEC_BY_NAME.get("close_work_order")!.payload({
    provider: "doorloop", work_order_id: "wo_1", resolution: "   ",
  });
  assert.deepEqual(payload, { workOrderId: "wo_1" });
});

test("money and Fair Housing tools say what they touch", () => {
  // These descriptions are the only words between a model and a customer's
  // system of record. A perfunctory one is a real defect here.
  for (const schema of PMS_WRITE_TOOL_SCHEMAS) {
    assert.ok(schema.description.length > 40, `${schema.name} has a thin description`);
  }
  assert.match(schemaFor("post_payment")!.description, /money|reconciled/i);
});

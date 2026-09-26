import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, allowedToolNames, MAX_DELEGATION_DEPTH } from "../lib/agents/policy.ts";
import { AGENT_PERMISSIONS, roleForPersona, hasPermission } from "../lib/agents/permissions.ts";
import { TOOL_REGISTRY, implementedTools } from "../lib/agents/registry.ts";
import { PERSONAS, type PersonaId } from "../lib/ask-aval/personas.ts";
import { PMS_WRITE_TOOL_NAMES } from "../lib/pms/tool-map.ts";

/**
 * The policy engine is the deterministic half of "agents reason, the backend
 * authorizes". Everything here asserts a *denial* the model cannot argue its
 * way out of, because the failure mode this layer exists to prevent is a
 * permission that holds only as long as the model behaves.
 */

const OWNER = { organizationId: "org_abc", userId: "user_1", isGuest: false };
const GUEST = { organizationId: "org_public_demo", userId: "public-demo-guest", isGuest: true };

test("a tool outside the agent's envelope is denied even when the model asks for it", () => {
  // Lease Review holds documents.read and leases.read, never accounting.read.
  // The realistic path to this call is a lease whose text talks the model into
  // it — which is exactly why enforcement cannot live in the schema list.
  const decision = evaluate("get_delinquent_accounts", {}, OWNER, { personaId: "leaseReview" });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.effect === "deny" && decision.code, "permission_denied");
});

test("the same tool is allowed for an agent that does hold the permission", () => {
  assert.equal(evaluate("get_delinquent_accounts", {}, OWNER, { personaId: "financial" }).effect, "allow");
});

test("an unregistered tool name is denied rather than passed through", () => {
  for (const name of ["drop_tables", "get_portfolio_metrics_v2", "", "__proto__", "runTool"]) {
    const decision = evaluate(name, {}, OWNER, { personaId: "general" });
    assert.equal(decision.effect, "deny", `"${name}" should be denied`);
    assert.equal(decision.effect === "deny" && decision.code, "unknown_tool");
  }
});

test("a final-answer tool is never executable as a capability", () => {
  for (const name of ["render_answer", "compose_document"]) {
    assert.equal(evaluate(name, {}, OWNER, { personaId: "general" }).effect, "deny");
  }
});

test("declared-but-unwired tools are denied, so declaring one grants nothing", () => {
  // `dispatch_vendor` left this list when the PMS write path gave it a real
  // executor. It is still denied for most agents — just by permission and by the
  // capability matrix now, rather than by being unwired.
  for (const name of ["issue_payment", "execute_lease", "authorize_vendor_spend"]) {
    const decision = evaluate(name, { amount_cents: 100, currency: "USD" }, OWNER, { personaId: "general" });
    assert.equal(decision.effect, "deny", `${name} should be denied`);
    assert.equal(decision.effect === "deny" && decision.code, "not_implemented");
  }
});

test("an unknown persona id gets the read-only envelope, never the broad one", () => {
  // A typo, a stale client, or a custom persona row all land here. Narrowing
  // is the safe direction; resolving to `general` would be a privilege grant
  // triggered by a misspelling.
  assert.equal(roleForPersona("finanshul"), "custom");
  assert.equal(evaluate("record_preference", { topic: "tone", statement: "x" }, OWNER, { personaId: "finanshul" }).effect, "deny");
});

test("the shared demo workspace cannot be written to", () => {
  // Every signed-out visitor is the same subject, so one guest's standing
  // preference would steer the next guest's answers.
  const decision = evaluate("record_preference", { topic: "tone", statement: "x" }, GUEST, { personaId: "general" });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.effect === "deny" && decision.code, "guest_mutation_denied");
  // Reads stay open: the demo is the product's front door.
  assert.equal(evaluate("get_portfolio_metrics", {}, GUEST, { personaId: "general" }).effect, "allow");
});

test("delegation deeper than the cap is denied", () => {
  assert.equal(evaluate("get_portfolio_metrics", {}, OWNER, { personaId: "general", delegationDepth: MAX_DELEGATION_DEPTH }).effect, "allow");
  const tooDeep = evaluate("get_portfolio_metrics", {}, OWNER, { personaId: "general", delegationDepth: MAX_DELEGATION_DEPTH + 1 });
  assert.equal(tooDeep.effect, "deny");
  assert.equal(tooDeep.effect === "deny" && tooDeep.code, "delegation_depth_exceeded");
});

test("an exhausted step budget denies further tool calls", () => {
  const decision = evaluate("get_portfolio_metrics", {}, OWNER, { personaId: "general", remainingSteps: 0 });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.effect === "deny" && decision.code, "budget_exhausted");
});

test("every persona's declared tool subset stays inside its permission envelope", () => {
  // The two tables can drift independently. If a persona is granted a tool its
  // envelope does not cover, the tool is silently unusable at runtime — a
  // confusing failure that this test turns into a loud one.
  for (const [id, persona] of Object.entries(PERSONAS) as [PersonaId, (typeof PERSONAS)[PersonaId]][]) {
    for (const toolName of persona.toolNames ?? []) {
      const decision = evaluate(toolName, {}, OWNER, { personaId: id });
      assert.notEqual(decision.effect, "deny", `persona "${id}" lists "${toolName}" but policy denies it: ${decision.effect === "deny" ? decision.reason : ""}`);
    }
  }
});

test("every tool a persona can be offered is registered", () => {
  for (const [id, persona] of Object.entries(PERSONAS)) {
    for (const toolName of persona.toolNames ?? []) {
      assert.ok(TOOL_REGISTRY.has(toolName), `persona "${id}" lists unregistered tool "${toolName}"`);
    }
  }
});

test("the general agent can reach every implemented tool except the specialist PMS writes, and the risk analyst can only write task coordination state", () => {
  const general = new Set(allowedToolNames("general", { isGuest: false }));
  for (const tool of implementedTools()) {
    // Writes into a customer's system of record are deliberately specialist-only:
    // the unspecialized assistant should not be able to post to a resident
    // ledger because someone asked it a broad question. Each PMS write permission
    // belongs to the one role whose job it is (see AGENT_PERMISSIONS).
    if ((PMS_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      assert.equal(general.has(tool.name), false, `general agent should not reach "${tool.name}"`);
      continue;
    }
    if (tool.name === "create_maintenance_work_order") {
      assert.equal(hasPermission("general", tool.requiredPermission), false);
      assert.equal(hasPermission("maintenance", tool.requiredPermission), true);
      continue;
    }
    assert.ok(general.has(tool.name), `general agent cannot reach "${tool.name}"`);
  }
  // §17: the widest reader holds the least mutation authority.
  assert.equal(AGENT_PERMISSIONS.riskAnalyst.some((permission) => permission.endsWith(".write") || permission.endsWith(".execute")), false);
  for (const name of allowedToolNames("riskAnalyst", { isGuest: false })) {
    const tool = TOOL_REGISTRY.get(name)!;
    if (tool.mutates) assert.ok(["plan_goal", "request_peer_help", "wait_for", "write_memory"].includes(name) && tool.requiredPermission === "tasks.manage", `risk analyst may mutate business data through "${name}"`);
  }
});

test("a guest is never offered a mutating tool in the first place", () => {
  for (const name of allowedToolNames("general", { isGuest: true })) {
    assert.equal(TOOL_REGISTRY.get(name)!.mutates, false);
  }
});

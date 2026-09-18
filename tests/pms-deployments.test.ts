import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentDeployment,
  deploymentOwnsAction,
  parseWorkflows,
  unconfiguredAgentMayUseEveryProvider,
} from "../lib/pms/deployment-rules.ts";

/**
 * The deployment narrowing's pure decisions.
 *
 * `tests/integration/pms-deployments.integration.mjs` asserts these against real
 * storage; these pin the two rules that are easy to invert by accident and
 * expensive to get wrong — what a deployment owns, and what an absent
 * deployment means.
 */

function deployment(workflows: AgentDeployment["workflows"]): AgentDeployment {
  return { id: "dep_1", provider: "doorloop", workflows, autonomyMode: "supervised" };
}

test("a deployment owns only the workflows it names", () => {
  const maintenanceOnly = deployment(["maintenance"]);
  assert.equal(deploymentOwnsAction(maintenanceOnly, "maintenance.work_order.create"), true);
  // Same provider, same connection — different workflow, so not this agent's.
  assert.equal(deploymentOwnsAction(maintenanceOnly, "arrears.payment.post"), false);
  assert.equal(deploymentOwnsAction(maintenanceOnly, "leasing.inquiry.reply"), false);
});

test("an unrecognised workflow name is dropped, never treated as a wildcard", () => {
  // A typo in an operator's payload must narrow, not widen.
  assert.deepEqual([...parseWorkflows('["maintenance","maintainance","*"]')], ["maintenance"]);
  assert.deepEqual([...parseWorkflows("not json")], []);
  assert.deepEqual([...parseWorkflows('{"maintenance":true}')], []);
});

test("a deployment that names nothing owns nothing", () => {
  // An empty workflow list is the default on the column. It must read as "owns
  // no workflow here", never as "unspecified, therefore all".
  assert.equal(deploymentOwnsAction(deployment([]), "maintenance.work_order.create"), false);
});

test("an empty deployments table changes nothing; the first row governs the workspace", () => {
  // The migration safety property: a workspace that configured grants and
  // authorizations before deployments existed keeps working untouched.
  assert.equal(unconfiguredAgentMayUseEveryProvider(false), true);
  // And the switch: once the workspace deploys anything, an agent without a row
  // was left out deliberately and gets nothing.
  assert.equal(unconfiguredAgentMayUseEveryProvider(true), false);
});

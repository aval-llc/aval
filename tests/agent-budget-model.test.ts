import assert from "node:assert/strict";
import test from "node:test";

import { BUDGET_MODEL, committed, grantFor, workCanFund, type BudgetedTask, type Grant } from "../lib/agents/budget-model.ts";
import { SPECIALISTS } from "../lib/agents/organization/index.ts";
import { specialistContract } from "../lib/agents/organization/contract.ts";

/**
 * The budget model against the hierarchy shapes that starved the halving rule:
 * a worker must get what its work needs at any depth and in any position, and
 * the Work as a whole must stay bounded.
 */

const executing = SPECIALISTS.find((specialist) => specialistContract(specialist).readiness === "EXECUTION_READY")!;
const analysing = SPECIALISTS.find((specialist) => specialistContract(specialist).readiness === "ANALYSIS_ONLY_READY")!;
const incomplete = SPECIALISTS.find((specialist) => specialistContract(specialist).readiness === "INCOMPLETE")!;
const running = (grant: Grant): BudgetedTask => ({ status: "RUNNING", maxSteps: grant.steps, stepCount: 0, maxTokens: grant.tokens, tokensUsed: 0 });

/** Opens tasks in order against one Work, as the reservation does: fund in full or refuse. */
function openInOrder(asks: Grant[]): { funded: Grant[]; refused: number; tasks: BudgetedTask[] } {
  const tasks: BudgetedTask[] = [];
  const funded: Grant[] = [];
  let refused = 0;
  for (const ask of asks) {
    if (workCanFund(committed(tasks), [ask])) { tasks.push(running(ask)); funded.push(ask); } else refused++;
  }
  return { funded, refused, tasks };
}

test("a Specialist is funded for the work its contract says it does, not for where it sits", () => {
  assert.deepEqual(grantFor(executing.id), BUDGET_MODEL.execution.EXECUTION_READY);
  assert.deepEqual(grantFor(analysing.id), BUDGET_MODEL.execution.ANALYSIS_ONLY_READY);
  assert.deepEqual(grantFor(incomplete.id), BUDGET_MODEL.execution.INCOMPLETE);
  assert.ok(BUDGET_MODEL.execution.EXECUTION_READY.steps > BUDGET_MODEL.execution.ANALYSIS_ONLY_READY.steps, "acting and verifying costs more than concluding");
  assert.deepEqual(grantFor("aval-one"), BUDGET_MODEL.orchestration);
  assert.deepEqual(grantFor("maintenance"), BUDGET_MODEL.orchestration, "a Lead coordinates at every depth");
});

test("Aval One → Lead → Specialist: the Specialist holds its full execution budget", () => {
  const { funded, refused } = openInOrder([grantFor("aval-one"), grantFor("maintenance"), grantFor(executing.id)]);
  assert.equal(refused, 0);
  assert.deepEqual(funded[2], BUDGET_MODEL.execution.EXECUTION_READY);
});

test("Aval One → Lead → four Specialists: the fourth gets what the first got", () => {
  const { funded, refused } = openInOrder([grantFor("aval-one"), grantFor("maintenance"), ...Array(4).fill(grantFor(executing.id))]);
  assert.equal(refused, 0);
  assert.equal(new Set(funded.slice(2).map((grant) => grant.steps)).size, 1, "position in the fan-out does not change the grant");

  // The rule this replaced, for the record: half of what the parent has left,
  // taken from the parent, so the fourth Specialist is left with two steps.
  let lead = 30;
  const halved = [1, 2, 3, 4].map(() => { const child = Math.max(2, Math.floor(lead / 2)); lead -= child; return child; });
  assert.deepEqual(halved, [15, 7, 4, 2]);
});

test("Aval One → Lead → Specialist → peer Specialist: the peer is bounded, the asker keeps its budget", () => {
  const asker = grantFor(executing.id);
  const peer = grantFor(analysing.id, { peer: true });
  assert.ok(peer.steps <= BUDGET_MODEL.peerHelp.steps && peer.steps <= grantFor(analysing.id).steps);
  const { funded, refused } = openInOrder([grantFor("aval-one"), grantFor("maintenance"), asker, peer]);
  assert.equal(refused, 0);
  assert.deepEqual(funded[2], asker, "asking a peer takes nothing from the asker");
});

test("Aval One → Lead A → Specialist → Lead B: a related Lead asked as a peer is held to the peer bound", () => {
  const leadB = grantFor("lead.risk-compliance", { peer: true });
  assert.deepEqual(leadB, { steps: BUDGET_MODEL.peerHelp.steps, tokens: BUDGET_MODEL.peerHelp.tokens });
  const { refused } = openInOrder([grantFor("aval-one"), grantFor("maintenance"), grantFor(executing.id), leadB]);
  assert.equal(refused, 0);
});

test("a Work that keeps delegating is refused before it overspends, and never funds a worker partially", () => {
  const { funded, refused, tasks } = openInOrder([grantFor("aval-one"), ...Array(20).fill(grantFor(executing.id))]);
  assert.ok(refused > 0, "the pool binds");
  assert.ok(committed(tasks).steps <= BUDGET_MODEL.work.steps && committed(tasks).tokens <= BUDGET_MODEL.work.tokens);
  for (const grant of funded.slice(1)) assert.deepEqual(grant, BUDGET_MODEL.execution.EXECUTION_READY, "funded in full or not at all");
});

test("a replan gets back what a superseded or failed node did not spend", () => {
  const spentTwo = { ...running(grantFor(executing.id)), status: "SUPERSEDED", stepCount: 2, tokensUsed: 4_000 };
  assert.deepEqual(committed([spentTwo]), { steps: 2, tokens: 4_000 });
  const failedEarly = { ...running(grantFor(executing.id)), status: "FAILED", stepCount: 1, tokensUsed: 900 };
  assert.deepEqual(committed([failedEarly]), { steps: 1, tokens: 900 });
  assert.deepEqual(committed([running(grantFor(executing.id))]), BUDGET_MODEL.execution.EXECUTION_READY, "unsettled work keeps its whole grant");
});

test("the pool fits the documented largest shape at full budget", () => {
  // Aval One, two Leads, six Specialists and two peers.
  const shape = [grantFor("aval-one"), grantFor("maintenance"), grantFor("lead.risk-compliance"), ...Array(6).fill(grantFor(executing.id)), grantFor(analysing.id, { peer: true }), grantFor(analysing.id, { peer: true })];
  assert.ok(workCanFund({ steps: 0, tokens: 0 }, shape));
});

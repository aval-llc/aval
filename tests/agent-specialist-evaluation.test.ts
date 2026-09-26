import assert from "node:assert/strict";
import test from "node:test";

import { SPECIALISTS, builtInActor, specialistById, leadForDomain, leadRuntimeId } from "../lib/agents/organization/index.ts";
import { specialistContract, isAct, approvalClassOf } from "../lib/agents/organization/contract.ts";
import { routeObjective } from "../lib/agents/organization/routing.ts";
import { CAPABILITY_TOOLS, CANONICAL_CAPABILITIES, CONSOLIDATED_CAPABILITIES } from "../lib/agents/organization/capabilities.ts";
import { EMPTY_PROFILE } from "../lib/organizations/operating-profile.ts";
import { getTool } from "../lib/agents/registry.ts";

/**
 * The evaluation suite every Specialist is held to (directive §33): instantiate
 * it, and check its boundary, inputs, tools, forbidden actions, completion
 * contract, nearest-sibling distinction, wrong-agent handoff and approval
 * posture. One loop over all 266, so a Specialist added tomorrow is held to the
 * same cases the day it lands — and a renamed generic wrapper fails here.
 */

const leadRuntimeIdFor = (domain: Parameters<typeof leadForDomain>[0]) => leadRuntimeId(leadForDomain(domain));

const objectiveFor = (id: string) => {
  const specialist = specialistById(id)!;
  return `${specialist.name}: ${specialist.triggers.slice(0, 3).join(", ")}`;
};

for (const specialist of SPECIALISTS) {
  test(`${specialist.id} meets its evaluation cases`, () => {
    // Instantiates as a runtime actor, briefed with its own definition.
    const actor = builtInActor(specialist.id);
    assert.ok(actor, "instantiates");
    assert.equal(actor.kind, "specialist");
    assert.ok(actor.instructions.includes(specialist.boundary), "briefed with its task boundary");
    for (const rule of specialist.forbidden) assert.ok(actor.instructions.includes(rule), `briefed never to: ${rule}`);
    assert.ok(actor.instructions.includes(specialist.completion.doneWhen) && actor.instructions.includes(specialist.completion.notDoneWhen), "briefed with its completion contract");
    assert.match(actor.instructions, /say which one and stop/, "hands wrong-agent work back rather than doing it");
    assert.ok(specialist.inputs.length > 0, "declares what it needs, so missing input is recognisable");

    // Its tools are exactly what its capabilities map to, and it may only act
    // through a capability whose job is the act.
    const contract = specialistContract(specialist);
    const mapped = new Set(specialist.capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability] ?? []));
    for (const tool of actor.toolNames ?? []) assert.ok(mapped.has(tool), `${tool} comes from a declared capability`);
    const acting = new Set(contract.required.filter(isAct).flatMap((capability) => CAPABILITY_TOOLS[capability] ?? []));
    for (const tool of actor.toolNames ?? []) {
      if (getTool(tool)?.mutates) assert.ok(acting.has(tool), `${tool} mutates, so it must come from a required act`);
    }
    // Every approval-gated act it can reach falls in a declared approval class.
    for (const capability of contract.required.filter(isAct)) {
      const gated = (CAPABILITY_TOOLS[capability] ?? []).some((tool) => getTool(tool)?.requiresApproval);
      if (gated) assert.ok(approvalClassOf(capability), `${capability} is approval-gated and must carry an approval class`);
    }

    // Routing distinguishes it from its nearest sibling.
    const own = routeObjective(objectiveFor(specialist.id), EMPTY_PROFILE, 5);
    assert.equal(own.specialists[0]?.id, specialist.id, "its own objective routes to it first");
    const sibling = routeObjective(objectiveFor(specialist.notThis.specialist), EMPTY_PROFILE, 5);
    const siblingRank = sibling.specialists.findIndex((row) => row.id === specialist.notThis.specialist);
    const ownRank = sibling.specialists.findIndex((row) => row.id === specialist.id);
    assert.ok(ownRank === -1 || ownRank > siblingRank, "its sibling's objective does not route to it ahead of the sibling");

    // Falls back to its sibling for adjacent work and its Lead for anything else.
    assert.equal(contract.fallback.sibling, specialist.notThis.specialist);
    assert.ok(builtInActor(contract.fallback.lead), "falls back to a real Lead");
    assert.equal(builtInActor(contract.fallback.lead)!.domain, leadForDomain(specialist.domain).domain);
    assert.ok(["EXECUTION_READY", "ANALYSIS_ONLY_READY", "INCOMPLETE"].includes(contract.readiness));

    // Analysis-only is a contract the runtime keeps, not a label: nothing the
    // actor is offered can change a record, send or move money.
    if (contract.readiness === "ANALYSIS_ONLY_READY") {
      const analysis = contract.analysis!;
      assert.ok(analysis, "carries its analysis contract");
      assert.ok(actor.toolNames, "a Specialist's toolset is always an explicit list");
      const acting = actor.toolNames.filter((name) => getTool(name)?.mutates && getTool(name)?.requiredPermission !== "tasks.manage");
      assert.deepEqual(acting, [], "an analysis-only Specialist is offered no mutating tool");
      for (const tool of analysis.evidence.tools) assert.ok(actor.toolNames.includes(tool), `evidence tool ${tool} is offered`);
      assert.ok(analysis.returns.length > 0, "names the structured analysis it returns");
      assert.equal(analysis.consumer.lead, leadRuntimeIdFor(specialist.domain), "its Lead consumes the output");
      assert.ok(analysis.forbiddenToExecute.length > 0);
      assert.equal(analysis.completion, specialist.completion);
    } else {
      assert.equal(contract.analysis, undefined, "only analysis-only Specialists carry an analysis contract");
    }
    if (contract.readiness === "EXECUTION_READY") {
      for (const capability of contract.executes) assert.ok(contract.approvalClasses.includes(approvalClassOf(capability)!), `${capability} carries its approval class`);
    }
  });
}

test("readiness is reported honestly across the catalogue", () => {
  const counts = { EXECUTION_READY: 0, ANALYSIS_ONLY_READY: 0, INCOMPLETE: 0 };
  for (const specialist of SPECIALISTS) counts[specialistContract(specialist).readiness]++;
  assert.equal(counts.EXECUTION_READY + counts.ANALYSIS_ONLY_READY + counts.INCOMPLETE, 266);
  for (const specialist of SPECIALISTS) {
    const contract = specialistContract(specialist);
    // An incomplete specialist names exactly what it lacks.
    assert.equal(contract.readiness === "INCOMPLETE", contract.missing.length > 0, specialist.id);
    // Execution-ready means it can act; a declared-but-unwired tool does not count.
    for (const capability of contract.executes) assert.ok((CAPABILITY_TOOLS[capability] ?? []).some((name) => getTool(name) && !getTool(name)!.unimplemented), `${specialist.id}: ${capability}`);
  }
});

test("a retired capability name is gone from the vocabulary and points at one that exists", () => {
  const vocabulary = new Set<string>(CANONICAL_CAPABILITIES);
  for (const [retired, replacement] of Object.entries(CONSOLIDATED_CAPABILITIES)) {
    assert.equal(vocabulary.has(retired), false, `${retired} was consolidated and must not come back`);
    assert.equal(vocabulary.has(replacement), true, `${retired} -> ${replacement}`);
  }
});

test("context-only capabilities are declared, never required, and still resolve to their reads", () => {
  for (const specialist of SPECIALISTS) {
    const context = specialist.contextOnly ?? [];
    const contract = specialistContract(specialist);
    for (const capability of context) {
      assert.ok(specialist.capabilities.includes(capability), `${specialist.id}: ${capability} is context only if it is declared`);
      assert.equal(isAct(capability), false, `${specialist.id}: an act (${capability}) is never mere context`);
      assert.equal(contract.required.includes(capability), false, specialist.id);
      assert.ok(contract.optional.includes(capability), specialist.id);
    }
  }
});

test("verifiers read screening results; only Credit Screening Coordination orders a report", () => {
  const ordering = SPECIALISTS.filter((specialist) => specialist.capabilities.includes("screening.request")).map((specialist) => specialist.id);
  assert.deepEqual(ordering, ["screening.credit-screening-coordination"]);
});

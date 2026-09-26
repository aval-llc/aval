import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAL_ONE, AVAL_ONE_ID, LEADS, SPECIALISTS, NEVER_ROUTABLE, CANONICAL_CAPABILITIES,
  actorHolds, actorMayDelegateTo, actorOrchestrates, actorPermissions, builtInActor, builtInActors,
  deploymentActorId, eligibleDomains, isCanonicalCapability, organizationCounts, resolveActorId,
  specialistMaturity, specialistsForDomain, leadRuntimeId,
} from "../lib/agents/organization/index.ts";
import { AGENT_PERMISSIONS, type AgentRole } from "../lib/agents/permissions.ts";
import { PERSONAS, type PersonaId } from "../lib/ask-aval/persona-catalog.ts";
import { DOMAIN_IDS } from "../lib/agents/organization/types.ts";
import { MAX_DELEGATION_DEPTH, DELEGATION_POLICY } from "../lib/agents/delegation-policy.ts";
import { EMPTY_PROFILE, isMixedPortfolio, normalizeProfile } from "../lib/organizations/operating-profile.ts";
import { getTool } from "../lib/agents/registry.ts";

/**
 * The built-in organization as data: Aval One, 22 Leads, 266 Specialists.
 *
 * What matters is less that the counts are right than that each actor is a
 * real, bounded job and that none of the historical meaning moved.
 */

test("the organization is Aval One, 22 Leads and 266 Specialists across 22 domains", () => {
  assert.deepEqual(organizationCounts(), { avalOne: 1, leads: 22, specialists: 266, domains: 22 });
  assert.equal(new Set(LEADS.map((lead) => lead.domain)).size, DOMAIN_IDS.length, "one Lead per domain");
  for (const domain of DOMAIN_IDS) assert.ok(specialistsForDomain(domain).length > 0, `${domain} has specialists`);
});

test("every actor id is unique and never reused across kinds", () => {
  const ids = builtInActors().map((actor) => actor.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 1 + 22 + 266);
});

test("the historical ids keep exactly their historical envelope and tool subset", () => {
  // `general` and the eight legacy personas are still the keys tasks,
  // approvals, deployments and deep links were recorded under.
  for (const id of Object.keys(PERSONAS) as PersonaId[]) {
    const actor = builtInActor(id);
    assert.ok(actor, `${id} is still an actor`);
    assert.equal(actor.id, id, `${id} runs under its own id, not an alias`);
    assert.deepEqual([...actor.permissions].sort(), [...AGENT_PERMISSIONS[id as AgentRole]].sort(), `${id} keeps its envelope`);
    assert.deepEqual(actor.toolNames, PERSONAS[id].toolNames, `${id} keeps its tool subset`);
  }
  assert.equal(builtInActor("general")?.kind, "aval_one");
  assert.equal(LEADS.filter((lead) => lead.legacyPersonaId).length, 8, "the eight historical agents are eight of the Leads");
});

test("aliases resolve to historical ids, never the other way round", () => {
  assert.equal(resolveActorId(AVAL_ONE.id), AVAL_ONE_ID);
  assert.equal(resolveActorId("lead.finance"), "financial");
  assert.equal(resolveActorId("lead.maintenance"), "maintenance");
  assert.equal(resolveActorId("lead.lease-admin"), "leaseReview");
  assert.equal(resolveActorId("financial"), "financial");
  assert.equal(resolveActorId("lead.screening"), "lead.screening", "a new Lead is its own id");
});

test("an unknown id still gets the read-only envelope, never Aval One's", () => {
  assert.deepEqual(actorPermissions("finanshul"), AGENT_PERMISSIONS.custom);
  assert.equal(actorHolds("finanshul", "messaging.send.external"), false);
  assert.equal(actorOrchestrates("finanshul", "pms.maintenance.write"), false);
  assert.equal(actorMayDelegateTo("finanshul", "maintenance"), false);
});

test("a Specialist holds only what its tools require, and routes nothing", () => {
  for (const specialist of SPECIALISTS) {
    const actor = builtInActor(specialist.id)!;
    assert.deepEqual(actor.orchestrates, [], `${specialist.id} must not route anything`);
    const required = new Set((actor.toolNames ?? []).map((name) => getTool(name)!.requiredPermission));
    for (const permission of actor.permissions) assert.ok(required.has(permission), `${specialist.id} holds ${permission} without a tool that needs it`);
  }
});

test("no actor exercises or routes money movement, contract execution or access changes", () => {
  for (const actor of builtInActors()) {
    for (const permission of NEVER_ROUTABLE) {
      if (permission === "tasks.manage" || permission === "preferences.write") continue;
      assert.equal(actor.permissions.includes(permission), false, `${actor.id} holds ${permission}`);
    }
    for (const permission of actor.orchestrates) assert.equal(NEVER_ROUTABLE.has(permission), false, `${actor.id} routes ${permission}`);
  }
});

test("Aval One can route everything a Lead exercises, and exercises none of it itself", () => {
  const avalOne = builtInActor(AVAL_ONE_ID)!;
  for (const lead of LEADS) {
    const actor = builtInActor(leadRuntimeId(lead))!;
    for (const permission of [...actor.permissions, ...actor.orchestrates]) {
      if (NEVER_ROUTABLE.has(permission)) continue;
      assert.ok(actorHolds(AVAL_ONE_ID, permission) || actorOrchestrates(AVAL_ONE_ID, permission), `Aval One cannot reach ${permission} held by ${lead.name}`);
    }
  }
  for (const permission of ["pms.maintenance.write", "pms.arrears.write", "pms.leasing.write", "maintenance.create", "vendor.dispatch"] as const) {
    assert.equal(actorHolds(AVAL_ONE_ID, permission), false, `Aval One must not itself hold ${permission}`);
  }
  assert.deepEqual([...avalOne.permissions].sort(), [...AGENT_PERMISSIONS.general].sort());
});

test("Leads are not mandatory: Aval One may address any Specialist directly", () => {
  for (const specialist of SPECIALISTS) assert.ok(actorMayDelegateTo(AVAL_ONE.id, specialist.id), specialist.id);
  for (const lead of LEADS) assert.ok(actorMayDelegateTo("general", lead.id), lead.id);
});

test("every historical delegation pair is still an edge of the organization", () => {
  assert.ok(actorMayDelegateTo("financial", "leaseReview"));
  assert.ok(actorMayDelegateTo("riskAnalyst", "maintenance"));
  assert.ok(actorMayDelegateTo("general", "brokerage"));
  assert.equal(actorMayDelegateTo("marketResearch", "leaseReview"), false, "and an undeclared pair is still refused");
});

test("no actor delegates to itself or back to Aval One", () => {
  for (const actor of builtInActors()) {
    assert.equal(actor.delegatesTo.has(actor.id), false, `${actor.id} delegates to itself`);
    assert.equal(actor.delegatesTo.has(AVAL_ONE_ID), false, `${actor.id} delegates to Aval One`);
    for (const target of actor.delegatesTo) assert.ok(builtInActor(target), `${actor.id} → ${target} is not an actor`);
  }
});

test("every Specialist is a real bounded job, not a renamed wrapper", () => {
  const boundaries = new Set<string>();
  for (const specialist of SPECIALISTS) {
    assert.ok(specialist.boundary.length >= 60, `${specialist.id} boundary is too thin`);
    assert.equal(boundaries.has(specialist.boundary), false, `${specialist.id} repeats another boundary`);
    boundaries.add(specialist.boundary);
    assert.notEqual(specialist.notThis.specialist, specialist.id);
    assert.ok(builtInActor(specialist.notThis.specialist), `${specialist.id} names a sibling that does not exist`);
    assert.ok(specialist.completion.doneWhen && specialist.completion.notDoneWhen, `${specialist.id} has no completion contract`);
    assert.ok(specialist.forbidden.length > 0, `${specialist.id} forbids nothing`);
    for (const capability of specialist.capabilities) assert.ok(isCanonicalCapability(capability), `${specialist.id}: ${capability}`);
    assert.ok(["TOOLED", "ROUTABLE"].includes(specialistMaturity(specialist)), "maturity is derived, never claimed");
  }
  assert.ok(CANONICAL_CAPABILITIES.length > 100);
});

test("only the Specialists whose job it is may execute the sensitive acts", () => {
  const holders = (capability: string) => SPECIALISTS.filter((specialist) => (specialist.capabilities as readonly string[]).includes(capability)).map((specialist) => specialist.id);
  assert.deepEqual(holders("payment.post"), ["receivables.payment-posting-and-reconciliation"]);
  assert.deepEqual(holders("payment_plan.create"), ["receivables.payment-plan-coordination"]);
  assert.deepEqual(holders("lease.execute"), [], "nothing executes a lease");
  // Every specialist that recommends a price is briefed against competitor
  // nonpublic data (directive §23), whichever domain it sits in.
  assert.ok(holders("pricing.recommend").length > 0);
  for (const id of holders("pricing.recommend")) assert.match(builtInActor(id)!.instructions, /nonpublic/, `${id} recommends prices without the antitrust boundary`);
  for (const specialist of specialistsForDomain("screening")) {
    assert.equal((specialist.capabilities as readonly string[]).some((capability) => ["communication.send", "application.send", "lease.execute"].includes(capability)), false, `${specialist.id} acts on an applicant`);
  }
});

test("pricing specialists carry the antitrust boundary", () => {
  const lead = LEADS.find((row) => row.domain === "market-revenue")!;
  assert.ok(lead.domainForbidden.some((rule) => /nonpublic/.test(rule)));
  assert.ok(lead.domainForbidden.some((rule) => /coordinated pricing/.test(rule)));
  assert.match(builtInActor("market-revenue.unit-pricing-recommendation")!.instructions, /nonpublic/, "and every one of its specialists is briefed with it");
});

test("routing reaches only the domains a workspace's business applies to", () => {
  const profile = (businessModels: string[], assetClasses: string[] = []) => normalizeProfile({ businessModels, assetClasses });
  const hoa = eligibleDomains(profile(["association_management"], ["association"]));
  assert.equal(hoa.has("hoa"), true);
  assert.equal(hoa.has("leasing-marketing"), false, "no leasing for a pure association manager");
  assert.equal(hoa.has("affordable"), false);
  const ownerOperator = eligibleDomains(profile(["owner_operator"], ["multifamily"]));
  assert.equal(ownerOperator.has("affordable"), false, "no recertification for market-rate only");
  assert.equal(ownerOperator.has("commercial"), false, "no CAM for ordinary residential");
  assert.equal(ownerOperator.has("owner-services"), false, "no client services for an owner/operator");
  assert.equal(ownerOperator.has("leasing-marketing"), true);
  const brokerage = eligibleDomains(profile(["brokerage_leasing"], ["commercial"]));
  assert.equal(brokerage.has("leasing-marketing"), true);
  assert.equal(brokerage.has("maintenance"), false, "a broker does not run the buildings");
  assert.equal(brokerage.has("commercial"), true);
  const corporate = eligibleDomains(profile(["real_estate_corporate"], ["commercial"]));
  assert.equal(corporate.has("lease-admin"), true, "an occupier administers its own leases");
  assert.equal(corporate.has("screening"), false);
  assert.equal(corporate.has("resident-experience"), false);
  const mixed = profile(["property_management", "association_management"], ["multifamily", "association", "commercial"]);
  assert.equal(isMixedPortfolio(mixed), true, "a mixed portfolio is any profile with more than one entry");
  for (const domain of ["hoa", "commercial", "leasing-marketing", "owner-services"] as const) assert.ok(eligibleDomains(mixed).has(domain), domain);
  assert.equal(eligibleDomains(profile(["property_management"])).has("hoa"), true, "an axis left empty never rules a domain out");
  assert.equal(eligibleDomains(EMPTY_PROFILE).size, 22, "a workspace that has not said reaches every domain, as before");
  assert.deepEqual(normalizeProfile({ businessModels: ["property_management", "bogus"], assetClasses: [42] }).businessModels, ["property_management"], "unknown ids are dropped, never trusted");
});

test("a Specialist works inside its Lead's PMS deployments", () => {
  const specialist = specialistsForDomain("maintenance")[0];
  assert.equal(deploymentActorId(specialist.id), "maintenance");
  assert.equal(deploymentActorId("lead.maintenance"), "maintenance");
  assert.equal(deploymentActorId("aval-one"), "general");
});

test("the delegation limit supports Aval One → Lead → Specialist → peer, and no deeper", () => {
  assert.equal(MAX_DELEGATION_DEPTH, 3);
  assert.equal(DELEGATION_POLICY.maxDepth, 3);
  assert.ok(DELEGATION_POLICY.maxFanout >= 1 && DELEGATION_POLICY.maxConcurrentChildren >= 1);
  assert.ok(DELEGATION_POLICY.maxTasksPerWork >= 1 + DELEGATION_POLICY.maxFanout);
});

test("the router names candidates only inside the workspace's business, deterministically", async () => {
  const { routeObjective } = await import("../lib/agents/organization/routing.ts");
  const profile = (businessModels: string[], assetClasses: string[]) => normalizeProfile({ businessModels, assetClasses });
  const leak = "A resident reports a water leak under the kitchen sink";
  const manager = routeObjective(leak, profile(["property_management"], ["multifamily"]));
  assert.equal(manager.leads[0].id, "maintenance", "a leak reaches Maintenance for a property manager");
  assert.ok(manager.specialists.some((row) => row.domain === "maintenance"));
  const broker = routeObjective(leak, profile(["brokerage_leasing"], ["commercial"]));
  assert.equal(broker.leads.some((row) => row.id === "maintenance"), false, "a broker does not run the buildings, so Maintenance is no candidate");
  const hoa = routeObjective("An owner submitted an architectural request to repaint their house", profile(["association_management"], ["association"]));
  assert.equal(hoa.specialists[0].id, "hoa.architectural-request");
  assert.equal(hoa.singleDomain, true);
  const cam = routeObjective("Reconcile the CAM charges for the retail tenants this year", profile(["property_management"], ["commercial"]));
  assert.equal(cam.specialists[0].id, "commercial.cam-reconciliation");
  const noCommercial = routeObjective("Reconcile the CAM charges for the retail tenants this year", profile(["property_management"], ["multifamily"]));
  assert.equal(noCommercial.specialists.some((row) => row.domain === "commercial"), false);
  const affordable = routeObjective("Prepare the recertification for the tenant income review", profile(["property_management"], ["affordable"]));
  assert.equal(affordable.leads[0].id, "lead.affordable");
  assert.equal(routeObjective("hello there", EMPTY_PROFILE).leads.length, 0, "small talk routes nowhere");
  assert.deepEqual(routeObjective(leak, profile(["property_management"], ["multifamily"])), manager, "the same objective and profile always route the same way");
});

test("Ask Aval opens durable Work only when a turn asks for specialist work", async () => {
  const { orchestrationDecision } = await import("../lib/agents/organization/orchestration.ts");
  const pm = normalizeProfile({ businessModels: ["property_management"], assetClasses: ["multifamily", "commercial"] });
  const direct = ["What is our occupancy?", "How many open work orders are there?", "hello", "List the vacant units", "What does the lease say about pets?"];
  const work = [
    "A resident reports a water leak under the kitchen sink, open a work order and dispatch a plumber",
    "Can you reconcile the CAM charges for the retail tenants this year",
    "Market this vacant unit and schedule tours",
    "Prepare the owner statement for September",
  ];
  for (const question of direct) assert.equal(orchestrationDecision(question, pm).delegate, false, `answered directly: ${question}`);
  for (const question of work) {
    const decision = orchestrationDecision(question, pm);
    assert.equal(decision.delegate, true, `opens Work: ${question}`);
    assert.ok(decision.routing.leads.length > 0, "and names the Lead candidates, so nobody has to choose one");
  }
  const broker = normalizeProfile({ businessModels: ["brokerage_leasing"], assetClasses: ["commercial"] });
  assert.equal(orchestrationDecision("Open a work order for the broken heater", broker).routing.leads.some((lead) => lead.id === "maintenance"), false,
    "the workspace's business still decides which Leads the Work may reach");
});

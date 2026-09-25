import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SELECTED_EXPERTISE,
  applyUserSelection,
  routeExpertise,
  scoreCandidate,
  type ExpertiseCandidateInput,
} from "../lib/agents/expertise-routing.ts";

const profile = (over: Partial<ExpertiseCandidateInput> & { slug: string }): ExpertiseCandidateInput => ({
  capabilityTags: [], domains: [], routingSignals: [], requiredCapabilities: [], riskCeiling: "high", ...over,
});

const CATALOGUE: ExpertiseCandidateInput[] = [
  profile({ slug: "maintenance", routingSignals: ["leak", "hvac", "maintenance_request"], domains: ["maintenance"], capabilityTags: ["maintenance"] }),
  profile({ slug: "resident-experience", routingSignals: ["resident", "complaint"], domains: ["resident"], capabilityTags: ["resident"] }),
  profile({ slug: "vendor-coordination", routingSignals: ["vendor", "dispatch"], domains: ["vendor"], capabilityTags: ["vendor"] }),
  profile({ slug: "escalation", routingSignals: ["repeated", "escalate"], domains: ["resident"], riskCeiling: "critical" }),
  profile({ slug: "lease-review", routingSignals: ["lease", "renewal"], domains: ["leasing"] }),
  profile({ slug: "financial", routingSignals: ["ledger", "arrears"], domains: ["financial"] }),
];

test("cross-domain work loads several expertise rather than forcing one", () => {
  // The case the fixed roster could not express: a repeated HVAC complaint is
  // maintenance and resident experience and escalation at once, and the
  // customer should not need four separate bots to say so.
  const decision = routeExpertise(CATALOGUE, {
    workType: "maintenance_request",
    objective: "Resident reports a repeated HVAC leak and wants it escalated",
    domains: ["maintenance", "resident"],
  });
  assert.ok(decision.selected.includes("maintenance"));
  assert.ok(decision.selected.includes("resident-experience"));
  assert.ok(decision.selected.includes("escalation"));
});

test("irrelevant expertise is not injected", () => {
  const decision = routeExpertise(CATALOGUE, {
    workType: "maintenance_request",
    objective: "Resident reports a leak",
    domains: ["maintenance"],
  });
  assert.ok(!decision.selected.includes("financial"), "a leak is not a ledger question");
  assert.ok(!decision.selected.includes("lease-review"));
});

test("no more than the cap is ever loaded", () => {
  const decision = routeExpertise(CATALOGUE, {
    objective: "leak hvac resident complaint vendor dispatch repeated escalate lease renewal ledger arrears",
    domains: ["maintenance", "resident", "vendor", "leasing", "financial"],
  });
  assert.ok(decision.selected.length <= MAX_SELECTED_EXPERTISE);
});

test("pinned expertise is loaded whatever the work looks like", () => {
  const pinned = [...CATALOGUE, profile({ slug: "house-style", pinned: true })];
  const decision = routeExpertise(pinned, { objective: "Nothing in particular" });
  assert.deepEqual(decision.selected, ["house-style"]);
});

test("work that matches nothing loads nothing", () => {
  // Better to brief an employee on nothing than on the wrong thing.
  const decision = routeExpertise(CATALOGUE, { objective: "Say hello" });
  assert.deepEqual(decision.selected, []);
});

test("expertise that cannot run is excluded, not merely outscored", () => {
  const needsTool = profile({
    slug: "dispatching", routingSignals: ["vendor"], domains: ["vendor"],
    requiredCapabilities: ["dispatch_vendor"],
  });
  const withoutTool = routeExpertise([needsTool], { objective: "vendor needed", domains: ["vendor"] });
  assert.deepEqual(withoutTool.selected, []);
  assert.equal(withoutTool.candidates[0].excluded, "missing_capability");

  const withTool = routeExpertise([needsTool], {
    objective: "vendor needed", domains: ["vendor"], availableCapabilities: ["dispatch_vendor"],
  });
  assert.deepEqual(withTool.selected, ["dispatching"]);
});

test("expertise refuses work above its own risk ceiling", () => {
  const cautious = profile({ slug: "cautious", routingSignals: ["payment"], riskCeiling: "low" });
  const decision = routeExpertise([cautious], { objective: "post a payment", riskTier: "critical" });
  assert.deepEqual(decision.selected, []);
  assert.equal(decision.candidates[0].excluded, "risk_ceiling");
});

test("a routing signal matches whole words only", () => {
  const hvac = profile({ slug: "hvac", routingSignals: ["ac"] });
  assert.equal(scoreCandidate(hvac, { objective: "the tenant has a headache" }).score, 0, "'ac' must not match 'headache'");
  assert.ok(scoreCandidate(hvac, { objective: "the ac is broken" }).score > 0);
});

test("the same catalogue and the same work select the same expertise", () => {
  // Reproducibility is the point: two runs must brief an employee identically,
  // or nothing downstream of the briefing can be compared.
  const signals = { objective: "leak and vendor dispatch", domains: ["maintenance", "vendor"] };
  const first = routeExpertise(CATALOGUE, signals);
  const shuffled = routeExpertise([...CATALOGUE].reverse(), signals);
  assert.deepEqual(first.selected, shuffled.selected);
});

test("the decision records what was considered and why, not just what won", () => {
  const decision = routeExpertise(CATALOGUE, { objective: "a leak", domains: ["maintenance"] });
  const maintenance = decision.candidates.find((candidate) => candidate.slug === "maintenance");
  assert.ok(maintenance, "maintenance was considered");
  assert.ok(maintenance.matched.some((reason) => reason.includes("leak")), "the reason is legible");
  assert.equal(decision.decidedBy, "deterministic");
  assert.equal(decision.candidates.length, CATALOGUE.length, "every candidate is on the record");
});

test("an explicit choice by a person wins over the signals", () => {
  const decision = routeExpertise(CATALOGUE, { objective: "a leak", domains: ["maintenance"] });
  const overridden = applyUserSelection(decision, ["financial"], "user_1");
  assert.deepEqual(overridden.selected, ["financial"]);
  assert.equal(overridden.decidedBy, "user");
  assert.equal(overridden.overriddenBy, "user_1");
});

test("a person cannot override an exclusion that is not about relevance", () => {
  // Being unable to run, or refusing the risk tier, are not preferences.
  const needsTool = profile({ slug: "dispatching", requiredCapabilities: ["dispatch_vendor"] });
  const decision = routeExpertise([needsTool], { objective: "vendor" });
  const attempted = applyUserSelection(decision, ["dispatching"], "user_1");
  assert.deepEqual(attempted.selected, []);
  assert.deepEqual(attempted.blocked, ["dispatching"]);
});

test("expertise that does not exist cannot be summoned by name", () => {
  const decision = routeExpertise(CATALOGUE, { objective: "anything" });
  const attempted = applyUserSelection(decision, ["invented-expertise"], "user_1");
  assert.deepEqual(attempted.selected, []);
  assert.deepEqual(attempted.blocked, ["invented-expertise"]);
});

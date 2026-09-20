import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { expertiseProfiles, expertiseSelections } from "../../db/postgres/schema.ts";
import { createEmployee, listEmployees, setEmployeeStatus } from "../../lib/agents/employees.ts";
import { createTask } from "../../lib/agents/tasks.ts";
import {
  SHIPPED_EXPERTISE, STARTER_TEMPLATES, listExpertiseCatalogue,
  grantExpertise, employeeCandidates, selectExpertiseForWork, loadExpertiseInstructions,
  seedWorkspaceEmployees, assignEmployeeForWork,
} from "../../lib/agents/expertise.ts";

/**
 * Expertise as data.
 *
 * What matters is not that the eight still work — it is that they are
 * indistinguishable from anything a customer writes, and that the runtime has
 * no way to tell them apart.
 */
export async function runExpertiseCases(t, { session, userA, userB }) {
  // A brand-new subject bootstraps its own empty workspace, which is the only
  // honest place to assert what a workspace starts with.
  const newcomer = `user_${randomUUID()}`;
  const fresh = (work) => session(newcomer, (s) => work(s, s.identity.organizationId));
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const other = (work) => session(userB, (s) => work(s, s.identity.organizationId));

  await t.test("the shipped catalogue is installed by migration and belongs to nobody", async () => {
    const shipped = await run((s) => s.db.select().from(expertiseProfiles).where(isNull(expertiseProfiles.organizationId)));
    // The migration and the TypeScript catalogue are two copies of one list.
    // Checked rather than trusted: drifting them is exactly how a roster grows
    // back without anyone deciding to grow one.
    assert.deepEqual(
      shipped.map((row) => row.slug).sort(),
      SHIPPED_EXPERTISE.map((row) => row.slug).sort(),
      "the seeded catalogue matches SHIPPED_EXPERTISE",
    );
    // Every legacy specialist survives as expertise rather than as a type.
    const slugs = new Set(shipped.map((row) => row.slug));
    for (const legacy of ["financial-analysis", "brokerage-leasing", "real-estate", "market-research",
                          "maintenance", "risk-analysis", "portfolio-outlook", "lease-review"]) {
      assert.ok(slugs.has(legacy), `${legacy} exists as a profile`);
    }
    // And a workspace that never asked for them can still see them.
    assert.ok((await other((s, org) => listExpertiseCatalogue(s, org))).length >= SHIPPED_EXPERTISE.length);
  });

  await t.test("a workspace cannot author expertise every other workspace would see", async () => {
    const now = new Date();
    await assert.rejects(run((s) => s.db.insert(expertiseProfiles).values({
      id: crypto.randomUUID(), organizationId: null, slug: "smuggled", name: "Smuggled",
      description: "Should never be globally visible.",
      capabilityTagsJson: "[]", domainsJson: "[]", routingSignalsJson: "[]", requiredCapabilitiesJson: "[]",
      instructions: "", riskCeiling: "low", version: 1, enabled: true, createdAt: now, updatedAt: now,
    })), "a null organization is Aval's to write, not a tenant's");
  });

  await t.test("a workspace writes its own expertise and can shadow a shipped one", async () => {
    const now = new Date();
    await run((s, org) => s.db.insert(expertiseProfiles).values({
      id: crypto.randomUUID(), organizationId: org, slug: "turnover", name: "Turnover",
      description: "Unit turns between residents.",
      capabilityTagsJson: JSON.stringify(["turnover"]), domainsJson: JSON.stringify(["property"]),
      routingSignalsJson: JSON.stringify(["turn", "move_out", "make_ready"]),
      requiredCapabilitiesJson: JSON.stringify([]),
      instructions: "Sequence the turn so the unit is rent-ready before the listing goes live.",
      riskCeiling: "medium", version: 1, enabled: true, createdAt: now, updatedAt: now,
    }));
    const catalogue = await run((s, org) => listExpertiseCatalogue(s, org));
    assert.ok(catalogue.some((row) => row.slug === "turnover"), "a customer's own expertise needed no release");
    assert.equal((await other((s, org) => listExpertiseCatalogue(s, org))).some((r) => r.slug === "turnover"), false,
      "and it belongs to that workspace alone");

    // Shadowing: same slug, this workspace's version wins for this workspace.
    await run((s, org) => s.db.insert(expertiseProfiles).values({
      id: crypto.randomUUID(), organizationId: org, slug: "maintenance", name: "Maintenance, our way",
      description: "House rules for repairs.",
      capabilityTagsJson: JSON.stringify(["maintenance"]), domainsJson: JSON.stringify(["maintenance"]),
      routingSignalsJson: JSON.stringify(["repair"]), requiredCapabilitiesJson: JSON.stringify([]),
      instructions: "Always call the resident before dispatching.", riskCeiling: "high",
      version: 1, enabled: true, createdAt: now, updatedAt: now,
    }));
    const shadowed = (await run((s, org) => listExpertiseCatalogue(s, org))).find((r) => r.slug === "maintenance");
    assert.equal(shadowed.name, "Maintenance, our way");
    const elsewhere = (await other((s, org) => listExpertiseCatalogue(s, org))).find((r) => r.slug === "maintenance");
    assert.equal(elsewhere.name, "Maintenance", "the shipped version is untouched for everyone else");
  });

  await t.test("an employee may only load expertise it was granted", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, { name: "Expertise Maya", role: "Resident Operations Manager" }));
    assert.deepEqual(await run((s, org) => employeeCandidates(s, org, employee.id)), [],
      "a new employee knows nothing until somebody decides what it should know");

    const catalogue = await run((s, org) => listExpertiseCatalogue(s, org));
    const wanted = ["resident-experience", "maintenance", "vendor-coordination", "escalation"];
    for (const slug of wanted) {
      const profile = catalogue.find((row) => row.slug === slug);
      await run((s, org) => grantExpertise(s, org, employee.id, profile.id, userA));
    }
    const candidates = await run((s, org) => employeeCandidates(s, org, employee.id));
    assert.equal(candidates.length, wanted.length);
    assert.ok(!candidates.some((row) => row.slug === "financial-analysis"), "ungranted expertise is not a candidate");
  });

  await t.test("one employee handles cross-domain work without four separate bots", async () => {
    // The example from the directive: a repeated HVAC complaint needs resident
    // experience, maintenance, vendor coordination and escalation at once.
    const employee = await run((s, org) => createEmployee(s, org, userA, { name: "Expertise cross domain", role: "Resident Operations Manager" }));
    const catalogue = await run((s, org) => listExpertiseCatalogue(s, org));
    for (const slug of ["resident-experience", "maintenance", "vendor-coordination", "escalation", "financial-analysis"]) {
      const profile = catalogue.find((row) => row.slug === slug);
      await run((s, org) => grantExpertise(s, org, employee.id, profile.id, userA));
    }
    const task = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance",
      goal: "Resident reports a repeated HVAC leak; a vendor visit is needed and they want it escalated",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));

    const { decision, loaded } = await run((s, org) => selectExpertiseForWork(s, org, {
      taskId: task.id, employeeId: employee.id,
      signals: { workType: "maintenance_request", objective: task.goal, domains: ["maintenance", "resident", "vendor"] },
    }));
    assert.ok(decision.selected.length > 1, "several expertise, one employee");
    assert.ok(decision.selected.includes("maintenance"));
    assert.ok(!decision.selected.includes("financial-analysis"), "a leak is not a ledger question");
    assert.equal(loaded.length, decision.selected.length);

    // The decision is on the record, with what was considered and why.
    const [recorded] = await run((s, org) => s.db.select().from(expertiseSelections)
      .where(and(eq(expertiseSelections.organizationId, org), eq(expertiseSelections.taskId, task.id))));
    assert.ok(recorded, "the routing decision is auditable");
    assert.equal(recorded.decidedBy, "deterministic");
    const asArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));
    assert.deepEqual(asArray(recorded.selectedJson).sort(), [...decision.selected].sort());
    assert.ok(asArray(recorded.candidatesJson).length >= decision.selected.length);

    // Only the chosen bodies are read.
    const instructions = await run((s, org) => loadExpertiseInstructions(s, org, decision.selected));
    assert.equal(instructions.length, decision.selected.length);
  });

  await t.test("a person's explicit choice is authoritative and recorded as theirs", async () => {
    const employee = await run((s, org) => createEmployee(s, org, userA, { name: "Expertise overridden", role: "Analyst" }));
    const catalogue = await run((s, org) => listExpertiseCatalogue(s, org));
    for (const slug of ["maintenance", "financial-analysis"]) {
      await run((s, org) => grantExpertise(s, org, employee.id, catalogue.find((r) => r.slug === slug).id, userA));
    }
    const task = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance", goal: "A leak was reported",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));
    const { decision } = await run((s, org) => selectExpertiseForWork(s, org, {
      taskId: task.id, employeeId: employee.id,
      signals: { objective: "A leak was reported", domains: ["maintenance"] },
      requestedSlugs: ["financial-analysis"], requestedBy: userA,
    }));
    assert.deepEqual(decision.selected, ["financial-analysis"], "the operator knew something the signals did not");
    const [recorded] = await run((s, org) => s.db.select().from(expertiseSelections)
      .where(and(eq(expertiseSelections.organizationId, org), eq(expertiseSelections.taskId, task.id))));
    assert.equal(recorded.decidedBy, "user");
    assert.equal(recorded.overriddenBy, userA);
  });

  await t.test("a workspace starts with the team Aval ships, as ordinary employees", async () => {
    // The eight did not become templates that leave a new workspace empty. They
    // are seeded as employees a customer can rename, re-scope, pause or
    // archive — the roster is rows the customer owns now, not a union type.
    const seeded = await fresh((s, org) => seedWorkspaceEmployees(s, org, newcomer));
    assert.equal(seeded, STARTER_TEMPLATES.length, "every starter role arrives as an employee");

    const team = await fresh((s, org) => listEmployees(s, org, { limit: 100 }));
    const roles = new Set(team.map((row) => row.role));
    for (const legacy of ["Financial Analyst", "Maintenance", "Risk Analyst", "Lease Review"]) {
      assert.ok(roles.has(legacy), `${legacy} is present as an employee`);
    }
    assert.ok(team.every((row) => row.status === "active"), "and they are ready to work");

    // Seeding again does not fight what the customer has since decided.
    assert.equal(await fresh((s, org) => seedWorkspaceEmployees(s, org, newcomer)), 0);
    const archived = team.find((row) => row.role === "Market Research");
    await fresh((s, org) => setEmployeeStatus(s, org, archived.id, "archived"));
    assert.equal(await fresh((s, org) => seedWorkspaceEmployees(s, org, newcomer)), 0,
      "an employee somebody deliberately archived does not come back tomorrow");
  });

  await t.test("the coordinator assigns work to the employee equipped for it", async () => {
    // The master agent does not pick by name. It scores the team by the
    // expertise each holds, using the same signals that decide which expertise
    // to load, so "who should do this" and "what does this need" cannot
    // disagree.
    const maintenance = await fresh((s, org) => assignEmployeeForWork(s, org, {
      objective: "A resident reports a leak and the radiator is broken",
      domains: ["maintenance"],
    }));
    assert.ok(maintenance, "somebody is equipped for a repair");
    assert.match(maintenance.role, /Maintenance|Resident/, `routed to ${maintenance.role}`);

    const financial = await fresh((s, org) => assignEmployeeForWork(s, org, {
      objective: "Explain the change in NOI and the arrears ledger this quarter",
      domains: ["financial"],
    }));
    assert.ok(financial, "and for a financial question");
    assert.notEqual(financial.employeeId, maintenance.employeeId, "different work reaches different desks");

    // The same work twice reaches the same desk.
    const again = await fresh((s, org) => assignEmployeeForWork(s, org, {
      objective: "A resident reports a leak and the radiator is broken",
      domains: ["maintenance"],
    }));
    assert.equal(again.employeeId, maintenance.employeeId, "assignment is reproducible");

    // Work nobody is equipped for is a real answer, not the nearest employee.
    assert.equal(
      await fresh((s, org) => assignEmployeeForWork(s, org, { objective: "zzzz qqqq xxxx" })),
      null,
      "nothing scoring means nobody is assigned",
    );
  });

  await t.test("the starter templates are a head start, not a roster", async () => {
    // Each template resolves to expertise that actually exists, and creating
    // from one produces an ordinary employee with no special status.
    const catalogue = await run((s, org) => listExpertiseCatalogue(s, org));
    const known = new Set(catalogue.map((row) => row.slug));
    for (const template of STARTER_TEMPLATES) {
      for (const slug of template.expertise) {
        assert.ok(known.has(slug), `${template.slug} refers to real expertise (${slug})`);
      }
    }
    const template = STARTER_TEMPLATES.find((row) => row.slug === "maintenance");
    const fromTemplate = await run((s, org) => createEmployee(s, org, userA, {
      name: "Expertise from a template", role: template.role, objective: template.objective,
    }));
    const invented = await run((s, org) => createEmployee(s, org, userA, {
      name: "Expertise from nothing", role: "Turnover Coordinator", objective: "Own unit turns end to end.",
    }));
    assert.deepEqual(Object.keys(fromTemplate).sort(), Object.keys(invented).sort(),
      "an employee from a template is the same kind of thing as one invented from scratch");
  });
}

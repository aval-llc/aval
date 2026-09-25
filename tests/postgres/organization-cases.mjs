import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { POST } from "../../app/api/agents/tasks/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";
import { runScheduledSweep } from "../../lib/workers/scheduled-sweep.ts";
import { agentTasks } from "../../db/postgres/schema.ts";
import { createTask, getTask } from "../../lib/agents/tasks.ts";
import { taskBoundary } from "../../lib/agents/task-boundary.ts";
import { delegationRefusal } from "../../lib/agents/delegation.ts";
import { requestPeerHelp, peerReadiness } from "../../lib/agents/peer-help.ts";
import { workSize } from "../../lib/agents/work-identity.ts";
import { createEmployee, employeeScopes, getEmployee, grantScope } from "../../lib/agents/employees.ts";
import { resolvePersona } from "../../lib/ask-aval/personas.ts";
import { DELEGATION_POLICY } from "../../lib/agents/delegation-policy.ts";
import { actorHolds, actorMayDelegateTo, builtInActor, specialistsForDomain } from "../../lib/agents/organization/index.ts";

/**
 * The organization, end to end: Aval One → Lead → Specialist → bounded peer.
 *
 * The acceptance tests set for Phase B, each against the real schema, RLS and
 * runtime rather than against the layer in isolation — every one of these
 * layers passed its own tests while the joins between them were missing, which
 * is the failure this file exists to catch.
 */

const reply = (name, input) => ({ content: [{ type: "tool_use", name, input, id: randomUUID() }], stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 }, routing: { providerId: "test", model: "scripted" } });
const conclusion = (headline) => reply("render_answer", { headline, narrative: "Reviewed the maintenance records available.", confidence: "high" });

const EVIDENCE = (tool) => ({ kind: "evidence", tools: [tool] });

/** A maintenance specialist that can read maintenance performance: the leaf of the golden path. */
function maintenanceReader() {
  const specialist = specialistsForDomain("maintenance").find((candidate) => builtInActor(candidate.id)?.toolNames?.includes("get_maintenance_performance"));
  assert.ok(specialist, "some maintenance specialist reads maintenance performance");
  return specialist.id;
}

/** An asker and a peer it may legitimately ask, and a read both of them hold. */
function peerPair() {
  for (const domain of ["maintenance", "spend-vendor", "inspections", "turns"]) {
    for (const asker of specialistsForDomain(domain)) {
      const actor = builtInActor(asker.id);
      for (const peerId of actor.delegatesTo) {
        const peer = builtInActor(peerId);
        if (peer?.kind !== "specialist") continue;
        const shared = (peer.toolNames ?? []).find((tool) => actor.toolNames?.includes(tool) && tool !== "read_maintenance_context");
        if (shared) return { asker: asker.id, peer: peerId, tool: shared };
      }
    }
  }
  throw new Error("No specialist pair shares a read; the catalogue lost its collaborators.");
}

export async function runOrganizationCases(t, { session, userA, config, administrator }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  /** A root, a Lead under it and a Specialist under that — the shape every case below starts from. */
  const chain = async ({ employeeId = null, specialist = maintenanceReader() } = {}) => {
    const root = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "general", employeeId, goal: `Organization root ${randomUUID()}`, check: { kind: "plan" } }));
    const lead = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "maintenance", employeeId, parentTaskId: root.id, delegationDepth: 1, goal: "Coordinate the maintenance review", check: { kind: "plan" } }));
    const leaf = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: specialist, employeeId, parentTaskId: lead.id, delegationDepth: 2, goal: "Read maintenance performance", check: EVIDENCE("get_maintenance_performance") }));
    return { root, lead, leaf };
  };

  await t.test("1. Aval One → Lead → Specialist runs to completion through the real route and cron", async () => {
    const previousEnv = { ...env };
    env.DATABASE_URL = config.connectionString;
    delete env.HYPERDRIVE;
    const specialist = maintenanceReader();
    try {
      const subject = `organization_${randomUUID()}`;
      const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Organization fixture", emailVerified: true };
      const post = () => new Request("https://app.aval.llc/api/agents/tasks", {
        method: "POST",
        headers: withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity),
        body: JSON.stringify({ goal: "Review maintenance performance across the portfolio", agentId: "aval-one", maxSteps: 24 }),
      });
      const scheduled = [];
      globalThis.__REQUEST_CONTEXT__ = { waitUntil: (promise) => scheduled.push(promise) };
      globalThis.__MODEL__ = async (_env, _org, params) => {
        const goal = typeof params.messages[0]?.content === "string" ? params.messages[0].content : JSON.stringify(params.messages[0]?.content);
        const uses = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : []);
        const planned = uses.some((u) => u.name === "plan_goal");
        if (goal.includes("Review maintenance performance across the portfolio")) {
          return planned ? conclusion("Maintenance reviewed") : reply("plan_goal", { tasks: [
            { key: "maintenance", goal: "Coordinate the maintenance review", agentId: "lead.maintenance", dependsOn: [], check: { kind: "plan" } },
          ] });
        }
        if (goal.includes("Coordinate the maintenance review")) {
          return planned ? conclusion("Team reviewed") : reply("plan_goal", { tasks: [
            { key: "performance", goal: "Read maintenance performance", agentId: specialist, dependsOn: [], check: EVIDENCE("get_maintenance_performance") },
          ] });
        }
        return uses.some((u) => u.name === "get_maintenance_performance") ? conclusion("Performance read") : reply("get_maintenance_performance", {});
      };
      globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
        const packet = JSON.parse(params.messages[0].content);
        const keys = packet.phase === "plan" ? (packet.proposal?.tasks ?? []).map((task) => task.key) : [];
        // An answer is judged claim by claim, each cited to a real source —
        // the same contract the planner fixtures follow.
        const source = (packet.sources ?? []).find((s) => !s.failed && s.data && typeof s.data === "object" && Object.keys(s.data).length);
        const claims = packet.phase === "plan" || !source ? [] : [{ claim: "Maintenance records", kind: "fact", supported: true,
          citations: [{ sourceId: source.id, pointer: "/" + Object.keys(source.data)[0].replaceAll("~", "~0").replaceAll("/", "~1") }] }];
        return reply("semantic_verdict", { passed: true, issues: [],
          requirements: [{ requirement: packet.goal, satisfied: true, explanation: "Scripted organization fixture", nodeKeys: keys }],
          claims });
      };

      const response = await POST(post());
      assert.equal(response.status, 202, "the route accepts work addressed to Aval One by its alias");
      const { id } = await response.json();
      const org = (await administrator.query("select organization_id from agent_tasks where id=$1", [id])).rows[0].organization_id;
      await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [org]);
      await Promise.all(scheduled);

      const read = async (taskId) => (await administrator.query("select * from agent_tasks where id=$1", [taskId])).rows[0];
      for (let sweep = 0; sweep < 24; sweep++) {
        await runScheduledSweep(env);
        if (["COMPLETED", "FAILED", "CANCELLED"].includes((await read(id)).status)) break;
      }
      const all = (await administrator.query("select * from agent_tasks where work_id=$1 order by delegation_depth", [id])).rows;
      const [root, lead, leaf] = all;
      assert.equal(all.length, 3, `one Work, three tasks: ${all.map((row) => `${row.agent_id}:${row.status}:${row.error ?? ""}`).join(" | ")}`);
      assert.equal(lead.agent_id, "maintenance", "the Lead alias resolves to the historical id work is recorded under");
      assert.equal(lead.delegation_depth, 1);
      assert.equal(leaf.agent_id, specialist);
      assert.equal(leaf.delegation_depth, 2);
      assert.equal(leaf.status, "COMPLETED", leaf.error);
      assert.equal(lead.status, "COMPLETED", lead.error);
      assert.equal(root.status, "COMPLETED", root.error);
    } finally {
      delete globalThis.__REQUEST_CONTEXT__;
      delete globalThis.__MODEL__;
      delete globalThis.__SEMANTIC_MODEL__;
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, previousEnv);
    }
  });

  await t.test("2. a Specialist asks a legitimate peer for help and resumes with its answer", async () => {
    const pair = peerPair();
    const { leaf } = await chain({ specialist: pair.asker });
    const result = await run((s, org) => requestPeerHelp(s, org, leaf.id, { agentId: pair.peer, question: "What does your record show?", check: EVIDENCE(pair.tool) }));
    const peer = await run((s, org) => getTask(s, org, result.peerTaskId));
    assert.equal(peer.agentId, pair.peer);
    assert.equal(peer.parentTaskId, leaf.id);
    assert.equal(peer.delegationDepth, 3, "the peer sits one level below the asker, at the policy's deepest level");
    assert.equal(peer.workId, leaf.workId, "and inside the same Work");

    const asker = await run((s, org) => getTask(s, org, leaf.id));
    assert.deepEqual(JSON.parse(asker.executionScopeJson).awaiting, [peer.id], "the asker records what it waits on");
    assert.equal((await run((s) => peerReadiness(s, asker))).wait, true, "and waits while the peer works");
    await run((s) => s.db.update(agentTasks).set({ status: "COMPLETED", resultJson: JSON.stringify({ headline: "Two prior repairs" }), finishedAt: new Date() }).where(eq(agentTasks.id, peer.id)));
    const ready = await run((s) => peerReadiness(s, asker));
    assert.equal(ready.wait, false, "a settled peer releases the asker");
    assert.match(ready.context, /Two prior repairs/, "with the peer's answer as context");
    assert.match(ready.context, /not a provider fact/, "framed as a peer's view, not authority");
  });

  await t.test("3. circular A → B → C → A delegation is refused", async () => {
    const { leaf } = await chain();
    // C is a Lead that may, in general, hand work to Maintenance — so the only
    // reason left to refuse is the loop.
    assert.equal(actorMayDelegateTo("lead.spend-vendor", "maintenance"), true);
    const c = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "lead.spend-vendor", parentTaskId: leaf.id, delegationDepth: 2, goal: "Check vendor history", check: { kind: "plan" } }));
    const refusal = await run((s, org) => delegationRefusal(s, org, c, { agentId: "maintenance" }));
    assert.match(refusal ?? "", /loop/i, `A → B → C → A must be refused as a loop: ${refusal}`);
  });

  await t.test("4. the same sub-problem asked twice is reused, not run twice", async () => {
    const pair = peerPair();
    const { leaf } = await chain({ specialist: pair.asker });
    const question = { agentId: pair.peer, question: "Summarise the open items", check: EVIDENCE(pair.tool) };
    const first = await run((s, org) => requestPeerHelp(s, org, leaf.id, question));
    const size = await run((s, org) => workSize(s, org, leaf.workId));
    const second = await run((s, org) => requestPeerHelp(s, org, leaf.id, { ...question, question: "  summarise the OPEN items " }));
    assert.equal(second.peerTaskId, first.peerTaskId, "whitespace and case do not make a different question");
    assert.equal(second.reused, true);
    assert.equal(await run((s, org) => workSize(s, org, leaf.workId)), size, "and no task was added to the Work");
  });

  await t.test("5. authority never expands through delegation", async () => {
    // A peer request cannot reach a permission the asker lacks, even where the
    // peer holds it: a Specialist routes nothing.
    const asker = specialistsForDomain("market-revenue").find((candidate) => !actorHolds(candidate.id, "maintenance.read"));
    const { leaf } = await chain({ specialist: asker.id });
    await assert.rejects(
      run((s, org) => requestPeerHelp(s, org, leaf.id, { agentId: maintenanceReader(), question: "Read maintenance", check: EVIDENCE("get_maintenance_performance") })),
      /widen authority|may not delegate/i,
    );
    // The executing Specialist must hold the permission itself; a Lead above it
    // that holds it does not lend it.
    assert.match(await run((s, org) => taskBoundary(s, org, userA, leaf.id, "get_maintenance_performance", {})) ?? "", /does not grant/);

    // An employee's grant is the ceiling of everything its work opens.
    const creator = specialistsForDomain("maintenance").find((candidate) => actorHolds(candidate.id, "maintenance.create"));
    assert.ok(creator, "some maintenance specialist creates work orders");
    const employee = await run((s, org) => createEmployee(s, org, userA, { name: `Ceiling ${randomUUID().slice(0, 6)}`, role: "Maintenance Operations", status: "active" }));
    await run((s, org) => grantScope(s, org, employee.id, userA, { kind: "capability", value: "get_maintenance_performance" }));
    const owned = await chain({ employeeId: employee.id, specialist: creator.id });
    assert.match(await run((s, org) => taskBoundary(s, org, userA, owned.leaf.id, "create_maintenance_work_order", {})) ?? "", /does not grant/,
      "a Specialist working for an employee cannot exceed the employee's grant");
    await run((s, org) => grantScope(s, org, employee.id, userA, { kind: "capability", value: "create_maintenance_work_order" }));
    assert.equal(await run((s, org) => taskBoundary(s, org, userA, owned.leaf.id, "create_maintenance_work_order", {})), null,
      "and once the employee holds it, Aval One → Lead → Specialist may exercise it");
  });

  await t.test("6. excessive recursive delegation is stopped deterministically", async () => {
    const pair = peerPair();
    const { leaf } = await chain({ specialist: pair.asker });
    const { peerTaskId } = await run((s, org) => requestPeerHelp(s, org, leaf.id, { agentId: pair.peer, question: "Depth probe", check: EVIDENCE(pair.tool) }));
    const deepest = await run((s, org) => getTask(s, org, peerTaskId));
    assert.equal(deepest.delegationDepth, DELEGATION_POLICY.maxDepth);
    assert.ok(await run((s, org) => delegationRefusal(s, org, deepest, { agentId: pair.asker })), "nothing may be opened below the deepest level");

    // A chain written around the checks is still refused where it acts.
    const tooDeep = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: pair.asker, parentTaskId: deepest.id, delegationDepth: DELEGATION_POLICY.maxDepth + 1, goal: "Written past the limit", check: EVIDENCE(pair.tool) }));
    assert.match(await run((s, org) => taskBoundary(s, org, userA, tooDeep.id, pair.tool, {})) ?? "", /excessive task ancestry/);

    // And a Work cannot grow past its size, however shallow.
    const { root } = await chain();
    const existing = await run((s, org) => workSize(s, org, root.id));
    for (let i = existing; i < DELEGATION_POLICY.maxTasksPerWork; i++) {
      const filler = await run((s, org) => createTask(s, { organizationId: org, userId: userA, agentId: "maintenance", parentTaskId: root.id, delegationDepth: 1, goal: `Filler ${randomUUID()}`, check: { kind: "plan" } }));
      await run((s) => s.db.update(agentTasks).set({ status: "COMPLETED" }).where(eq(agentTasks.id, filler.id)));
    }
    assert.match(await run((s, org) => delegationRefusal(s, org, root, { agentId: "lead.turns" })) ?? "", /already has \d+ tasks/);
  });

  await t.test("custom personas become employees under the same id, with their access and history", async () => {
    const org = await run((s, o) => o);
    const reader = randomUUID(), everything = randomUUID(), clash = randomUUID();
    const taken = `Taken ${randomUUID().slice(0, 6)}`;
    await run((s, o) => createEmployee(s, o, userA, { name: taken, role: "Existing", status: "active" }));
    const now = new Date();
    const insert = (id, label, tools) => administrator.query(
      "insert into agent_personas (id, organization_id, label, focus_description, tool_names_json, shape, theme, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,'circle','ember',$6,$7,$7)",
      [id, org, label, `Focus of ${label}`, tools === null ? null : JSON.stringify(tools), userA, now]);
    await insert(reader, `Lease reader ${reader.slice(0, 4)}`, ["read_document", "list_documents", "create_work_order"]);
    await insert(everything, `Generalist ${everything.slice(0, 4)}`, null);
    await insert(clash, taken, ["get_portfolio_metrics"]);
    const history = await run((s, o) => createTask(s, { organizationId: o, userId: userA, agentId: reader, goal: "Work a persona ran before the migration", check: EVIDENCE("read_document") }));

    const migration = await readFile(new URL("../../supabase/migrations/20260925000200_custom_personas_to_employees.sql", import.meta.url), "utf8");
    await administrator.query(migration);
    await administrator.query(migration); // replay is a no-op

    const employee = await run((s, o) => getEmployee(s, o, reader));
    assert.ok(employee, "the persona's id is now an employee's id");
    assert.equal(employee.role, "Custom agent");
    assert.equal(employee.objective, `Focus of ${employee.name}`);
    assert.deepEqual([...(await run((s, o) => employeeScopes(s, o, reader))).capability].sort(), ["list_documents", "read_document"],
      "its tools carry over, reads only — a persona could never write");
    assert.ok((await run((s, o) => employeeScopes(s, o, everything))).capability.includes("get_portfolio_metrics"), "a null tool list meant every read");
    assert.match((await run((s, o) => getEmployee(s, o, clash))).name, new RegExp(`^${taken} \\(`), "a taken name keeps its label with a suffix");

    const task = await run((s, o) => getTask(s, o, history.id));
    assert.equal(task.employeeId, reader, "its past work is owned by the employee");
    assert.equal(task.agentId, reader, "and its recorded attribution is untouched");
    const persona = await run((s, o) => resolvePersona(s, reader, o));
    assert.equal(persona.id, reader, "the old id still resolves, now through the employee");
    assert.deepEqual([...persona.toolNames].sort(), ["list_documents", "read_document"]);
  });
}

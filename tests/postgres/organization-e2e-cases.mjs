import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST as ask } from "../../app/api/assistant/ask/route.ts";
import { GET as listTasks, POST as openTask } from "../../app/api/agents/tasks/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";
import { runScheduledSweep } from "../../lib/workers/scheduled-sweep.ts";
import { withDbSession } from "../../db/postgres/session.ts";
import { createEmployee, grantScope } from "../../lib/agents/employees.ts";
import { LEADS, builtInActor, leadRuntimeId, specialistById, specialistsForDomain } from "../../lib/agents/organization/index.ts";
import { specialistContract } from "../../lib/agents/organization/contract.ts";
import { BUDGET_MODEL, grantFor } from "../../lib/agents/budget-model.ts";

/**
 * The organization end to end, one representative objective per Lead domain,
 * every one entering through a public route:
 *
 *   request → durable Work → Aval One → Lead → Specialist → its tools →
 *   evidence → Lead → Aval One → completion
 *
 * plus the failures the hierarchy E2E (hierarchy-e2e-cases.mjs) does not
 * already inject: a capability that is absent, peer help, a provider wait
 * that must not churn, and a connection revoked in the middle of a run. Only
 * the model is scripted; routes, cron, runtime, policy, delegation, budgets,
 * the reviewer contract and the database are real.
 */

const reply = (name, input) => ({ content: [{ type: "tool_use", name, input, id: randomUUID() }], stop_reason: "tool_use", usage: { input_tokens: 80, output_tokens: 40 }, routing: { providerId: "test", model: "scripted" } });
const answer = (headline) => reply("render_answer", { headline, narrative: "Worked from the records available.", confidence: "high" });
const used = (uses, name) => uses.some((use) => use.name === name);
/** Letters only: a digit in a scripted headline is a figure the faithfulness gate rightly refuses. */
const letters = () => [...randomUUID().replaceAll("-", "")].map((c) => String.fromCharCode(97 + (parseInt(c, 16) % 26))).join("").slice(0, 8);
const HARNESS = ["render_answer", "read_memory", "write_memory", "read_task_history", "wait_for", "request_peer_help", "list_documents"];

/** Reads that need no arguments, so a scripted Specialist can call one unprompted. */
const NO_ARG_READS = ["get_property_breakdown", "get_turns", "get_accounting_breakdown", "list_documents", "get_vendors", "get_owners", "get_portfolio_metrics", "get_leads", "get_connection_health", "get_maintenance_performance", "get_expiring_leases", "get_available_units", "get_workspace_staff", "get_leasing_funnel", "get_delinquent_accounts", "get_utility_bills", "get_operations_insights"];
// Communication reads need a connected channel to return anything; they are
// exercised by the employee cases below, which connect one.

/** For each domain, the first Specialist that is ready and offered a no-argument read — or none, where the capability is absent. */
function representatives() {
  return LEADS.map((lead) => {
    const specialist = specialistsForDomain(lead.domain).find((candidate) => specialistContract(candidate).readiness !== "INCOMPLETE" && NO_ARG_READS.some((tool) => builtInActor(candidate.id).toolNames.includes(tool)));
    return {
      domain: lead.domain,
      lead: leadRuntimeId(lead),
      specialist: specialist?.id ?? specialistsForDomain(lead.domain)[0].id,
      tool: specialist ? NO_ARG_READS.find((tool) => builtInActor(specialist.id).toolNames.includes(tool)) : null,
    };
  });
}

export async function runOrganizationE2ECases(t, { config, administrator }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;

  /** A fresh workspace whose model is the scripted fixture. */
  async function workspace() {
    const subject = `org_e2e_${randomUUID()}`;
    const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Organization E2E", emailVerified: true };
    const headers = () => withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity);
    assert.equal((await listTasks(new Request("https://app.aval.llc/api/agents/tasks", { headers: headers() }))).status, 200);
    const org = (await administrator.query("select organization_id from organization_members where user_id=$1", [subject])).rows[0].organization_id;
    await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [org]);
    return { subject, org, headers };
  }

  /**
   * Scripts the model per role. Roles are recognised by a tag in each goal, so
   * the global cron running other cases' leftovers never reaches this script.
   */
  function script(roles) {
    const seen = new Map();
    globalThis.__REQUEST_CONTEXT__ = { waitUntil: () => {} };
    globalThis.__MODEL__ = async (_env, _org, params) => {
      const goal = typeof params.messages[0]?.content === "string" ? params.messages[0].content : JSON.stringify(params.messages[0]?.content);
      const role = Object.keys(roles).find((tag) => goal.includes(tag));
      if (!role) return answer("Outside this scenario");
      const uses = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : []);
      const results = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []);
      const entry = seen.get(role) ?? { calls: 0, reviews: 0, offered: [], system: "" };
      entry.calls++; entry.offered = params.tools.map((tool) => tool.name); entry.system = params.system;
      seen.set(role, entry);
      return roles[role]({ uses, results, n: entry.calls, system: params.system });
    };
    globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
      const packet = JSON.parse(params.messages[0].content);
      const role = Object.keys(roles).find((tag) => packet.goal.includes(tag));
      if (role && seen.has(role)) seen.get(role).reviews++;
      const keys = packet.phase === "plan" ? (packet.proposal?.tasks ?? []).map((task) => task.key) : [];
      const source = (packet.sources ?? []).find((s) => !s.failed && s.data && typeof s.data === "object" && Object.keys(s.data).length);
      const claims = packet.phase === "plan" || !source ? [] : [{ claim: "Records read", kind: "fact", supported: true, citations: [{ sourceId: source.id, pointer: "/" + Object.keys(source.data)[0].replaceAll("~", "~0").replaceAll("/", "~1") }] }];
      return reply("semantic_verdict", { passed: true, issues: [], requirements: [{ requirement: packet.goal, satisfied: true, explanation: "Scripted fixture", nodeKeys: keys }], claims });
    };
    return seen;
  }

  const rowsOf = async (workId) => (await administrator.query("select * from agent_tasks where work_id=$1 order by delegation_depth, created_at", [workId])).rows;
  const sweep = async (times, until) => { for (let i = 0; i < times; i++) { await runScheduledSweep(env); if (until && await until()) return; } };
  const settled = (workId) => async () => ["COMPLETED", "FAILED", "CANCELLED"].includes((await rowsOf(workId))[0]?.status);
  const dump = async (workId) => JSON.stringify((await rowsOf(workId)).map((row) => ({ agent: row.agent_id, status: row.status, error: row.error })));

  /**
   * A request as a person would put it: asking for the Specialist's own work
   * in its own words, so the real router — not the test — decides it is work
   * for the organization.
   */
  const objectiveFor = (specialistId, tag) => {
    const specialist = specialistById(specialistId);
    return `Please handle this: ${specialist.name.toLowerCase()} — ${specialist.triggers.slice(0, 4).join(", ")}. [Q:${tag}]`;
  };

  /** Opens a chat turn through the public ask route and returns its Work id. */
  async function viaChat(space, question) {
    const turn = randomUUID();
    await administrator.query("insert into assistant_chat_entries(organization_id,user_id,id,payload) values ($1,$2,$3,$4::jsonb)", [space.org, space.subject, turn, JSON.stringify({ id: turn, role: "user", text: question })]);
    const response = await ask(new Request("https://app.aval.llc/api/assistant/ask", { method: "POST", headers: space.headers(), body: JSON.stringify({ question, chatMessageId: turn, personaId: "general", locale: "en" }) }));
    assert.equal(response.status, 202, "the request becomes durable Work");
    return (await response.json()).work.taskId;
  }

  /** The normal three-level path for one objective, with a tag for each role. */
  function hierarchy({ lead, specialist, tool, tag }) {
    const L = `[L:${tag}]`, S = `[S:${tag}]`;
    return {
      [`[Q:${tag}]`]: ({ uses }) => used(uses, "plan_goal") ? answer(`Done ${tag}`)
        : reply("plan_goal", { tasks: [{ key: "lead", goal: `${L} Coordinate this objective`, agentId: lead, dependsOn: [], check: { kind: "plan" } }] }),
      [L]: ({ uses }) => used(uses, "plan_goal") ? answer(`Lead done ${tag}`)
        : reply("plan_goal", { tasks: [{ key: "work", goal: `${S} Do the specialist work`, agentId: specialist, dependsOn: [], check: { kind: "evidence", tools: [tool] } }] }),
      [S]: ({ uses }) => used(uses, tool) ? answer(`Specialist evidence ${tag}`) : reply(tool, {}),
    };
  }

  try {
    const all = representatives();
    const ready = all.filter((row) => row.tool);
    const absent = all.filter((row) => !row.tool);

    await t.test(`one objective per ready Lead domain (${ready.length}) runs the whole chain and returns evidence upward`, async () => {
      assert.ok(ready.length >= 16, `ready domains: ${ready.map((row) => row.domain).join(", ")}`);
      for (const row of ready) {
        const space = await workspace();
        const tag = `${row.domain}-${letters()}`;
        const seen = script(hierarchy({ ...row, tag }));
        const workId = await viaChat(space, objectiveFor(row.specialist, tag));
        await sweep(40, settled(workId));
        const [root, lead, leaf] = await rowsOf(workId);
        assert.equal(root.status, "COMPLETED", `${row.domain}: ${await dump(workId)}`);
        assert.equal(lead.agent_id, row.lead, `${row.domain}: Aval One handed it to its Lead`);
        assert.equal(lead.status, "COMPLETED", `${row.domain}: ${lead.error}`);
        assert.equal(leaf.agent_id, row.specialist, `${row.domain}: the Lead handed it to its Specialist`);
        assert.equal(leaf.status, "COMPLETED", `${row.domain}: ${leaf.error}`);
        assert.deepEqual([root.delegation_depth, lead.delegation_depth, leaf.delegation_depth], [0, 1, 2]);
        // Tools: the Specialist is offered its read and nothing outside its own toolset.
        const offered = seen.get(`[S:${tag}]`).offered;
        assert.ok(offered.includes(row.tool), `${row.domain}: offered ${row.tool}`);
        assert.ok(offered.every((name) => builtInActor(row.specialist).toolNames.includes(name) || HARNESS.includes(name)), `${row.domain}: offered only its own tools: ${offered}`);
        // Execution and evidence: the read ran, and its result reached the Lead, then Aval One.
        const steps = (await administrator.query("select kind, tool_name from agent_task_steps where task_id=$1", [leaf.id])).rows;
        assert.ok(steps.some((step) => step.kind === "tool_call" && step.tool_name === row.tool), `${row.domain}: ${row.tool} executed`);
        assert.ok(seen.get(`[L:${tag}]`).system.includes(`Specialist evidence ${tag}`), `${row.domain}: the Specialist's result flowed up to the Lead`);
        assert.ok(seen.get(`[Q:${tag}]`).system.includes(`Lead done ${tag}`), `${row.domain}: and the Lead's to Aval One`);
        // Budgets: every level funded for its own work.
        assert.equal(lead.max_steps, grantFor(row.lead).steps, `${row.domain}: Lead budget`);
        assert.equal(leaf.max_steps, grantFor(row.specialist).steps, `${row.domain}: Specialist budget`);
        // A minimal read-only objective should not burn its whole allowance.
        // Scripted counts measure runtime overhead, not real-model efficiency.
        const metrics = ["Q", "L", "S"].map(level => {
          const entry = seen.get(`[${level}:${tag}]`);
          assert.equal(entry.calls, 2, `${row.domain}/${level}: one action and one conclusion`);
          assert.ok(entry.reviews >= 1 && entry.reviews <= 2, `${row.domain}/${level}: bounded review calls (${entry.reviews})`);
          return { level, modelCalls: entry.calls, reviewCalls: entry.reviews };
        });
        assert.equal((await rowsOf(workId)).length, 3, `${row.domain}: no duplicate delegated tasks`);
        assert.equal(steps.filter(step => step.kind === "tool_call" && step.tool_name === row.tool).length, 1, `${row.domain}: gather evidence once`);
        const before = metrics.map(entry => [entry.modelCalls, entry.reviewCalls]);
        await runScheduledSweep(env);
        assert.deepEqual(["Q", "L", "S"].map(level => {
          const entry = seen.get(`[${level}:${tag}]`); return [entry.calls, entry.reviews];
        }), before, `${row.domain}: completed work causes no more model or review calls`);
        t.diagnostic(`AGENT_EFFICIENCY ${JSON.stringify({ domain: row.domain, metrics, tasks: 3, evidenceReads: 1, liveModel: false })}`);
      }
    });

    await t.test(`a capability that is absent (${absent.length} domains) is refused by name, not attempted`, async () => {
      for (const row of absent) {
        const space = await workspace();
        const tag = `${row.domain}-${letters()}`;
        const L = `[L:${tag}]`;
        let refusal = "";
        script({
          [`[Q:${tag}]`]: ({ uses }) => used(uses, "plan_goal") ? answer(`Reported ${tag}`)
            : reply("plan_goal", { tasks: [{ key: "lead", goal: `${L} Coordinate this objective`, agentId: row.lead, dependsOn: [], check: { kind: "plan" } }] }),
          // The Lead tries to assign the work; the refusal names the gap, and it
          // reports that rather than trying again.
          [L]: ({ uses, results }) => {
            const planned = uses.filter((use) => use.name === "plan_goal").at(-1);
            const outcome = planned && results.find((result) => result.tool_use_id === planned.id);
            if (outcome?.is_error) { refusal = typeof outcome.content === "string" ? outcome.content : JSON.stringify(outcome.content); return answer(`Cannot yet: ${tag}`); }
            if (planned) return answer(`Cannot yet: ${tag}`);
            return reply("plan_goal", { tasks: [{ key: "work", goal: `[S:${tag}] Do the specialist work`, agentId: row.specialist, dependsOn: [], check: { kind: "evidence", tools: ["get_maintenance_performance"] } }] });
          },
        });
        const workId = await viaChat(space, objectiveFor(row.specialist, tag));
        await sweep(40, async () => (await rowsOf(workId)).some((task) => task.agent_id === row.lead && ["COMPLETED", "WAITING_FOR_HUMAN", "FAILED"].includes(task.status)));
        const rows = await rowsOf(workId);
        const lead = rows.find((task) => task.agent_id === row.lead);
        assert.equal(rows.some((task) => task.agent_id === row.specialist), false, `${row.domain}: no Specialist task was opened for work it cannot do`);
        assert.equal(rows.some((task) => task.status === "FAILED"), false, `${row.domain}: an absent capability is not a failure: ${await dump(workId)}`);
        // The Lead cannot finish work nobody can do: it goes to a person, with
        // the gap named in what that person is shown.
        assert.equal(lead.status, "WAITING_FOR_HUMAN", `${row.domain}: ${await dump(workId)}`);
        const missing = specialistContract(specialistById(row.specialist)).missing;
        assert.ok(missing.length > 0 && missing.some((capability) => refusal.includes(capability)), `${row.domain}: the refusal names what is missing (${missing}): ${refusal}`);
        assert.ok(missing.some((capability) => (lead.error ?? "").includes(capability)), `${row.domain}: and so does the hand-off: ${lead.error}`);
      }
    });

    await t.test("peer help through the route: the Specialist asks, the peer answers on a peer's budget, the asker finishes", async () => {
      const space = await workspace();
      const tag = `peer-${letters()}`;
      const asker = "maintenance.vendor-dispatch";
      const peer = "lead.spend-vendor";
      assert.ok(builtInActor(asker).delegatesTo.has(peer), "a Specialist may ask a related Lead");
      const P = `[P:${tag}]`;
      script({
        ...hierarchy({ lead: "maintenance", specialist: asker, tool: "get_vendors", tag }),
        [`[S:${tag}]`]: ({ uses }) => !used(uses, "request_peer_help") ? reply("request_peer_help", { agentId: peer, question: `${P} Has this plumber missed an SLA this year?`, check: { kind: "evidence", tools: ["get_vendors"] } })
          : !used(uses, "get_vendors") ? reply("get_vendors", {}) : answer(`Specialist evidence ${tag}`),
        [P]: ({ uses }) => used(uses, "get_vendors") ? answer(`Peer answer ${tag}`) : reply("get_vendors", {}),
      });
      const workId = await viaChat(space, `Please dispatch a plumber for the leak in 4B, checking their record first. [Q:${tag}]`);
      await sweep(60, settled(workId));
      const rows = await rowsOf(workId);
      assert.equal(rows[0].status, "COMPLETED", await dump(workId));
      const peerTask = rows.find((row) => row.agent_id === peer);
      assert.ok(peerTask, `the peer ran: ${await dump(workId)}`);
      assert.equal(peerTask.status, "COMPLETED", peerTask.error);
      assert.equal(peerTask.delegation_depth, 3);
      assert.ok(peerTask.max_steps <= BUDGET_MODEL.peerHelp.steps, "on a peer's budget");
      assert.equal(rows.find((row) => row.agent_id === asker).status, "COMPLETED");
    });

    /** Employee-owned Work through the task route, reading conversations over a connection it was granted. */
    async function employeeWork(space, tag) {
      const run = (work) => withDbSession(config, { principalId: space.subject, organizationId: space.org, actorId: space.subject, requestId: randomUUID() }, work);
      const connection = randomUUID();
      // A connected messaging account must name its account (connected_messaging_account_required).
      await administrator.query("insert into integration_connections (id,organization_id,provider,category,status,auth_mode,external_account_id,created_by,created_at,updated_at) values ($1,$2,'twilio','Communication','connected','credentials',$3,$4,now(),now())", [connection, space.org, `AC${randomUUID().replaceAll("-", "")}`, space.subject]);
      // One open conversation on that channel, so the read has evidence to return.
      await administrator.query("insert into conversations (id,organization_id,channel,external_thread_id,contact_display_name,last_message_at,created_at,updated_at) values ($1,$2,'twilio',$3,'Resident in 4B',now(),now(),now())", [randomUUID(), space.org, `thread-${randomUUID()}`]);
      const employee = await run((s) => createEmployee(s, space.org, space.subject, { name: `Resident desk ${tag}`, role: "Resident coordinator", status: "active" }));
      // Coordinating is a grant like any other: an employee's Work is offered only
      // what it was granted, planning included.
      for (const capability of ["plan_goal", "get_goal_plan", "list_conversations", "read_conversation"]) await run((s) => grantScope(s, space.org, employee.id, space.subject, { kind: "capability", value: capability }));
      await run((s) => grantScope(s, space.org, employee.id, space.subject, { kind: "connection", value: connection }));
      const open = async (goal) => {
        const response = await openTask(new Request("https://app.aval.llc/api/agents/tasks", { method: "POST", headers: space.headers(), body: JSON.stringify({ goal, employeeId: employee.id }) }));
        assert.ok([200, 201, 202].includes(response.status), await response.clone().text());
        const body = await response.json();
        return body.task?.id ?? body.taskId ?? body.id;
      };
      return {
        open,
        disconnect: () => administrator.query("update integration_connections set status='disconnected' where id=$1", [connection]),
        reconnect: () => administrator.query("update integration_connections set status='connected' where id=$1", [connection]),
      };
    }
    const residentPath = (tag, specialistScript) => ({
      ...hierarchy({ lead: "lead.resident-experience", specialist: "resident-experience.resident-inbox", tool: "list_conversations", tag }),
      [`[S:${tag}]`]: specialistScript,
    });

    await t.test("a connection revoked in the middle of a run: the next call is refused at execution, and nothing fails for it", async () => {
      const space = await workspace();
      const tag = `revoke-${letters()}`;
      const work = await employeeWork(space, tag);
      script(residentPath(tag, async ({ uses, n }) => {
        if (!used(uses, "list_conversations")) return reply("list_conversations", {});
        // Between two turns of one invocation: the toolset was assembled with
        // the connection, so only the executor's re-read can catch this.
        if (n === 2) { await work.disconnect(); return reply("list_conversations", {}); }
        return answer(`Specialist evidence ${tag}`);
      }));
      const workId = await work.open(`Summarise open resident conversations. [Q:${tag}]`);
      await sweep(40, settled(workId));
      const rows = await rowsOf(workId);
      const leaf = rows.find((row) => row.agent_id === "resident-experience.resident-inbox");
      assert.ok(leaf, await dump(workId));
      const steps = (await administrator.query("select kind, tool_name, error from agent_task_steps where task_id=$1 and tool_name='list_conversations' order by sequence", [leaf.id])).rows;
      assert.equal(steps[0]?.kind, "tool_call", `the first read ran while connected: ${JSON.stringify(steps)}`);
      assert.ok(steps.slice(1).some((step) => step.kind !== "tool_call" && /connect|access/i.test(step.error ?? "")), `the read after revocation was refused: ${JSON.stringify(steps)}`);
      assert.notEqual(leaf.status, "FAILED", "a revoked connection is not a failure of the work");
    });

    await t.test("a provider wait parks the work without spending steps, and it resumes when the connection is back", async () => {
      const space = await workspace();
      const tag = `provider-${letters()}`;
      const work = await employeeWork(space, tag);
      await work.disconnect();
      script(residentPath(tag, ({ uses }) => used(uses, "list_conversations") ? answer(`Specialist evidence ${tag}`) : reply("list_conversations", {})));
      const workId = await work.open(`Summarise open resident conversations. [Q:${tag}]`);
      const parked = async () => (await rowsOf(workId)).find((row) => row.status === "WAITING_FOR_PROVIDER");
      await sweep(40, parked);
      const waiting = await parked();
      assert.ok(waiting, `the work waits for its provider: ${await dump(workId)}`);
      const before = waiting.step_count;
      await administrator.query("update agent_tasks set next_attempt_at=now() where id=$1", [waiting.id]);
      await sweep(5);
      const still = (await rowsOf(workId)).find((row) => row.id === waiting.id);
      assert.equal(still.status, "WAITING_FOR_PROVIDER", "still waiting while the connection is gone");
      assert.equal(still.step_count, before, "waiting spent no steps");
      await work.reconnect();
      await administrator.query("update agent_tasks set next_attempt_at=now() where id=$1", [waiting.id]);
      await sweep(40, settled(workId));
      assert.equal((await rowsOf(workId))[0].status, "COMPLETED", await dump(workId));
    });
  } finally {
    Object.assign(env, previousEnv);
  }
}

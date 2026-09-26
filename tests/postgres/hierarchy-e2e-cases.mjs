import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST as ask } from "../../app/api/assistant/ask/route.ts";
import { GET as listTasks } from "../../app/api/agents/tasks/route.ts";
import { DELETE as cancelTask, POST as resumeTask } from "../../app/api/agents/tasks/[id]/route.ts";
import { POST as decide } from "../../app/api/agents/approvals/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";
import { withWorkerOrganizationSession } from "../../lib/api/with-session.ts";
import { runScheduledSweep } from "../../lib/workers/scheduled-sweep.ts";
import { wakeOnInboundMessage } from "../../lib/agents/waits.ts";
import { ModelProviderError } from "../../lib/ask-aval/model-types.ts";

/**
 * The whole hierarchy, end to end, through the public chat route:
 *
 *   user message → /api/assistant/ask → durable Work → Aval One → Lead →
 *   Specialist → correctly scoped tools → evidence → Specialist result →
 *   Lead → Aval One → verified objective → the chat's linked result
 *
 * and then the same path with each failure a real run meets injected:
 * a transient model failure, a deterministic denial, a wait on a vendor, a
 * human approval, cancellation, a duplicate delegation, and a strategy that
 * keeps failing. Only the model is scripted; the route, the cron, the runtime,
 * policy, delegation, the reviewer contract and the database are all real.
 */

const reply = (name, input) => ({ content: [{ type: "tool_use", name, input, id: randomUUID() }], stop_reason: "tool_use", usage: { input_tokens: 80, output_tokens: 40 }, routing: { providerId: "test", model: "scripted" } });
const answer = (headline) => reply("render_answer", { headline, narrative: "Worked from the records available.", confidence: "high" });
const EVIDENCE = (tool) => ({ kind: "evidence", tools: [tool] });
const SPECIALIST = "maintenance.work-order-creation";
const SPECIALIST_GOALS = ["Raise the work order for the leak in 4B", "Record the owner's preference for brief repair updates"];
const QUESTION = "A resident reports a water leak under the kitchen sink, open a work order and dispatch a plumber";

export async function runHierarchyE2ECases(t, { config, administrator }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;

  /** One scenario: a fresh workspace, a saved chat turn, and a scripted model per task. */
  async function scenario({ specialist, lead = defaultLead, question = QUESTION, root = defaultRoot }) {
    const subject = `hierarchy_${randomUUID()}`;
    const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Hierarchy fixture", emailVerified: true };
    const headers = () => withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity);
    assert.equal((await listTasks(new Request("https://app.aval.llc/api/agents/tasks", { headers: headers() }))).status, 200);
    const org = (await administrator.query("select organization_id from organization_members where user_id=$1", [subject])).rows[0].organization_id;
    await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [org]);
    const turn = randomUUID();
    await administrator.query("insert into assistant_chat_entries(organization_id,user_id,id,payload) values ($1,$2,$3,$4::jsonb)", [org, subject, turn, JSON.stringify({ id: turn, role: "user", text: question })]);

    const offered = new Map();
    const calls = new Map();
    globalThis.__REQUEST_CONTEXT__ = { waitUntil: () => {} };
    globalThis.__MODEL__ = async (_env, _org, params) => {
      const goal = typeof params.messages[0]?.content === "string" ? params.messages[0].content : JSON.stringify(params.messages[0]?.content);
      // The cron is global: it also runs tasks other cases left behind in
      // their own workspaces. Only this scenario's goals are scripted.
      const role = goal.includes(question) ? "root" : goal.includes("Coordinate the leak repair") ? "lead"
        : SPECIALIST_GOALS.some((text) => goal.includes(text)) ? "specialist" : "other";
      if (role === "other") return answer("Outside this scenario");
      offered.set(role, params.tools.map((tool) => tool.name));
      const n = (calls.get(role) ?? 0) + 1;
      calls.set(role, n);
      const uses = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use") : []);
      const results = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []);
      const context = { n, uses, results, system: params.system };
      return role === "root" ? root(context) : role === "lead" ? lead(context) : specialist(context);
    };
    globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
      const packet = JSON.parse(params.messages[0].content);
      const keys = packet.phase === "plan" ? (packet.proposal?.tasks ?? []).map((task) => task.key) : [];
      const source = (packet.sources ?? []).find((s) => !s.failed && s.data && typeof s.data === "object" && Object.keys(s.data).length);
      const claims = packet.phase === "plan" || !source ? [] : [{ claim: "Records read", kind: "fact", supported: true, citations: [{ sourceId: source.id, pointer: "/" + Object.keys(source.data)[0].replaceAll("~", "~0").replaceAll("/", "~1") }] }];
      return reply("semantic_verdict", { passed: true, issues: [], requirements: [{ requirement: packet.goal, satisfied: true, explanation: "Scripted fixture", nodeKeys: keys }], claims });
    };

    const response = await ask(new Request("https://app.aval.llc/api/assistant/ask", { method: "POST", headers: headers(), body: JSON.stringify({ question, chatMessageId: turn, personaId: "general", locale: "en" }) }));
    assert.equal(response.status, 202, "the chat turn becomes durable Work");
    const workId = (await response.json()).work.taskId;
    const rows = async () => (await administrator.query("select * from agent_tasks where work_id=$1 order by delegation_depth, created_at", [workId])).rows;
    const byAgent = async (agent) => (await rows()).find((row) => row.agent_id === agent);
    const sweep = async (times = 30, until = async () => false) => {
      for (let i = 0; i < times; i++) {
        await runScheduledSweep(env);
        if (await until()) return;
      }
    };
    const settled = async () => ["COMPLETED", "FAILED", "CANCELLED"].includes((await rows())[0].status);
    const dump = async () => JSON.stringify((await rows()).map((row) => ({ agent: row.agent_id, status: row.status, error: row.error, tail: JSON.stringify(row.transcript_json).slice(-600) })));
    return { org, subject, turn, workId, rows, byAgent, sweep, settled, offered, calls, headers, dump };
  }

  // The normal path at each level, which scenarios override where they inject.
  const defaultRoot = ({ uses }) => uses.some((u) => u.name === "plan_goal") ? answer("The leak repair is under way")
    : reply("plan_goal", { tasks: [{ key: "maintenance", goal: "Coordinate the leak repair in 4B", agentId: "lead.maintenance", dependsOn: [], check: { kind: "plan" } }] });
  const defaultLead = ({ uses }) => uses.some((u) => u.name === "plan_goal") ? answer("The work order is raised")
    : reply("plan_goal", { tasks: [{ key: "raise", goal: "Raise the work order for the leak in 4B", agentId: SPECIALIST, dependsOn: [], check: EVIDENCE("get_maintenance_performance") }] });
  const readThenAnswer = ({ uses }) => uses.some((u) => u.name === "get_maintenance_performance") ? answer("Maintenance records read") : reply("get_maintenance_performance", {});

  try {
    await t.test("chat → Aval One → Lead → Specialist → evidence → verified result, with scoped tools at every level", async () => {
      const run = await scenario({ specialist: readThenAnswer });
      await run.sweep(30, run.settled);
      const [root, lead, leaf] = await run.rows();
      assert.equal(root.status, "COMPLETED", root.error);
      assert.equal(lead.agent_id, "maintenance");
      assert.equal(lead.status, "COMPLETED", lead.error);
      assert.equal(leaf.agent_id, SPECIALIST);
      assert.equal(leaf.status, "COMPLETED", leaf.error);
      assert.ok(JSON.parse(JSON.stringify(root.result_json)).headline, "Aval One returns a result");
      const [link] = (await administrator.query("select payload from assistant_chat_entries where id=$1", [run.turn + "-run"])).rows;
      assert.equal(link.payload.taskId, root.id, "and the chat turn shows it");
      // Correctly scoped tools: planners only plan; the Specialist is offered
      // only what its capabilities map to.
      assert.ok(run.offered.get("root").includes("plan_goal") && !run.offered.get("root").includes("get_maintenance_performance"));
      assert.ok(run.offered.get("lead").includes("plan_goal") && !run.offered.get("lead").includes("dispatch_vendor"));
      const leafTools = run.offered.get("specialist");
      assert.ok(leafTools.includes("get_maintenance_performance"));
      // Expertise bounds what a Specialist changes in the business, not its
      // own task: it can still wait on someone and ask a peer.
      for (const tool of ["wait_for", "request_peer_help"]) assert.ok(leafTools.includes(tool), `the Specialist is offered ${tool}`);
      for (const tool of ["post_payment", "create_payment_plan", "publish_listing", "dispatch_vendor", "close_work_order", "plan_goal"]) assert.equal(leafTools.includes(tool), false, `the Specialist is not offered ${tool}`);
      const steps = (await administrator.query("select tool_name from agent_task_steps where task_id=$1 and kind='tool_call'", [leaf.id])).rows.map((row) => row.tool_name);
      assert.ok(steps.includes("get_maintenance_performance"), "the evidence was actually gathered by the Specialist");
    });

    await t.test("a transient model failure is retried on the same strategy and the Work completes", async () => {
      const run = await scenario({ specialist: (context) => {
        if (context.n === 1) throw new ModelProviderError("Upstream model timed out", 503, true);
        return readThenAnswer(context);
      } });
      await run.sweep(12, async () => (await run.byAgent(SPECIALIST))?.execution_attempts > 0);
      const retried = await run.byAgent(SPECIALIST);
      assert.equal(retried.status, "QUEUED", "parked for a retry, not failed");
      assert.ok(retried.next_attempt_at, "with a backoff");
      await administrator.query("update agent_tasks set next_attempt_at=now() - interval '1 second' where id=$1", [retried.id]);
      await run.sweep(30, run.settled);
      assert.equal((await run.rows())[0].status, "COMPLETED");
      assert.equal((await run.byAgent(SPECIALIST)).status, "COMPLETED");
    });

      // post_payment is not in this Specialist's toolset, so the refusal comes
    // from the runtime binding execution to the offered tools — before policy
    // runs, and whatever the model claims.
    await t.test("a deterministic denial: a tool outside the Specialist's toolset is refused, and it replans to what it may do", async () => {
      const run = await scenario({ specialist: (context) => context.n === 1
        ? reply("post_payment", { provider: "doorloop", lease_id: "lease_1", amount_minor: 10_000, currency: "USD", received_on: "2026-09-20" })
        : readThenAnswer(context) });
      await run.sweep(30, run.settled);
      const leaf = await run.byAgent(SPECIALIST);
      assert.equal(leaf.status, "COMPLETED", leaf.error);
      assert.match(JSON.stringify(leaf.transcript_json), /not one of the tools offered|does not hold|not permitted|does not grant/i, "the payment was refused by policy, not by the model");
      assert.equal((await administrator.query("select count(*)::int n from agent_financial_operations where task_id=$1", [leaf.id])).rows[0].n, 0, "and nothing was reserved");
    });

    await t.test("waiting on a vendor parks the run, and the vendor's reply wakes it", async () => {
      const conversation = `conv_${randomUUID()}`;
      const run = await scenario({ specialist: (context) => {
        if (!context.uses.some((u) => u.name === "wait_for")) return reply("wait_for", { party: "vendor", reason: "Waiting for the plumber to confirm the appointment", conversation_id: conversation });
        return readThenAnswer(context);
      } });
      await run.sweep(12, async () => (await run.byAgent(SPECIALIST))?.status === "WAITING_FOR_VENDOR");
      const waiting = await run.byAgent(SPECIALIST);
      assert.equal(waiting.status, "WAITING_FOR_VENDOR");
      assert.ok(new Date(waiting.next_attempt_at) > new Date(Date.now() + 3600_000), "no polling: the next look is its recheck timer");
      await run.sweep(3);
      assert.equal((await run.byAgent(SPECIALIST)).status, "WAITING_FOR_VENDOR", "the cron leaves it alone while it waits");
      assert.equal(await withWorkerOrganizationSession(run.org, (session) => wakeOnInboundMessage(session, run.org, conversation)), 1);
      await run.sweep(30, run.settled);
      assert.equal((await run.byAgent(SPECIALIST)).status, "COMPLETED");
      assert.equal((await run.rows())[0].status, "COMPLETED");
    });

    await t.test("an action that needs a person waits for approval through the real route, then completes", async () => {
      const run = await scenario({
        lead: ({ uses }) => uses.some((u) => u.name === "plan_goal") ? answer("Preference recorded")
          : reply("plan_goal", { tasks: [{ key: "note", goal: "Record the owner's preference for brief repair updates", agentId: "maintenance", dependsOn: [], check: { kind: "preference", topic: "reporting_style", statement: "keep_summaries_brief" } }] }),
        specialist: ({ uses }) => uses.some((u) => u.name === "record_preference") ? answer("Preference recorded") : reply("record_preference", { topic: "reporting_style", statement: "keep_summaries_brief" }),
      });
      await run.sweep(20, async () => (await run.rows()).some((row) => row.status === "WAITING_FOR_APPROVAL"));
      const parked = (await run.rows()).find((row) => row.status === "WAITING_FOR_APPROVAL");
      assert.ok(parked, `the preference write parks for a person: ${await run.dump()}`);
      const [approval] = (await administrator.query("select id from agent_approvals where task_id=$1 and status='pending'", [parked.id])).rows;
      const decided = await decide(new Request("https://app.aval.llc/api/agents/approvals", { method: "POST", headers: run.headers(), body: JSON.stringify({ approvalId: approval.id, decision: "approved" }) }));
      assert.equal(decided.status, 200, await decided.clone().text());
      await run.sweep(30, run.settled);
      assert.equal((await administrator.query("select status from agent_tasks where id=$1", [parked.id])).rows[0].status, "COMPLETED");
      assert.equal((await run.rows())[0].status, "COMPLETED");
    });

    await t.test("cancelling the Work stops every task in it", async () => {
      const run = await scenario({ specialist: () => reply("wait_for", { party: "vendor", reason: "Waiting for the plumber to reply", recheck_hours: 24 }) });
      await run.sweep(12, async () => (await run.byAgent(SPECIALIST))?.status === "WAITING_FOR_VENDOR");
      const response = await cancelTask(new Request(`https://app.aval.llc/api/agents/tasks/${run.workId}`, { method: "DELETE", headers: run.headers() }), { params: Promise.resolve({ id: run.workId }) });
      assert.equal(response.status, 200);
      await run.sweep(6);
      for (const row of await run.rows()) assert.equal(row.cancel_requested, true, `${row.agent_id} was asked to stop`);
      assert.ok((await run.rows()).every((row) => ["CANCELLED", "SUPERSEDED"].includes(row.status)), JSON.stringify((await run.rows()).map((row) => row.status)));
    });

    await t.test("a duplicate delegation is refused deterministically and the Lead replans", async () => {
      const run = await scenario({
        lead: ({ uses, results }) => {
          const planned = uses.filter((u) => u.name === "plan_goal");
          if (!planned.length) return reply("plan_goal", { tasks: [
            { key: "raise", goal: "Raise the work order for the leak in 4B", agentId: SPECIALIST, dependsOn: [], check: EVIDENCE("get_maintenance_performance") },
            { key: "again", goal: "Raise the work order for the leak in 4B", agentId: SPECIALIST, dependsOn: [], check: EVIDENCE("get_maintenance_performance") },
          ] });
          const lastFailed = results.at(-1)?.is_error;
          return planned.length === 1 && lastFailed ? defaultLead({ uses: [] }) : answer("Work order raised");
        },
        specialist: readThenAnswer,
      });
      await run.sweep(30, run.settled);
      const lead = await run.byAgent("maintenance");
      assert.match(JSON.stringify(lead.transcript_json), /ask the same actor the same question/);
      assert.equal((await run.rows()).filter((row) => row.agent_id === SPECIALIST).length, 1, "the sub-problem ran once");
      assert.equal((await run.rows())[0].status, "COMPLETED");
    });

    await t.test("a strategy that keeps failing is handed to a person, who can resume it", async () => {
      let resumed = false;
      const run = await scenario({ specialist: (context) => resumed
        ? readThenAnswer(context)
        : reply("post_payment", { provider: "doorloop", lease_id: "lease_1", amount_minor: 10_000, currency: "USD", received_on: "2026-09-20" }) });
      await run.sweep(20, async () => (await run.byAgent(SPECIALIST))?.status === "WAITING_FOR_HUMAN");
      const handed = await run.byAgent(SPECIALIST);
      assert.equal(handed.status, "WAITING_FOR_HUMAN", handed.error);
      assert.match(handed.error ?? "", /no progress|different approach/i, "stagnation, not a budget, ended it");
      await run.sweep(3);
      assert.equal((await run.byAgent(SPECIALIST)).status, "WAITING_FOR_HUMAN", "and nothing restarts it on its own");
      resumed = true;
      const response = await resumeTask(new Request(`https://app.aval.llc/api/agents/tasks/${handed.id}`, { method: "POST", headers: run.headers(), body: JSON.stringify({ action: "resume", note: "Do not post payments; just read the maintenance records." }) }), { params: Promise.resolve({ id: handed.id }) });
      assert.equal(response.status, 200, await response.clone().text());
      await run.sweep(30, run.settled);
      assert.equal((await run.byAgent(SPECIALIST)).status, "COMPLETED", await run.dump());
      assert.equal((await run.rows())[0].status, "COMPLETED");
    });
  } finally {
    delete globalThis.__REQUEST_CONTEXT__;
    delete globalThis.__MODEL__;
    delete globalThis.__SEMANTIC_MODEL__;
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previousEnv);
  }
}

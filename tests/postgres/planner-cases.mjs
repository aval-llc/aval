import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST, GET } from "../../app/api/agents/tasks/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";
import { runScheduledSweep } from "../../lib/workers/scheduled-sweep.ts";

const reply = (name, input) => ({ content: [{ type: "tool_use", name, input, id: randomUUID() }], stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 }, routing: { providerId: "test", model: "scripted" } });
const conclusion = () => reply("render_answer", { headline: "Portfolio reviewed", narrative: "Review the available portfolio records.", confidence: "high" });

export async function runPlannerCases(t, { config, administrator }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;
  try {
    for (const scenario of ["success", "child-failure", "cancel", "missing-model"]) {
      await t.test(`public planner route and cron: ${scenario}`, async () => {
        const subject = `planner_${randomUUID()}`;
        const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Planner fixture", emailVerified: true };
        const request = (method) => new Request("https://app.aval.llc/api/agents/tasks", {
          method, headers: withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity),
          ...(method === "POST" ? { body: JSON.stringify({ goal: "Review the portfolio", agentId: "financial" }) } : {}),
        });
        assert.equal((await GET(new Request("https://app.aval.llc/api/agents/tasks"))).status, 401);
        assert.equal((await GET(request("GET"))).status, 200); // Real identity bootstrap.
        const org = (await administrator.query("select organization_id from organization_members where user_id=$1", [subject])).rows[0].organization_id;
        if (scenario !== "missing-model") await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [org]);
        const scheduled = [];
        globalThis.__REQUEST_CONTEXT__ = { waitUntil: promise => scheduled.push(promise) };
        let modelCalls = 0;
        globalThis.__MODEL__ = scenario === "missing-model" ? undefined : async (_env, _org, params) => {
          modelCalls++;
          // A different connection must see both writes before inference starts.
          const committed = await administrator.query("select id from agent_tasks where organization_id=$1 and parent_task_id is null", [org]);
          assert.equal(committed.rowCount, 1);
          assert.ok((await administrator.query("select id from answer_audit_log where organization_id=$1 and kind='task_created'", [org])).rowCount > 0);
          const uses = params.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_use") : []);
          if (params.tools.some(tool => tool.name === "plan_goal")) {
            if (!uses.some(u => u.name === "plan_goal")) return reply("plan_goal", { tasks: [
              { key: "portfolio", goal: "Read the portfolio records", dependsOn: [], check: { kind: "evidence", tools: ["get_portfolio_metrics"] } },
            ] });
            return conclusion();
          }
          if (scenario === "child-failure") return conclusion(); // No evidence: must fail.
          return uses.some(u => u.name === "get_portfolio_metrics") ? conclusion() : reply("get_portfolio_metrics", {});
        };
        globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => {
          const packet = JSON.parse(params.messages[0].content);
          const source = packet.sources.find(s => !s.failed && s.data && typeof s.data === "object" && Object.keys(s.data).length);
          return reply("semantic_verdict", { passed: true, issues: [],
            requirements: [{ requirement: packet.goal, satisfied: true, explanation: "Scripted workflow fixture",
              nodeKeys: packet.phase === "plan" ? ["portfolio"] : [] }],
            claims: packet.phase === "plan" ? [] : [{ claim: "Portfolio records", kind: "fact", supported: true,
              citations: [{ sourceId: source?.id ?? "missing", pointer: "/" + Object.keys(source?.data ?? { missing: true })[0].replaceAll("~", "~0").replaceAll("/", "~1") }] }],
          });
        };
        const response = await POST(request("POST"));
        assert.equal(response.status, 202);
        const { id } = await response.json();
        assert.equal(scheduled.length, 1, "route registers its background promise");
        await Promise.all(scheduled);
        const read = async () => (await administrator.query("select * from agent_tasks where id=$1", [id])).rows[0];
        assert.equal((await read()).check_json.kind, "plan");
        if (scenario === "cancel") await administrator.query("update agent_tasks set cancel_requested=true where id=$1", [id]);
        // No task GET/polling calls: only the real cron drives completion.
        for (let sweep = 0; sweep < 12; sweep++) {
          await runScheduledSweep(env);
          if (["COMPLETED", "FAILED", "CANCELLED"].includes((await read()).status)) break;
        }
        const final = await read();
        const children = (await administrator.query("select * from agent_tasks where parent_task_id=$1", [id])).rows;
        if (scenario === "success") {
          assert.equal(final.status, "COMPLETED", final.error);
          assert.ok(final.result_json);
          assert.equal(children.length, 1);
          assert.equal(children[0].status, "COMPLETED", children[0].error);
          assert.ok(modelCalls >= 4);
        } else {
          if (scenario === "child-failure") {
            // A child that cannot evidence its objective is handed to a person,
            // not written off, so neither it nor its parent is terminal. The
            // parent stays open waiting on work that a human now owns.
            assert.equal(children[0].status, "WAITING_FOR_HUMAN", children[0].error);
            assert.ok(!["COMPLETED", "FAILED"].includes(final.status), `parent must not be terminal: ${final.status}`);
            assert.equal(final.result_json, null);
          } else {
            assert.equal(final.status, scenario === "cancel" ? "CANCELLED" : "FAILED", final.error);
            assert.equal(final.result_json, null);
            if (scenario === "missing-model") assert.match(final.error, /connect|model|provider/i);
          }
        }
      });
    }
  } finally {
    delete globalThis.__REQUEST_CONTEXT__;
    delete globalThis.__MODEL__;
    delete globalThis.__SEMANTIC_MODEL__;
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previousEnv);
  }
}

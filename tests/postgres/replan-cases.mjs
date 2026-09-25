import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST, GET } from "../../app/api/agents/tasks/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";
import { runScheduledSweep } from "../../lib/workers/scheduled-sweep.ts";

/**
 * Adaptive replanning, through the runtime rather than around it.
 *
 * A failed tool call used to be an error string handed back to the model and
 * recorded nowhere. The second identical failure was therefore
 * indistinguishable from the first, and `A → A → A → A` was bounded only by the
 * step budget — the run would spend every step it had on one broken idea and
 * then stop, having learned nothing and said nothing useful about why.
 *
 * These drive the real path: the public task route creates the work, the real
 * cron sweep advances it, and a scripted model stands in for inference. What is
 * asserted is what the *model was told* between attempts, because that is the
 * only thing that can make the next strategy differ.
 */

const reply = (name, input) => ({
  content: [{ type: "tool_use", name, input, id: randomUUID() }],
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 },
  routing: { providerId: "test", model: "scripted" },
});
const conclusion = () => reply("render_answer", {
  headline: "Portfolio reviewed",
  narrative: "Review the available portfolio records.",
  confidence: "high",
});

/** Everything the model has been told, flattened for searching. */
function transcript(params) {
  return params.messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.map((block) => JSON.stringify(block))
    : [String(message.content)]).join(" ");
}

const named = (params, tool) => params.messages.flatMap((message) => Array.isArray(message.content)
  ? message.content.filter((block) => block.type === "tool_use" && block.name === tool)
  : []).length;

export async function runReplanCases(t, { config, administrator }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;

  /** Boots a task through the public route and returns its id and org. */
  const start = async (subject, goal) => {
    const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Replan fixture", emailVerified: true };
    const request = (method) => new Request("https://app.aval.llc/api/agents/tasks", {
      method,
      headers: withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity),
      ...(method === "POST" ? { body: JSON.stringify({ goal, agentId: "financial" }) } : {}),
    });
    assert.equal((await GET(request("GET"))).status, 200);
    const org = (await administrator.query(
      "select organization_id from organization_members where user_id=$1", [subject])).rows[0].organization_id;
    await administrator.query("update organizations set active_model_provider='fixture' where id=$1", [org]);
    const scheduled = [];
    globalThis.__REQUEST_CONTEXT__ = { waitUntil: (promise) => scheduled.push(promise) };
    return { request, org, scheduled };
  };

  const semanticAlwaysPasses = async (_env, _org, params) => {
    const packet = JSON.parse(params.messages[0].content);
    const source = packet.sources.find((s) => !s.failed && s.data && typeof s.data === "object" && Object.keys(s.data).length);
    return reply("semantic_verdict", {
      passed: true, issues: [],
      // Plan coverage has to name the plan's own task keys, or the review
      // rejects the plan before any work is attempted.
      requirements: [{
        requirement: packet.goal, satisfied: true, explanation: "Scripted fixture",
        nodeKeys: packet.phase === "plan" ? ["arrears"] : [],
      }],
      claims: packet.phase === "plan" ? [] : [{
        claim: "Portfolio records", kind: "fact", supported: true,
        citations: [{ sourceId: source?.id ?? "missing", pointer: "/" + Object.keys(source?.data ?? { missing: true })[0].replaceAll("~", "~0").replaceAll("/", "~1") }],
      }],
    });
  };

  try {
    await t.test("a failure that will not fix itself reaches the next planning turn", async () => {
      const subject = `replan_${randomUUID()}`;
      const { request, org, scheduled } = await start(subject, "Establish the portfolio position");

      // Strategy A is a PMS write in a workspace with no PMS. It is refused
      // every time, for the same reason, forever — the deterministic
      // non-transient failure this whole mechanism is for.
      let sawGuidance = false;
      let switched = false;
      globalThis.__MODEL__ = async (_env, _org, params) => {
        // The root is a planner: it delegates and does no operational work.
        // The refusal has to happen where the work happens, in the child.
        if (params.tools.some((tool) => tool.name === "plan_goal")) {
          return named(params, "plan_goal") === 0
            ? reply("plan_goal", { tasks: [{
                key: "arrears", goal: "Chase the arrears on the portfolio", dependsOn: [],
                check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
              }] })
            : conclusion();
        }
        const told = transcript(params);
        if (/different approach|Do not call it again/i.test(told)) sawGuidance = true;

        if (named(params, "create_work_order") === 0) {
          return reply("create_work_order", { provider: "doorloop", summary: "Chase the arrears", priority: "normal" });
        }
        // The guidance is what makes this branch reachable at all: without it
        // the model has no way to know the first approach is a dead end.
        if (sawGuidance) {
          switched = true;
          return named(params, "get_portfolio_metrics") === 0 ? reply("get_portfolio_metrics", {}) : conclusion();
        }
        return reply("create_work_order", { provider: "doorloop", summary: "Chase the arrears", priority: "normal" });
      };
      globalThis.__SEMANTIC_MODEL__ = semanticAlwaysPasses;

      const created = await POST(request("POST"));
      assert.equal(created.status, 202);
      const { id } = await created.json();
      await Promise.all(scheduled);
      for (let sweep = 0; sweep < 12; sweep += 1) {
        await runScheduledSweep(env);
        const row = (await administrator.query("select status from agent_tasks where id=$1", [id])).rows[0];
        if (["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_HUMAN"].includes(row.status)) break;
      }

      // The failure is on the record, classified, and not as something to retry.
      const attempts = (await administrator.query(
        "select kind, outcome, transient, signature, failure_reason from work_attempts where organization_id=$1 order by created_at", [org])).rows;
      assert.ok(attempts.length > 0, "a failed tool call is recorded as an attempt");
      const refused = attempts.find((row) => row.failure_reason?.startsWith("denied:") || row.outcome === "blocked");
      if (!refused) {
        // Only on failure: the step trail is what explains a run that did not
        // reach the refusal at all, and it is not worth a query otherwise.
        const steps = (await administrator.query(
          "select kind, tool_name, error from agent_task_steps where organization_id=$1 order by created_at", [org])).rows;
        assert.fail(`no refusal recorded. attempts=${JSON.stringify(attempts)} steps=${JSON.stringify(steps)}`);
      }
      assert.equal(refused.transient, false, "and it is not something to try again");
      assert.ok(refused.signature, "with a stable signature, so a repeat is visible");

      // And the next planning turn was actually told to change.
      assert.ok(sawGuidance, "the model was told the approach had to change");
      assert.ok(switched, "and it reached a materially different strategy");
    });

    await t.test("a model that keeps repeating one broken idea is stopped, not left to loop", async () => {
      const subject = `stubborn_${randomUUID()}`;
      const { request, org, scheduled } = await start(subject, "Post the arrears payment");

      // This model never adapts. The runtime has to notice.
      let calls = 0;
      globalThis.__MODEL__ = async (_env, _org, params) => {
        calls += 1;
        if (params.tools.some((tool) => tool.name === "plan_goal")) {
          return named(params, "plan_goal") === 0
            ? reply("plan_goal", { tasks: [{
                key: "arrears", goal: "Post the arrears payment", dependsOn: [],
                check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
              }] })
            : conclusion();
        }
        return reply("create_work_order", { provider: "doorloop", summary: "Chase the arrears", priority: "normal" });
      };
      globalThis.__SEMANTIC_MODEL__ = semanticAlwaysPasses;

      const created = await POST(request("POST"));
      assert.equal(created.status, 202);
      const { id } = await created.json();
      await Promise.all(scheduled);
      for (let sweep = 0; sweep < 12; sweep += 1) {
        await runScheduledSweep(env);
        const row = (await administrator.query("select status from agent_tasks where id=$1", [id])).rows[0];
        if (["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_HUMAN", "BLOCKED"].includes(row.status)) break;
      }

      // The work happens in the child, so the child is what must stop. The root
      // waiting on it is correct — an objective is not abandoned because one
      // delegated step reached a person.
      const child = (await administrator.query(
        "select status, error from agent_tasks where parent_task_id=$1", [id])).rows[0];
      assert.ok(child, "the repair was delegated");
      assert.ok(["WAITING_FOR_HUMAN", "BLOCKED", "FAILED"].includes(child.status),
        `a run that cannot progress must stop rather than loop: ${child.status}`);
      assert.notEqual(child.status, "COMPLETED", "and it certainly must not be reported as done");
      assert.match(child.error ?? "", /made no progress|different approach/i,
        "and it says why, in terms a person can act on");

      const attempts = (await administrator.query(
        "select transient from work_attempts where organization_id=$1", [org])).rows;
      assert.ok(attempts.length >= 2, "the repetition is on the record");
      assert.ok(attempts.every((row) => row.transient === false),
        "none of it was mistaken for something worth retrying");
      // Bounded: the point is that it stops long before the step ceiling.
      assert.ok(calls < 20, `inference was not spent looping: ${calls} calls`);
    });
  } finally {
    Object.assign(env, previousEnv);
    globalThis.__MODEL__ = undefined;
    globalThis.__SEMANTIC_MODEL__ = undefined;
  }
}

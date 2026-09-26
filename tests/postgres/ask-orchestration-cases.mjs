import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { env } from "cloudflare:workers";
import { POST as ask } from "../../app/api/assistant/ask/route.ts";
import { GET as listTasks } from "../../app/api/agents/tasks/route.ts";
import { withVerifiedIdentityHeaders } from "../../lib/auth/request-identity.ts";

/**
 * Ask Aval uses the organization rather than a path of its own: a turn that
 * asks for specialist work becomes durable Work, attached to the saved chat
 * turn, rooted at Aval One; a read is answered directly and opens nothing.
 */
export async function runAskOrchestrationCases(t, { config, administrator }) {
  const previousEnv = { ...env };
  env.DATABASE_URL = config.connectionString;
  delete env.HYPERDRIVE;
  try {
    const subject = `ask_${randomUUID()}`;
    const identity = { userId: subject, email: `${subject}@example.test`, displayName: "Ask fixture", emailVerified: true };
    const headers = () => withVerifiedIdentityHeaders(new Headers({ "content-type": "application/json" }), identity);
    assert.equal((await listTasks(new Request("https://app.aval.llc/api/agents/tasks", { headers: headers() }))).status, 200); // identity bootstrap
    const org = (await administrator.query("select organization_id from organization_members where user_id=$1", [subject])).rows[0].organization_id;
    const saveTurn = async (text) => {
      const id = randomUUID();
      await administrator.query("insert into assistant_chat_entries(organization_id,user_id,id,payload) values ($1,$2,$3,$4::jsonb)", [org, subject, id, JSON.stringify({ id, role: "user", text })]);
      return id;
    };
    const post = (question, chatMessageId) => ask(new Request("https://app.aval.llc/api/assistant/ask", {
      method: "POST", headers: headers(), body: JSON.stringify({ question, chatMessageId, personaId: "general", locale: "en" }),
    }));
    globalThis.__REQUEST_CONTEXT__ = { waitUntil: () => {} };

    await t.test("a turn asking for specialist work becomes Aval One Work attached to the chat", async () => {
      const question = "A resident reports a water leak under the kitchen sink, open a work order and dispatch a plumber";
      const turn = await saveTurn(question);
      const response = await post(question, turn);
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.ok(body.work?.taskId, "the chat receives the Work to follow");
      assert.equal(response.headers.get("x-aval-work"), body.work.taskId);
      assert.equal(body.work.reason, "action_requested");
      assert.ok(body.work.leads.length > 0, "with the Lead candidates the router named");
      const [task] = (await administrator.query("select * from agent_tasks where id=$1", [body.work.taskId])).rows;
      assert.equal(task.agent_id, "general", "rooted at Aval One");
      assert.equal(task.check_json.kind, "plan");
      assert.equal(task.work_id, task.id);
      const [link] = (await administrator.query("select payload from assistant_chat_entries where id=$1", [turn + "-run"])).rows;
      assert.equal(link.payload.taskId, task.id, "the chat turn is linked to its Work, so a refresh finds it");

      const again = await post(question, turn);
      assert.equal((await again.json()).work.taskId, task.id, "a retried turn reaches the same Work, never a second one");
    });

    await t.test("a read is answered directly and opens no Work", async () => {
      const before = (await administrator.query("select count(*)::int as n from agent_tasks where organization_id=$1", [org])).rows[0].n;
      const turn = await saveTurn("What is our occupancy?");
      const response = await post("What is our occupancy?", turn);
      assert.equal(response.headers.get("x-aval-work"), null);
      const after = (await administrator.query("select count(*)::int as n from agent_tasks where organization_id=$1", [org])).rows[0].n;
      assert.equal(after, before);
    });
  } finally {
    delete globalThis.__REQUEST_CONTEXT__;
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, previousEnv);
  }
}

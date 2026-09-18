/** In-memory D1 stand-in plus the fixtures the runtime tests share. */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";

export const ENV = {};

/**
 * Builds the schema from the project's own generated migrations and points the
 * runtime at it. D1 is SQLite, so constraint and concurrency behaviour is
 * faithful; the networking is not exercised.
 */
export async function bootRuntime(path = ":memory:") {
  // Plumbing fixture only. Semantic/adversarial tests override this separately;
  // its canned approval is never evidence of real reviewer/model accuracy.
  globalThis.__SEMANTIC_MODEL__ = async (_env, _org, params) => semanticFixture(JSON.parse(params.messages[0].content));
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='agent_tasks'").get()) for (const file of readdirSync("drizzle").filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  globalThis.__CF_ENV__ = { DB: {} };
  // Mirrors D1's contract: `run` reports meta.changes, reads return positional
  // rows. Getting this wrong would make every lease claim silently fail, which
  // is precisely the class of thing these tests exist to catch.
  globalThis.__DB__ = drizzle(async (text, params, method) => {
    const statement = sqlite.prepare(text);
    if (method === "run") return { rows: [], meta: { changes: Number(statement.run(...params).changes) } };
    statement.setReadBigInts(false);
    const rows = statement.all(...params).map((row) => Object.values(row));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }, { schema: await import("../../db/schema.ts") });

  const now = Date.now();
  for (const [id, name, owner] of [["org_1", "Test Org", "user_1"], ["org_public_demo", "Demo", "guest"]]) {
    sqlite.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_user_id, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(id, name, owner, now, now);
  }
  return sqlite;
}

/* ── canned model responses ──────────────────────────────────────────────── */

export function reply(content, stopReason = "tool_use") {
  return {
    content, stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 50 },
    routing: { providerId: "anthropic", model: "claude-opus-5" },
  };
}

/** A conclusion with no numeric claims, so the faithfulness gate passes it. */
export function conclude(headline, narrative = "No figures are asserted here.") {
  return reply([{ type: "tool_use", id: "tu_final", name: "render_answer", input: { headline, narrative, confidence: "high" } }]);
}

export function useTool(name, input = {}, id = "tu_tool") {
  return reply([{ type: "tool_use", id, name, input }]);
}

/** Scripts the model: each call consumes the next entry, the last one repeats. */
export function scriptModel(...turns) {
  let index = 0;
  globalThis.__MODEL__ = async () => turns[Math.min(index++, turns.length - 1)];
}

export function semanticFixture(packet, overrides = {}) {
  const source = packet.sources.find(s => !s.failed && s.data && typeof s.data === 'object' && Object.keys(s.data).length);
  const pointer = source ? '/' + Object.keys(source.data)[0].replaceAll('~', '~0').replaceAll('/', '~1') : '/fixture';
  return reply([{type:'tool_use', id:'semantic_fixture', name:'semantic_verdict', input: {
    passed: true,
    requirements: [{ requirement: packet.goal, satisfied: true, explanation: 'Scripted plumbing fixture, not a quality evaluation.', nodeKeys: packet.phase === 'plan' ? packet.proposal.tasks.map(n => n.key) : [] }],
    claims: packet.phase === 'plan' ? [] : [{ claim: 'Scripted claim', kind: 'fact', supported: true, citations: [{ sourceId: source?.id ?? 'absent', pointer }] }],
    issues: [], ...overrides,
  }}]);
}

/** Explicit test-only plan review fixture for allocation tests, bypassing no production code. */
export async function writeReviewedPlan(org, rootId, nodes, key) {
  const { agentChecks } = await import('../../db/schema.ts');
  const { getTask } = await import('../../lib/agents/tasks.ts');
  const { digestPayload } = await import('../../lib/audit/chain.ts');
  const { writeGoalPlan } = await import('../../lib/agents/goal-plan.ts');
  const root = await getTask(org, rootId);
  await globalThis.__DB__.insert(agentChecks).values({ id: crypto.randomUUID(), organizationId: org, taskId: rootId, stepIndex: root.stepCount - 1, exitCode: 0, outputJson: JSON.stringify({ phase: 'plan', reviewer: 'independent-session-v1', proposalDigest: await digestPayload({ tasks: nodes }) }), createdAt: new Date() });
  return writeGoalPlan(org, rootId, nodes, key);
}

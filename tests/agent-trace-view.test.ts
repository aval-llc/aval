import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serializeTraceStep } from "../lib/agents/trace-view.ts";
import { formatDuration, groupBySteps, toneFor } from "../lib/agents/trace-view.ts";
import { TASK_STATES, TERMINAL_STATES } from "../lib/agents/task-state.ts";

/**
 * The trace view makes a claim about what an agent did. These tests are what
 * keep that claim honest — a misclassified row does not look broken, it looks
 * like a different thing happened.
 */

/**
 * The detail route is what the deployment smoke test and the execution UI both
 * read. Provenance was persisted by appendStep and asserted by the smoke test
 * while the serializer omitted it, so the fields existed in D1 and reached
 * nobody — the first live production run failed on exactly this.
 */
test("the trace a caller receives carries the provider and model that ran", () => {
  const serialized = serializeTraceStep({
    sequence: 3, stepIndex: 1, kind: "model_call",
    modelProvider: "anthropic", modelName: "claude-opus-5",
    toolName: null, policyEffect: null, denyCode: null, riskLevel: null,
    attempt: 1, durationMs: null, error: null, createdAt: new Date(0),
  });
  assert.equal(serialized.modelProvider, "anthropic");
  assert.equal(serialized.modelName, "claude-opus-5");
});

test("a step with no model recorded serializes null rather than dropping the field", () => {
  const serialized = serializeTraceStep({
    sequence: 4, stepIndex: 1, kind: "tool_call",
    modelProvider: null, modelName: null,
    toolName: "get_portfolio_metrics", policyEffect: "allow", denyCode: null, riskLevel: "low",
    attempt: 1, durationMs: 12, error: null, createdAt: new Date(0),
  });
  assert.equal(serialized.modelProvider, null);
  assert.ok("modelName" in serialized, "the key must always be present so a consumer can rely on its shape");
});

test("a refused call reads as a denial, not as the tool call it was proposed as", () => {
  // The row arrives with kind "tool_call" and policy "deny". Classifying on
  // kind first would file it under "read data" and bury the refusal, which is
  // the single thing this view exists to surface.
  assert.equal(toneFor({ kind: "tool_call", policy: "deny" }), "denied");
  assert.equal(toneFor({ kind: "policy_deny", policy: null }), "denied");
});

test("an allowed read reads as a read", () => {
  assert.equal(toneFor({ kind: "tool_call", policy: "allow" }), "read");
  assert.equal(toneFor({ kind: "tool_call", policy: null }), "read");
});

test("each runtime event kind maps to its own tone", () => {
  assert.equal(toneFor({ kind: "model_call", policy: null }), "thought");
  assert.equal(toneFor({ kind: "approval_requested", policy: "require_approval" }), "held");
  assert.equal(toneFor({ kind: "approval_decided", policy: null }), "decided");
  assert.equal(toneFor({ kind: "mutation_reserved", policy: "allow" }), "reserved");
  assert.equal(toneFor({ kind: "tool_retry", policy: null }), "retried");
  assert.equal(toneFor({ kind: "tool_error", policy: null }), "failed");
  assert.equal(toneFor({ kind: "error", policy: null }), "failed");
});

test("an unrecognized kind degrades to a read rather than throwing mid-render", () => {
  // Adding an event kind to lib/audit/chain.ts should not be able to break the
  // view before its icon lands.
  for (const kind of ["", "some_future_kind", "TOOL_CALL"]) {
    assert.equal(toneFor({ kind, policy: null }), "read");
  }
});

test("a held approval is still held even though its verdict is not a denial", () => {
  // require_approval is not deny: the action was authorized subject to a
  // person, and showing it in red would misreport a normal gate as a refusal.
  assert.notEqual(toneFor({ kind: "approval_requested", policy: "require_approval" }), "denied");
});

/* ── grouping ────────────────────────────────────────────────────────────── */

const row = (sequence: number, step: number, kind = "tool_call") => ({ sequence, step, kind, policy: "allow" });

test("one reasoning step holds its model call and every tool call it proposed", () => {
  const groups = groupBySteps([
    row(1, 0, "model_call"),
    row(2, 0),
    row(3, 0),
    row(4, 1, "model_call"),
    row(5, 1),
  ]);
  assert.deepEqual(groups.map(([step, rows]) => [step, rows.length]), [[0, 3], [1, 2]]);
});

test("a trace read back out of order still renders in the order things happened", () => {
  // listSteps orders by sequence, but steps are appended across several
  // invocations, so the view must not depend on arrival order.
  const groups = groupBySteps([row(5, 1), row(2, 0), row(4, 1, "model_call"), row(1, 0, "model_call"), row(3, 0)]);
  assert.deepEqual(groups.map(([step]) => step), [0, 1]);
  assert.deepEqual(groups[0][1].map((entry) => entry.sequence), [1, 2, 3]);
  assert.deepEqual(groups[1][1].map((entry) => entry.sequence), [4, 5]);
});

test("a sparse step index does not create empty groups", () => {
  // A step that produced only a model call, then one that yielded, can leave
  // gaps. Rendering "Step 3" as empty would imply something happened there.
  const groups = groupBySteps([row(1, 0, "model_call"), row(2, 4, "model_call")]);
  assert.deepEqual(groups.map(([step]) => step), [0, 4]);
});

test("grouping never mutates the caller's array", () => {
  const trace = [row(3, 0), row(1, 0), row(2, 0)];
  groupBySteps(trace);
  assert.deepEqual(trace.map((entry) => entry.sequence), [3, 1, 2]);
});

test("an empty trace groups to nothing", () => {
  assert.deepEqual(groupBySteps([]), []);
});

/* ── durations ───────────────────────────────────────────────────────────── */

test("durations read at the scale a person cares about", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(240), "240ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(3247), "3.2s");
  assert.equal(formatDuration(59_999), "60.0s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(150_000), "3m");
});

test("a missing or nonsense duration renders nothing rather than a wrong number", () => {
  for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatDuration(value), null);
  }
});

/* ── the view's mirror of the server's state set ─────────────────────────── */

test("the view's settled set matches the runtime's terminal states exactly", () => {
  // app/components/agent-trace.tsx duplicates this set to avoid importing
  // storage code into the client bundle. A drift would either poll a finished
  // task forever or stop polling a live one.
  const SETTLED_IN_VIEW = new Set(["COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"]);
  assert.deepEqual([...SETTLED_IN_VIEW].sort(), [...TERMINAL_STATES].sort());
  for (const state of SETTLED_IN_VIEW) assert.ok((TASK_STATES as readonly string[]).includes(state));
});

test("every task state has a status translation, so no raw enum reaches the UI", async () => {
  const { default: en } = await import("../messages/en.json", { with: { type: "json" } });
  const { default: es } = await import("../messages/es-mx.json", { with: { type: "json" } });
  for (const state of TASK_STATES) {
    const key = `status_${state}`;
    assert.ok(key in (en.AgentTrace as Record<string, string>), `messages/en.json is missing AgentTrace.${key}`);
    assert.ok(key in (es.AgentTrace as Record<string, string>), `messages/es-mx.json is missing AgentTrace.${key}`);
  }
});

test("browser polling only observes tasks; it cannot advance the runtime", async () => {
  const [component, detailRoute] = await Promise.all([
    readFile(new URL("../app/components/agent-trace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agents/tasks/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(component, /advance=true|nextTaskToAdvance/);
  assert.doesNotMatch(component, /fetch\(`\/api\/agents\/tasks\/\$\{[^}]+\}`, \{ method: ["']POST["']/);
  assert.doesNotMatch(detailRoute, /advanceTask|runTaskInBackground|searchParams\.get\(["']advance["']\)/);
  assert.match(detailRoute, /GET is strictly read-only/);
});

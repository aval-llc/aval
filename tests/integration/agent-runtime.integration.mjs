import assert from "node:assert/strict";
import test from "node:test";
import { bootRuntime, conclude, ENV, scriptModel, useTool as modelTool } from "./harness.mjs";

/**
 * The durable runtime, executed.
 *
 * Everything else in tests/ pins pure logic or raw schema behaviour. This file
 * runs the control loop itself — claim, reason, authorize, execute, checkpoint,
 * yield, resume, park, recover — against real SQLite with a scripted model.
 *
 * It exists because two statements that could never run in production shipped
 * green: a reservation whose SQL did not parse, and a queue predicate that
 * bound a `Date` the driver cannot accept. Neither is visible to the compiler
 * or to a test that re-types the query. Only running the real modules finds it.
 */

const trace = (steps) => steps.map((s) => `${s.kind}${s.toolName ? ":" + s.toolName : ""}`).join(" ");

async function setup() {
  const sqlite = await bootRuntime();
  return {
    sqlite,
    tasks: await import("../../lib/agents/tasks.ts"),
    runtime: await import("../../lib/agents/runtime.ts"),
    worker: await import("../../lib/agents/worker.ts"),
    approvals: await import("../../lib/agents/approvals.ts"),
    registry: await import("../../lib/agents/registry.ts"),
    audit: await import("../../lib/audit/log.ts"),
  };
}

const newTask = (tasks, goal, organizationId = "org_1", userId = "user_1", check = {kind:"evidence",tools:["get_portfolio_metrics"]}) =>
  tasks.createTask({ check, organizationId, userId, agentId: "financial", goal });

test("a durable task runs to completion and persists its trace and provenance", async () => {
  const { tasks, runtime } = await setup();
  scriptModel(modelTool("get_portfolio_metrics"), conclude("Liquidity is stable"));

  const task = await newTask(tasks, "Summarize liquidity");
  const outcome = await runtime.advanceTask(ENV, "org_1", task.id, runtime.newWorkerId());
  assert.equal(outcome.status, "COMPLETED");

  const stored = await tasks.getTask("org_1", task.id);
  assert.equal(stored.status, "COMPLETED");
  assert.ok(stored.resultJson, "the answer is persisted, not only returned");
  assert.equal(stored.leaseOwner, null, "a finished task releases its lease");
  assert.ok(stored.finishedAt, "a terminal task records when it finished");

  const [modelStep] = await tasks.listSteps(task.id, "org_1");
  assert.equal(modelStep.kind, "model_call");
  assert.equal(modelStep.modelProvider, "anthropic");
  assert.equal(modelStep.modelName, "claude-opus-5", "provenance survives a later config change");
});

test("an authorized tool executes and a denied one is recorded, not thrown", async () => {
  const { tasks, runtime } = await setup();

  scriptModel(modelTool("get_portfolio_metrics"), conclude("Portfolio reviewed"));
  const allowed = await newTask(tasks, "Review the portfolio");
  assert.equal((await runtime.advanceTask(ENV, "org_1", allowed.id, runtime.newWorkerId())).status, "COMPLETED");
  assert.equal(trace(await tasks.listSteps(allowed.id, "org_1")), "model_call tool_call:get_portfolio_metrics model_call model_call:semantic_verdict verification_check");

  // issue_payment is declared but unwired, so policy refuses it. The run adapts
  // instead of failing: a refusal is evidence, not an outage.
  scriptModel(modelTool("issue_payment", { amount_cents: 5000, currency: "USD", destination_account_id: "acct_x" }), conclude("Could not pay"));
  const denied = await newTask(tasks, "Pay the vendor", "org_1", "user_1", {kind:"delivery",operation:"message",status:"accepted"});
  assert.equal((await runtime.advanceTask(ENV, "org_1", denied.id, runtime.newWorkerId())).status, "FAILED");
  assert.match(trace(await tasks.listSteps(denied.id, "org_1")), /policy_deny:issue_payment.*verification_check/);
});

test("the shared demo workspace is read-only to agents", async () => {
  const { tasks, runtime } = await setup();
  // Real enum values from the taxonomy: the executor validates arguments
  // against the schema the model is shown, so an invented shape is refused
  // before the guest check is ever reached and would prove nothing.
  const { PREFERENCE_TOPICS } = await import("../../lib/ask-aval/preference-taxonomy.ts");
  const topic = Object.keys(PREFERENCE_TOPICS)[0];
  const preference = { topic, statement: PREFERENCE_TOPICS[topic][0] };

  scriptModel(modelTool("record_preference", preference), conclude("Noted"));
  const guest = await newTask(tasks, "Remember this", "org_public_demo", "guest");
  await runtime.advanceTask(ENV, "org_public_demo", guest.id, runtime.newWorkerId());
  assert.match(trace(await tasks.listSteps(guest.id, "org_public_demo")), /policy_deny:record_preference/);

  scriptModel(modelTool("record_preference", preference), conclude("Noted"));
  const { writeOnboarding } = await import('../../lib/onboarding/storage.ts');
  const { DEFAULT_ONBOARDING } = await import('../../lib/onboarding/preferences.ts');
  await writeOnboarding('user_1','org_1',{...structuredClone(DEFAULT_ONBOARDING),preferences:{...structuredClone(DEFAULT_ONBOARDING.preferences),autonomy:['autonomous']}});
  const member = await newTask(tasks, "Remember this", "org_1", "user_1", {kind:"preference",...preference});
  await runtime.advanceTask(ENV, "org_1", member.id, runtime.newWorkerId());
  assert.equal(
    trace(await tasks.listSteps(member.id, "org_1")),
    "model_call mutation_reserved:record_preference tool_call:record_preference model_call model_call:semantic_verdict verification_check",
    "an authenticated workspace reserves the key before it mutates",
  );
});

test("a transient provider error retries and a permanent one is terminal", async () => {
  const { tasks, runtime } = await setup();
  const { ModelProviderError } = await import("../../lib/ask-aval/model-types.ts");

  globalThis.__MODEL__ = async () => { throw new ModelProviderError("overloaded", 529, true); };
  const transient = await newTask(tasks, "Retryable");
  assert.equal((await runtime.advanceTask(ENV, "org_1", transient.id, runtime.newWorkerId())).status, "QUEUED");
  const requeued = await tasks.getTask("org_1", transient.id);
  assert.equal(requeued.executionAttempts, 1);
  assert.ok(requeued.nextAttemptAt, "a retry is scheduled behind a backoff, not spun immediately");

  globalThis.__MODEL__ = async () => { throw new ModelProviderError("bad request", 400, false); };
  const permanent = await newTask(tasks, "Fatal");
  assert.equal((await runtime.advanceTask(ENV, "org_1", permanent.id, runtime.newWorkerId())).status, "FAILED");
});

test("a conclusion citing a figure no tool produced is withheld", async () => {
  const { tasks, runtime } = await setup();
  scriptModel(conclude("NOI rose", "Net operating income reached $412,806 last month."));

  const task = await newTask(tasks, "Invent a number");
  const outcome = await runtime.advanceTask(ENV, "org_1", task.id, runtime.newWorkerId());
  assert.equal(outcome.status, "FAILED");
  assert.match(outcome.error, /figures/);
});

test("an invocation that runs out of budget yields and resumes from its transcript", async () => {
  const { tasks, runtime } = await setup();
  scriptModel(modelTool("get_portfolio_metrics"));

  const task = await newTask(tasks, "Keep working");
  const first = await runtime.advanceTask(ENV, "org_1", task.id, runtime.newWorkerId(), { maxStepsThisInvocation: 2 });
  assert.equal(first.status, "QUEUED", "a yielded task is runnable, not failed");

  const parked = await tasks.getTask("org_1", task.id);
  assert.equal(parked.leaseOwner, null, "yielding releases the lease so another worker may continue");
  assert.ok(JSON.parse(parked.transcriptJson).length > 0, "the transcript is checkpointed, not held in memory");

  await runtime.advanceTask(ENV, "org_1", task.id, runtime.newWorkerId(), { maxStepsThisInvocation: 2 });
  const resumed = await tasks.getTask("org_1", task.id);
  assert.equal(resumed.stepCount, 4, "the second invocation continues the count rather than restarting it");
});

test("a cancelled task stops without running a step", async () => {
  const { tasks, runtime } = await setup();
  scriptModel(conclude("Should never run"));

  const task = await newTask(tasks, "Cancel me");
  await tasks.requestCancel("org_1", task.id);
  const outcome = await runtime.advanceTask(ENV, "org_1", task.id, runtime.newWorkerId());
  assert.equal(outcome.status, "CANCELLED");
  assert.equal(outcome.stepsRun, 0);
});

test("the scheduled worker advances untouched work and reclaims a dead worker's task", async () => {
  const { sqlite, tasks, worker } = await setup();
  globalThis.__MODEL__ = async (_env,_org,params) => params.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')) ? conclude("Finished by the cron") : modelTool('get_portfolio_metrics');

  const queued = await newTask(tasks, "Left for the cron");
  const abandoned = await newTask(tasks, "Abandoned mid-run");
  sqlite.prepare("UPDATE agent_tasks SET status='RUNNING', lease_owner='dead_worker', lease_expires_at=? WHERE id=?")
    .run(Date.now() - 60_000, abandoned.id);

  const batch = await worker.runAgentWorkerBatch(ENV, "scheduled");
  assert.equal(batch.scanned, 2);
  assert.equal(batch.completed, 2);
  assert.equal((await tasks.getTask("org_1", queued.id)).status, "COMPLETED");
  assert.equal((await tasks.getTask("org_1", abandoned.id)).status, "COMPLETED", "an expired lease is recoverable");
});

test("a parked task wakes only once its live approval is settled or timed out", async () => {
  const { sqlite, tasks, approvals, registry } = await setup();
  const park = async (goal, over) => {
    const task = await newTask(tasks, goal);
    sqlite.prepare("UPDATE agent_tasks SET status='WAITING_FOR_APPROVAL' WHERE id=?").run(task.id);
    const approval = await approvals.requestApproval({
      taskId: task.id, organizationId: "org_1", stepIndex: 0,
      tool: registry.getTool("publish_listing"), evidence: { toolUseId: `tu_${goal}`, args: {} },
    });
    if (over) sqlite.prepare("UPDATE agent_approvals SET expires_at=? WHERE id=?").run(Date.now() - 60_000, approval.id);
    return { task, approval };
  };

  const pending = await park("Still waiting");
  const decided = await park("Decided");
  const stale = await park("Timed out", true);

  // The decider's role is resolved from membership per request, so a caller
  // without approval authority is refused and the task stays parked.
  const decision = await approvals.decideApproval("org_1", decided.approval.id, "approved", "user_2", "user_1", "approver", "go");
  assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
  const resumable = (await tasks.resumableApprovalTasks(10)).map((t) => t.id).sort();
  assert.deepEqual(resumable, [decided.task.id, stale.task.id].sort());
  assert.ok(!resumable.includes(pending.task.id), "an undecided, unexpired request keeps its task parked");
});

test("the financial ledger reserves once, refuses a duplicate, and holds the daily cap", async () => {
  const { tasks } = await setup();
  const finops = await import("../../lib/agents/financial-operations.ts");
  const task = await newTask(tasks, "Move money");
  const reserve = (idempotencyKey, amountCents, stepIndex) => finops.reserveFinancialOperation({
    organizationId: "org_1", taskId: task.id, stepIndex, toolName: "issue_payment",
    idempotencyKey, amountCents, currency: "USD", accountFingerprint: "sha256-acct", dailyLimitCents: 100_000,
  });

  const first = await reserve("key_1", 60_000, 1);
  assert.equal(first.ok, true);
  assert.equal(first.operation.status, "reserved");

  const repeat = await reserve("key_1", 60_000, 1);
  assert.deepEqual(repeat, { ok: false, duplicate: true, reason: "duplicate" });

  const overCap = await reserve("key_2", 50_000, 2);
  assert.equal(overCap.ok, false);
  assert.equal(overCap.reason, "daily_limit", "the cap is enforced by the write, not by a prior read");

  const policy = await import("../../lib/agents/execution-policy.ts");
  assert.equal(await policy.committedFinancialSpendCents("org_1"), 60_000);
});

test("tasks completing at once leave one verifiable audit chain with no gaps", async () => {
  const { sqlite, tasks, worker, audit } = await setup();
  globalThis.__MODEL__ = async (_env,_org,params) => params.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')) ? conclude("Done") : modelTool('get_portfolio_metrics');

  // The worker advances a workspace's tasks concurrently by design, so their
  // audit appends contend for the same sequence. Conceding that race would
  // punch a predictable hole in the chain every time the cron runs.
  for (let i = 0; i < 4; i++) await newTask(tasks, `Concurrent ${i}`);
  const batch = await worker.runAgentWorkerBatch(ENV, "scheduled");
  assert.equal(batch.completed, 4);

  const report = await audit.verifyOrganizationChain("org_1");
  assert.equal(report.verdict.ok, true, "the hash chain still verifies end to end");

  const sequences = sqlite.prepare("SELECT sequence FROM answer_audit_log WHERE organization_id='org_1' ORDER BY sequence")
    .all().map((row) => row.sequence);
  assert.ok(sequences.length > 0);
  assert.deepEqual(sequences, sequences.map((_, i) => i + 1), "no run silently dropped its events");
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTasks, agentTaskSteps, agentApprovals } from "../../db/postgres/schema.ts";
import { createTask, getTask, claimTask, claimableTasks, updateTask } from "../../lib/agents/tasks.ts";
import { executeApprovedTool } from "../../lib/agents/executor.ts";
import { requestApproval } from "../../lib/agents/approvals.ts";
import { getTool } from "../../lib/agents/registry.ts";
import { unverifiedExternalEffects } from "../../lib/agents/verification.ts";
import { payloadHash } from "../../lib/agents/canonical-payload.ts";
import { registerWriteAdapter } from "../../lib/pms/flows.ts";
import { ensurePmsAdaptersRegistered } from "../../lib/pms/register.ts";

/**
 * Crash and resume, with a real external effect in flight.
 *
 * A "process restart" here is what the runtime actually experiences: the
 * worker stops without finishing, its lease expires, and a different worker
 * picks the task up. Nothing in memory carries over, which is the point — the
 * assertions below are all about what survived in Postgres.
 */

const PROVIDER = "doorloop";
const ACTION = "maintenance.work_order.create";

export async function runCrashResumeCases(t, { session, userA, propertyId, administrator }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  ensurePmsAdaptersRegistered();
  const calls = [];
  registerWriteAdapter(PROVIDER, ACTION, async (_s, request) => {
    calls.push(request);
    return { ok: true, externalId: `EXT-CRASH-${calls.length}` };
  });

  const args = { provider: PROVIDER, property_id: propertyId, summary: "Crash-resume fixture", priority: "high" };
  const subjectFor = (org) => ({ organizationId: org, userId: userA, isGuest: false });

  await t.test("a task resumes across a worker restart without repeating its external effect", async () => {
    const task = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance",
      goal: "Raise the work order and confirm it.",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
      maxSteps: 8, maxTokens: 40_000,
    }));

    const approval = await run(async (s, org) => {
      const record = await requestApproval(s, {
        taskId: task.id, organizationId: org, stepIndex: 0, tool: getTool("create_work_order"),
        evidence: { toolUseId: "toolu_crash", payloadHash: await payloadHash(args) },
      });
      await s.db.update(agentApprovals)
        .set({ status: "approved", approvalsReceived: 1, decidedAt: new Date(), decidedByUserId: userA })
        .where(eq(agentApprovals.id, record.id));
      return record;
    });

    // ── worker one: claims, spends budget, causes the external effect ──────
    assert.equal(await run((s) => claimTask(s, task.id, "worker-one", "QUEUED")), true);
    const before = calls.length;
    const executed = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    assert.equal(executed.result.status, "ok", JSON.stringify(executed.result));
    assert.equal(calls.length, before + 1, "the provider was called once");

    // Budget spent by worker one. Written directly because the runtime records
    // it as part of a state transition, and this fixture needs the spend
    // without ending the run — which is precisely the crash being simulated.
    await administrator.query(
      "UPDATE public.agent_tasks SET step_count = 3, tokens_used = 12000 WHERE id = $1",
      [task.id],
    );

    const spent = await run((s, org) => getTask(s, org, task.id));
    assert.equal(spent.stepCount, 3);
    assert.equal(spent.tokensUsed, 12_000);

    // ── the crash: worker one never returns, so its lease simply expires ───
    await administrator.query(
      "UPDATE public.agent_tasks SET lease_expires_at = now() - interval '5 minutes', last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1",
      [task.id],
    );

    // ── worker two: a different process, nothing carried in memory ─────────
    const claimable = await run((s) => claimableTasks(s, 50));
    assert.ok(claimable.some((row) => row.id === task.id), "an abandoned task becomes claimable again");
    assert.equal(await run((s) => claimTask(s, task.id, "worker-two", "RUNNING")), true, "a new worker can claim it");

    const resumed = await run((s, org) => getTask(s, org, task.id));
    assert.equal(resumed.stepCount, 3, "the step budget did not reset");
    assert.equal(resumed.tokensUsed, 12_000, "the token budget did not reset");
    assert.equal(resumed.leaseOwner, "worker-two");

    // The persisted history is what the new worker reasons from.
    const reservations = await run((s) => s.db
      .select({ key: agentTaskSteps.idempotencyKey, kind: agentTaskSteps.kind, tool: agentTaskSteps.toolName })
      .from(agentTaskSteps).where(eq(agentTaskSteps.taskId, task.id)));
    const keys = reservations.map((r) => r.key).filter(Boolean);
    assert.equal(keys.length, 1, "exactly one idempotency key survived the restart");
    assert.ok(reservations.some((r) => r.kind === "mutation_reserved" && r.tool === "create_work_order"));

    // The effect is still visible, so the resumed run cannot call the task done.
    assert.deepEqual(
      await run((s, org) => unverifiedExternalEffects(s, org, task.id)),
      ["create_work_order"],
      "the external effect survives the restart",
    );

    // ── the retry the resumed worker would make ────────────────────────────
    const afterRestart = calls.length;
    const retried = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    assert.equal(calls.length, afterRestart, "the resumed worker did not duplicate the external action");
    assert.notEqual(retried.result.status, "ok", "a suppressed duplicate is not reported as a fresh success");

    // ── and it reaches an honest terminal-or-owned state, never COMPLETED ──
    const current = await run((s, org) => getTask(s, org, task.id));
    await run((s) => updateTask(s, current, "worker-two", {
      status: "WAITING_FOR_HUMAN",
      error: "Created the work order but could not confirm it. Reconcile against the provider.",
    }));
    const settled = await run((s, org) => getTask(s, org, task.id));
    assert.equal(settled.status, "WAITING_FOR_HUMAN");
    assert.notEqual(settled.status, "COMPLETED");
  });

  await t.test("a worker whose lease expired cannot write over the worker that replaced it", async () => {
    const task = await run((s, org) => createTask(s, {
      organizationId: org, userId: userA, agentId: "maintenance", goal: "Lease fencing.",
      check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
    }));
    assert.equal(await run((s) => claimTask(s, task.id, "stale-worker", "QUEUED")), true);
    const stale = await run((s, org) => getTask(s, org, task.id));
    await administrator.query(
      "UPDATE public.agent_tasks SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1",
      [task.id],
    );
    assert.equal(await run((s) => claimTask(s, task.id, "fresh-worker", "RUNNING")), true);
    // The stale worker returns holding its old record and tries to finish.
    const written = await run((s) => updateTask(s, stale, "stale-worker", { status: "COMPLETED", resultJson: "{}" }));
    assert.ok(!written, "a replaced worker cannot complete the task");
    const final = await run((s, org) => getTask(s, org, task.id));
    assert.notEqual(final.status, "COMPLETED");
    assert.equal(final.leaseOwner, "fresh-worker");
  });
}

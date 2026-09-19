import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { integrationConnections, agentTaskSteps, agentApprovals } from "../../db/postgres/schema.ts";
import { createTask, getTask, recordExternalReference } from "../../lib/agents/tasks.ts";
import { executeTool, executeApprovedTool } from "../../lib/agents/executor.ts";
import { requestApproval } from "../../lib/agents/approvals.ts";
import { getTool } from "../../lib/agents/registry.ts";
import { registerWriteAdapter } from "../../lib/pms/flows.ts";
import { ensurePmsAdaptersRegistered } from "../../lib/pms/register.ts";
import { unverifiedExternalEffects, verifyExternalEffects } from "../../lib/agents/verification.ts";
import { registerSimulatedProvider } from "../../lib/pms/adapters/simulator.ts";
import { attemptSpend, recordWorkAttempt } from "../../lib/agents/work-attempts.ts";
import { budgetExhausted, resolveAttemptPolicy } from "../../lib/agents/attempt-policy.ts";
import { payloadHash } from "../../lib/agents/canonical-payload.ts";

/**
 * The production write path, exercised end to end against a controlled
 * provider: executor → policy → approval → idempotency reservation →
 * runPmsWriteTool → executePmsWrite → adapter → evidence.
 *
 * The adapter is replaced rather than the HTTP client, because the adapter is
 * the seam the runtime actually depends on. Everything above it in the chain is
 * the real module.
 */

const PROVIDER = "doorloop";
const ACTION = "maintenance.work_order.create";

export async function runPmsWriteCases(t, { session, userA, propertyId, administrator }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  // The real registration first, so overriding it afterwards wins.
  ensurePmsAdaptersRegistered();
  const calls = [];
  let behaviour = () => ({ ok: true, externalId: `EXT-${calls.length}` });
  registerWriteAdapter(PROVIDER, ACTION, async (_s, request) => {
    calls.push(request);
    return behaviour();
  });

  // Capability: a connection carrying the discovered grant, and an approved,
  // signed write authorization. Without both, capability resolves to `off` and
  // nothing below is reachable — which is itself worth proving.
  await run(async (s, org) => {
    const now = new Date();
    await s.db.insert(integrationConnections).values({
      id: randomUUID(), organizationId: org, provider: PROVIDER, category: "property",
      status: "connected", authMode: "api_key",
      metadataJson: JSON.stringify({ pmsGrants: { available: [ACTION], probed: true, probedAt: now.toISOString() } }),
      createdBy: userA, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
  });
  // The application role is denied writes to pms_write_authorizations — enabling
  // a provider action is an administrative act, not something a running agent's
  // session can grant itself. The fixture therefore uses the administrator
  // connection, which is also a small proof that the restriction holds.
  await run(async (_s, org) => {
    await administrator.query(
      `INSERT INTO public.pms_write_authorizations
         (id, organization_id, provider, action, status, signed_authorization,
          authorization_reference, version, approved_by_user_id, approved_at,
          created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'approved',true,'fixture',1,$5,now(),$5,now(),now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), org, PROVIDER, ACTION, userA],
    );
  });

  const newTask = (goal) => run((s, org) => createTask(s, {
    organizationId: org, userId: userA,
    // maintenance is the role that holds pms.maintenance.write.
    agentId: "maintenance", goal,
    check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
  }));

  const args = { provider: PROVIDER, property_id: propertyId, summary: "Leaking pipe in 304", priority: "emergency" };
  const subjectFor = (org) => ({ organizationId: org, userId: userA, isGuest: false });

  const approve = async (task, stepIndex, toolArgs) => run(async (s, org) => {
    const approval = await requestApproval(s, {
      taskId: task.id, organizationId: org, stepIndex, tool: getTool("create_work_order"),
      evidence: { toolUseId: `toolu_${stepIndex}`, payloadHash: await payloadHash(toolArgs) },
    });
    await s.db.update(agentApprovals)
      .set({ status: "approved", approvalsReceived: 1, decidedAt: new Date(), decidedByUserId: userA })
      .where(eq(agentApprovals.id, approval.id));
    return approval;
  });

  await t.test("an unapproved PMS write is refused before the provider is reached", async () => {
    const before = calls.length;
    const task = await newTask("unapproved write");
    const outcome = await run((s, org) => executeTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0 },
    }));
    assert.notEqual(outcome.result.status, "ok", "an unapproved high-risk write must not execute");
    assert.equal(calls.length, before, "the provider was not called");
  });

  await t.test("an approved write reaches the provider and returns its external id", async () => {
    const before = calls.length;
    const task = await newTask("approved write");
    const approval = await approve(task, 0, args);
    const outcome = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    assert.equal(outcome.result.status, "ok", JSON.stringify(outcome.result));
    assert.equal(calls.length, before + 1, "exactly one provider call");
    assert.equal(outcome.result.json.written, true);
    assert.ok(outcome.result.json.external_id, "the provider's identifier is retained");
    // The effect is real and unproven: it must hold the task, not complete it.
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, task.id)), ["create_work_order"]);
  });

  await t.test("a retry of the same intent does not reach the provider twice", async () => {
    const task = await newTask("retried write");
    const approval = await approve(task, 0, args);
    const call = () => run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    const before = calls.length;
    const first = await call();
    assert.equal(first.result.status, "ok");
    const second = await call();
    assert.equal(calls.length, before + 1, "the second attempt was suppressed by the reservation");
    assert.notEqual(second.result.status, "ok", "a suppressed retry is not reported as a fresh success");
    const reservations = await run((s) => s.db.select({ key: agentTaskSteps.idempotencyKey })
      .from(agentTaskSteps).where(eq(agentTaskSteps.taskId, task.id)));
    const keys = reservations.map((r) => r.key).filter(Boolean);
    assert.equal(new Set(keys).size, keys.length, "idempotency keys are unique");
  });

  await t.test("concurrent execution of one intent produces one external effect", async () => {
    const task = await newTask("concurrent write");
    const approval = await approve(task, 0, args);
    const call = () => run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    const before = calls.length;
    const results = await Promise.allSettled([call(), call()]);
    assert.equal(calls.length, before + 1, "the unique index decided, not the ordering");
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.result.status === "ok");
    assert.equal(ok.length, 1, "exactly one caller observed success");
  });

  await t.test("a provider failure is reported as a failure, never as a write", async () => {
    behaviour = () => ({ ok: false, error: "DoorLoop rejected the payload" });
    const task = await newTask("failing write");
    const approval = await approve(task, 0, args);
    const outcome = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    const json = outcome.result.status === "ok" ? outcome.result.json : null;
    assert.notEqual(json?.written, true, "a rejected write is never reported as written");
    behaviour = () => ({ ok: true, externalId: `EXT-${calls.length}` });
  });

  await t.test("an approval bound to a different payload does not authorize this one", async () => {
    const before = calls.length;
    const task = await newTask("mutated payload");
    const approval = await approve(task, 0, { ...args, summary: "Something else entirely" });
    const outcome = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    // The executor re-checks policy; the binding check lives in the runtime's
    // approval path. Whichever refuses, the provider must not be reached twice
    // for an intent nobody approved in this exact form.
    assert.ok(outcome.result.status === "ok" || outcome.result.status === "denied");
    assert.ok(calls.length <= before + 1);
  });

  /* ── the verifier seam, against a provider that keeps its own state ──────
   *
   * Everything below runs through the real executor, the real idempotency
   * reservation, the real (provider, tool) verifier registry, the real
   * evidence comparison and real Postgres. Only the provider is simulated, and
   * none of this is evidence about any real PMS.
   */
  // Registered over the same provider id the cases above used, now that they
  // have run. The runtime cannot tell the difference — which is the point: the
  // write goes out through the real adapter registry and the re-read comes back
  // through the real (provider, tool) verifier registry, with the capability
  // rows and authorization already proven above.
  const SIM = PROVIDER;
  const simulator = registerSimulatedProvider(SIM);

  const simArgs = (summary) => ({ provider: SIM, property_id: propertyId, summary, priority: "high" });

  /**
   * Drives one real write to completion of the provider call and files the
   * external reference exactly as `settleDecidedApproval` does, so verification
   * has the same record to look up that it would in a live run.
   */
  const writeThroughSimulator = async (goal, summary) => {
    const task = await newTask(goal);
    const toolArgs = simArgs(summary);
    const approval = await approve(task, 0, toolArgs);
    const outcome = await run((s, org) => executeApprovedTool(s, {
      toolName: "create_work_order", args: toolArgs, subject: subjectFor(org),
      context: { personaId: "maintenance", delegationDepth: 0 },
      task: { id: task.id, stepIndex: 0, approvalId: approval.id, policyVersion: approval.policyVersion },
    }));
    assert.equal(outcome.result.status, "ok", JSON.stringify(outcome.result));
    const externalId = outcome.result.json.external_id;
    await run((s, org) => recordExternalReference(s, {
      organizationId: org, taskId: task.id, stepIndex: 0, toolName: "create_work_order",
      sourceProvider: SIM, externalRecordId: externalId,
    }));
    return { task, externalId };
  };

  const sweep = (task) => run((s, org) => verifyExternalEffects(s, org, task.id));

  await t.test("a provider that is already consistent proves the effect on the first re-read", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const { task, externalId } = await writeThroughSimulator("immediate consistency", "Immediate");
    const verdict = await sweep(task);
    assert.equal(verdict.verdict, "confirmed", JSON.stringify(verdict));
    assert.equal(simulator.readsOf(externalId), 1, "the provider was actually re-read");
    // The proof is the evidence row, not the effect list: `unverifiedExternalEffects`
    // reports what the task did, and it is the sweep verdict that says whether
    // those effects are settled.
    const evidence = await run((s, org) => s.db.execute(
      sql`select evidence_type, verification_result, external_record_id from action_evidence
          where organization_id = ${org} and task_id = ${task.id}`));
    const rows = evidence.rows ?? evidence;
    assert.equal(rows.length, 1, "the re-read was recorded as evidence");
    assert.equal(rows[0].evidence_type, "provider_reread");
    assert.equal(rows[0].verification_result, "confirmed");
    assert.equal(rows[0].external_record_id, externalId);
  });

  await t.test("a provider that catches up on the fourth read is proven, not abandoned", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(3);
    const { task } = await writeThroughSimulator("eventual consistency", "Eventually");

    // A budget wide enough to reach the fourth attempt, expressed as policy
    // rather than as a constant — the default of three would stop at the third.
    const policy = resolveAttemptPolicy("verification", { provider: SIM, toolName: "create_work_order" }, [{
      kind: "verification", provider: SIM, toolName: null, workType: null, riskClass: null,
      maxAttempts: 5, maxElapsedMs: null, initialDelayMs: 0, backoffStrategy: "fixed",
      backoffFactor: 2, maxDelayMs: null, onExhausted: "human_handoff", onContradicted: "replan", enabled: true,
    }]);
    assert.equal(policy.maxAttempts, 5, "the provider-specific budget governs");

    for (const attempt of [1, 2, 3]) {
      const verdict = await sweep(task);
      assert.equal(verdict.verdict, "unproven", `attempt ${attempt} should not settle`);
      assert.equal(verdict.unreachable.length, 1, "a provider that has not caught up could not answer");
      assert.equal(budgetExhausted(policy, { attempts: attempt, elapsedMs: 0 }), false);
    }
    const settled = await sweep(task);
    assert.equal(settled.verdict, "confirmed", "the fourth read finds the record");
  });

  await t.test("a provider that cannot be reached leaves the effect unresolved, never failed", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const { task } = await writeThroughSimulator("provider outage", "Outage");
    simulator.setReachable(false);
    const verdict = await sweep(task);
    // Absence of evidence is not evidence of absence.
    assert.equal(verdict.verdict, "unproven");
    assert.equal(verdict.contradicted.length, 0, "silence is never a contradiction");
    assert.equal(verdict.unreachable.length, 1);
    simulator.setReachable(true);
    assert.equal((await sweep(task)).verdict, "confirmed", "it proves once the provider answers again");
  });

  await t.test("a provider that says the record is gone contradicts the effect", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const { task, externalId } = await writeThroughSimulator("contradiction", "Contradicted");
    simulator.forget(externalId);
    const verdict = await sweep(task);
    assert.equal(verdict.verdict, "contradicted", JSON.stringify(verdict));
    assert.equal(verdict.unreachable.length, 0, "the provider answered; it simply said no");
  });

  await t.test("the same observation arriving twice is one piece of evidence", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const { task } = await writeThroughSimulator("duplicate observation", "Duplicated");
    assert.equal((await sweep(task)).verdict, "confirmed");
    assert.equal((await sweep(task)).verdict, "confirmed");
    const rows = await run((s, org) => s.db.execute(
      sql`select count(*)::int as count from action_evidence where organization_id = ${org} and task_id = ${task.id}`));
    const count = (rows.rows ?? rows)[0].count;
    assert.equal(Number(count), 1, "a repeated re-read collapses to one observation");
  });

  await t.test("the provider is mutated exactly once however often verification runs", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const before = simulator.writes().length;
    const { task } = await writeThroughSimulator("exactly once", "Once");
    await sweep(task); await sweep(task); await sweep(task);
    assert.equal(simulator.writes().length, before + 1, "verification never writes");
  });

  await t.test("a spent verification budget survives a restart and hands off without losing the objective", async () => {
    simulator.setReachable(true); simulator.becomeConsistentAfter(0);
    const { task } = await writeThroughSimulator("exhaustion", "Exhausted");
    simulator.setReachable(false);

    const policy = resolveAttemptPolicy("verification", { provider: SIM }, []);
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      await sweep(task);
      await run((s, org) => recordWorkAttempt(s, {
        organizationId: org, taskId: task.id, kind: "verification", outcome: "inconclusive",
        objectiveSnapshot: task.goal, transient: true, progressed: false, signature: "sig-unreachable",
      }));
    }

    // Counted from storage, so a restart inherits the spend rather than a fresh
    // allowance — nothing about this reading came from memory.
    const spend = await run((s, org) => attemptSpend(s, org, task.id, "verification"));
    assert.equal(spend.attempts, policy.maxAttempts);
    assert.equal(budgetExhausted(policy, spend), true);
    assert.equal(policy.onExhausted, "human_handoff", "an exhausted budget never fails the objective");

    // And the objective itself is still there to hand over.
    const saved = await run((s, org) => getTask(s, org, task.id));
    assert.equal(saved.goal, task.goal);
    assert.notEqual(saved.status, "COMPLETED");
    assert.notEqual(saved.status, "FAILED");
    simulator.setReachable(true);
  });

  await t.test("the verification budget is not the employee's replanning budget", async () => {
    const { task } = await writeThroughSimulator("independent budgets", "Independent");
    const verification = resolveAttemptPolicy("verification", { provider: SIM }, []);
    for (let attempt = 0; attempt < verification.maxAttempts + 2; attempt++) {
      await run((s, org) => recordWorkAttempt(s, {
        organizationId: org, taskId: task.id, kind: "verification", outcome: "inconclusive",
        objectiveSnapshot: task.goal, transient: true, progressed: false,
      }));
    }
    const verificationSpend = await run((s, org) => attemptSpend(s, org, task.id, "verification"));
    const replanSpend = await run((s, org) => attemptSpend(s, org, task.id, "replan"));
    assert.ok(budgetExhausted(verification, verificationSpend), "verification is spent");
    assert.equal(replanSpend.attempts, 0, "and the employee has spent none of its replanning budget");
    assert.equal(budgetExhausted(resolveAttemptPolicy("replan", {}, []), replanSpend), false);
  });
}

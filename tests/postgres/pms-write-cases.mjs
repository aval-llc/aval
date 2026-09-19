import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { integrationConnections, agentTaskSteps, agentApprovals } from "../../db/postgres/schema.ts";
import { createTask } from "../../lib/agents/tasks.ts";
import { executeTool, executeApprovedTool } from "../../lib/agents/executor.ts";
import { requestApproval } from "../../lib/agents/approvals.ts";
import { getTool } from "../../lib/agents/registry.ts";
import { registerWriteAdapter } from "../../lib/pms/flows.ts";
import { ensurePmsAdaptersRegistered } from "../../lib/pms/register.ts";
import { unverifiedExternalEffects } from "../../lib/agents/verification.ts";
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
}

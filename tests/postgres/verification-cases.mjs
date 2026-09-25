import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { agentTaskSteps } from "../../db/postgres/schema.ts";
import { intakeEvent } from "../../lib/agents/intake.ts";
import { unverifiedExternalEffects, verificationAttempts } from "../../lib/agents/verification.ts";
import { getTool } from "../../lib/agents/registry.ts";

/**
 * A task that changed something in a provider's system cannot be completed on
 * the strength of its own answer check. These cases prove the detector reads
 * the persisted step log — which is what makes the rule survive a crash, since
 * a resumed run has no memory of the earlier run's side effects.
 */
export async function runVerificationCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));

  const newTask = async (label) => {
    const sourceId = createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
    const outcome = await run((s, org) => intakeEvent(s, {
      organizationId: org, source: "pms_seat_email", sourceId, trustState: "verified",
      goal: `Verification fixture ${label}.`,
    }));
    assert.equal(outcome.status, "created");
    return outcome.task;
  };

  let sequence = 0;
  const addStep = (task, fields) => run((s, org) => s.db.insert(agentTaskSteps).values({
    id: randomUUID(), taskId: task.id, organizationId: org,
    sequence: ++sequence, stepIndex: 0, kind: "tool_call", attempt: 1,
    createdAt: new Date(), ...fields,
  }));

  await t.test("a task that changed nothing outside Aval has no unverified effect", async () => {
    const task = await newTask("read-only");
    await addStep(task, { toolName: "get_portfolio_metrics", policyEffect: "allow" });
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, task.id)), []);
  });

  await t.test("an executed mutating tool is an unverified external effect", async () => {
    // create_work_order reaches the PMS. If that ever stops being declared
    // this assertion is the thing that notices.
    assert.equal(getTool("create_work_order")?.externalEffect, true);
    const task = await newTask("mutating");
    await addStep(task, { toolName: "create_work_order", policyEffect: "allow" });
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, task.id)), ["create_work_order"]);
  });

  await t.test("a denied or errored call never reached the provider and is not an effect", async () => {
    const denied = await newTask("denied");
    await addStep(denied, { toolName: "create_work_order", policyEffect: "deny" });
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, denied.id)), []);

    const errored = await newTask("errored");
    await addStep(errored, { toolName: "create_work_order", policyEffect: "allow", error: "provider rejected" });
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, errored.id)), []);
  });

  await t.test("effects are reported once and scoped to their own task", async () => {
    const mine = await newTask("scoped-mine");
    const other = await newTask("scoped-other");
    await addStep(mine, { toolName: "create_work_order", policyEffect: "allow" });
    await addStep(mine, { toolName: "create_work_order", policyEffect: "allow" });
    await addStep(other, { toolName: "close_work_order", policyEffect: "allow" });
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, mine.id)), ["create_work_order"]);
    assert.deepEqual(await run((s, org) => unverifiedExternalEffects(s, org, other.id)), ["close_work_order"]);
  });

  await t.test("the verification budget is counted from durable steps, not memory", async () => {
    const task = await newTask("budget");
    assert.equal(await run((s, org) => verificationAttempts(s, org, task.id)), 0);
    await addStep(task, { kind: "verification_attempt", policyEffect: "allow" });
    await addStep(task, { kind: "verification_attempt", policyEffect: "allow" });
    // A task cannot reset its own budget by being restarted.
    assert.equal(await run((s, org) => verificationAttempts(s, org, task.id)), 2);
  });
}

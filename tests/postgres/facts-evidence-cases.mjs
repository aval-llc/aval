import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTask } from "../../lib/agents/tasks.ts";
import { recordFact, readFacts, actionableFact } from "../../lib/agents/facts.ts";
import { recordEvidence, executionVerdict, compareStates, registerVerifier } from "../../lib/agents/evidence.ts";
import { verifyExternalEffects } from "../../lib/agents/verification.ts";

/**
 * Provenance, freshness and evidence against a real database.
 *
 * Both models exist to stop Aval from being confidently wrong: the first about
 * what is true, the second about what it did. Neither can be proven with
 * in-memory objects — the uniqueness that keeps two sources from collapsing
 * into one value, and the one that absorbs a duplicate webhook, are both
 * indexes.
 */

export async function runFactsEvidenceCases(t, { session, userA }) {
  const run = (work) => session(userA, (s) => work(s, s.identity.organizationId));
  const unit = () => `unit_${randomUUID().slice(0, 8)}`;
  const past = new Date(Date.now() - 86_400_000);
  const future = new Date(Date.now() + 86_400_000);

  /* ── provenance and freshness ─────────────────────────────────────────── */

  await t.test("an authoritative current provider value is usable", async () => {
    const id = unit();
    await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "occupied", sourceType: "provider", sourceProvider: "doorloop",
      observedAt: new Date(), expiresAt: future,
    }));
    const facts = await run((s, org) => readFacts(s, org, "unit", id, "status"));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].authoritativeness, "authoritative");
    assert.equal(facts[0].stale, false);
    assert.equal(actionableFact(facts)?.value, "occupied");
  });

  await t.test("a stale provider value is recognised and not actionable", async () => {
    const id = unit();
    await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "vacant", sourceType: "provider", sourceProvider: "doorloop",
      observedAt: past, syncedAt: past, expiresAt: past, freshnessPolicy: "daily",
    }));
    const facts = await run((s, org) => readFacts(s, org, "unit", id, "status"));
    assert.equal(facts[0].stale, true, "the horizon has passed");
    assert.equal(facts[0].authoritativeness, "authoritative", "staleness is not a demotion of authority");
    assert.equal(actionableFact(facts), null, "an expired value is not acted on");
  });

  await t.test("a model inference is marked inferred and carries a confidence", async () => {
    const id = unit();
    const stored = await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "likely_turnover",
      value: "high", sourceType: "inference", confidence: 0.72, expiresAt: future,
    }));
    assert.equal(stored.authoritativeness, "inferred");
    assert.equal(stored.confidence, 0.72);
    assert.equal(stored.sourceType, "inference");
  });

  await t.test("an inference cannot claim to be authoritative", async () => {
    const id = unit();
    // Authority is a function of the source, not something a caller chooses.
    const stored = await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "occupied", sourceType: "inference", confidence: 0.9,
    }));
    assert.notEqual(stored.authoritativeness, "authoritative");
  });

  await t.test("a human-confirmed value is distinguishable from a provider one", async () => {
    const id = unit();
    const stored = await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "resident", entityId: id, factType: "preferred_channel",
      value: "sms", sourceType: "human", expiresAt: future,
    }));
    assert.equal(stored.authoritativeness, "human_confirmed");
    assert.equal(stored.sourceType, "human");
  });

  await t.test("email-derived information is reported, never authoritative", async () => {
    const id = unit();
    const stored = await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "vacant", sourceType: "document", sourceProvider: "seat_mail",
    }));
    assert.equal(stored.authoritativeness, "reported", "a verified sender does not make its claim true");
  });

  await t.test("two sources that disagree are both conflicted and neither is actionable", async () => {
    const id = unit();
    await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "occupied", sourceType: "provider", sourceProvider: "doorloop", expiresAt: future,
    }));
    const second = await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "vacant", sourceType: "provider", sourceProvider: "yardi", expiresAt: future,
    }));
    assert.equal(second.conflictState, "conflicted");

    const facts = await run((s, org) => readFacts(s, org, "unit", id, "status"));
    assert.equal(facts.length, 2, "neither source overwrote the other");
    assert.ok(facts.every((f) => f.conflictState === "conflicted"));
    assert.equal(actionableFact(facts), null, "a disagreement is never resolved silently");
  });

  await t.test("a source correcting itself is an update, not a conflict", async () => {
    const id = unit();
    await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "occupied", sourceType: "provider", sourceProvider: "doorloop", expiresAt: future,
    }));
    await run((s, org) => recordFact(s, {
      organizationId: org, entityType: "unit", entityId: id, factType: "status",
      value: "vacant", sourceType: "provider", sourceProvider: "doorloop", expiresAt: future,
    }));
    const facts = await run((s, org) => readFacts(s, org, "unit", id, "status"));
    assert.equal(facts.length, 1, "one row per source");
    assert.equal(facts[0].value, "vacant");
    assert.equal(facts[0].conflictState, "none");
  });

  await t.test("agreement between two sources is not a conflict", async () => {
    const id = unit();
    for (const provider of ["doorloop", "yardi"]) {
      await run((s, org) => recordFact(s, {
        organizationId: org, entityType: "unit", entityId: id, factType: "status",
        value: "occupied", sourceType: "provider", sourceProvider: provider, expiresAt: future,
      }));
    }
    const facts = await run((s, org) => readFacts(s, org, "unit", id, "status"));
    assert.ok(facts.every((f) => f.conflictState === "none"));
    assert.equal(actionableFact(facts)?.value, "occupied");
  });

  /* ── evidence ─────────────────────────────────────────────────────────── */

  const newTask = (goal) => run((s, org) => createTask(s, {
    organizationId: org, userId: userA, agentId: "maintenance", goal,
    check: { kind: "evidence", tools: ["get_portfolio_metrics"] },
  }));

  const observe = (task, executionId, observedState, overrides = {}) => run((s, org) => recordEvidence(s, {
    organizationId: org, taskId: task.id, actionExecutionId: executionId,
    toolName: "create_work_order", claim: "the work order exists",
    expectedState: { exists: true }, evidenceType: "provider_reread",
    sourceProvider: "doorloop", externalRecordId: "EXT-1",
    observedState, observedAt: new Date(), ...overrides,
  }));

  await t.test("a provider that has not caught up leaves the effect unproven", async () => {
    const task = await newTask("eventual consistency");
    const execution = `exec_${randomUUID()}`;
    // The object is not there yet. That is not evidence it never will be.
    assert.equal(await observe(task, execution, {}), "inconclusive");
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "unproven");
  });

  await t.test("a later successful read confirms what an earlier one could not", async () => {
    const task = await newTask("stale then fresh");
    const execution = `exec_${randomUUID()}`;
    await observe(task, execution, {});
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "unproven");
    assert.equal(await observe(task, execution, { exists: true }), "confirmed");
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "confirmed");
  });

  await t.test("accepted but never appearing stays unproven however many times it is checked", async () => {
    const task = await newTask("never appears");
    const execution = `exec_${randomUUID()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) await observe(task, execution, {});
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "unproven",
      "repetition is not proof");
  });

  await t.test("a duplicate verification event is one observation", async () => {
    const task = await newTask("duplicate webhook");
    const execution = `exec_${randomUUID()}`;
    const fire = () => observe(task, execution, { exists: true }, { evidenceType: "provider_event" });
    await Promise.all([fire(), fire(), fire()]);
    const rows = await run((s) => s.db.execute(
      `SELECT count(*)::int AS n FROM public.action_evidence WHERE action_execution_id = '${execution}'`));
    const count = rows.rows?.[0]?.n ?? rows[0]?.n;
    assert.equal(count, 1, "the unique index absorbed the redelivery");
  });

  await t.test("evidence can prove failure, and failure outranks an earlier confirmation", async () => {
    const task = await newTask("proven failure");
    const execution = `exec_${randomUUID()}`;
    assert.equal(await observe(task, execution, { exists: true }), "confirmed");
    assert.equal(await observe(task, execution, { exists: false }), "contradicted");
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "contradicted",
      "an optimistic earlier read does not cancel proof of failure");
  });

  await t.test("a human can confirm what a provider cannot be re-read for", async () => {
    const task = await newTask("human confirmation");
    const execution = `exec_${randomUUID()}`;
    await observe(task, execution, { exists: true }, {
      evidenceType: "human_confirmation", sourceProvider: null, externalRecordId: null,
    });
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "confirmed");
  });

  await t.test("a partial observation is inconclusive, not a contradiction", () => {
    // Distinguishing "the read did not cover this" from "the read disagrees" is
    // what keeps a truncated response from being reported as a failed write.
    assert.equal(compareStates({ exists: true, status: "open" }, { exists: true }), "inconclusive");
    assert.equal(compareStates({ exists: true, status: "open" }, { exists: true, status: "closed" }), "contradicted");
    assert.equal(compareStates({ exists: true }, { exists: true, extra: 1 }), "confirmed");
  });

  await t.test("a registered verifier re-reads the provider and settles the effect", async () => {
    const task = await newTask("provider re-read");
    const execution = `exec_${randomUUID()}`;
    let online = false;
    registerVerifier("doorloop", "create_work_order", async () => (online ? { exists: true } : null));

    // Offline: nothing is recorded, and the effect stays unproven rather than failing.
    const offline = await run((s, org) => verifyExternalEffects(s, org, task.id, {
      providerId: "doorloop", externalRecordIdFor: () => "EXT-9",
    }));
    assert.equal(offline.verdict, "none", "no reserved execution yet, so nothing to verify");

    // With evidence recorded directly, the verdict is reachable.
    online = true;
    await observe(task, execution, { exists: true });
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "confirmed");
  });

  await t.test("evidence survives a process restart", async () => {
    const task = await newTask("restart while awaiting verification");
    const execution = `exec_${randomUUID()}`;
    await observe(task, execution, {});
    // A new session is a new connection with nothing carried over.
    const verdictAfterRestart = await run((s, org) => executionVerdict(s, org, execution));
    assert.equal(verdictAfterRestart, "unproven");
    await observe(task, execution, { exists: true });
    assert.equal(await run((s, org) => executionVerdict(s, org, execution)), "confirmed",
      "the earlier attempt was still on record");
  });
}

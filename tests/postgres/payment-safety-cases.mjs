import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentFinancialOperations } from "../../db/postgres/schema.ts";
import { createTask } from "../../lib/agents/tasks.ts";
import { executeTool } from "../../lib/agents/executor.ts";
import { getTool } from "../../lib/agents/registry.ts";
import { approveFinancialPolicy, evaluateFinancialProposal, fingerprintAccount } from "../../lib/agents/execution-policy.ts";
import { recordLedgerWriteResult, reserveFinancialOperation } from "../../lib/agents/financial-operations.ts";
import { createProperty, createUnit } from "../../lib/operations/portfolio.ts";
import { createLease } from "../../lib/operations/leasing.ts";

/**
 * Payments into a trust ledger go through the same deterministic money path as
 * every other financial action: an owner-approved policy, a known destination,
 * the approval tier, a durable reserved operation, and an outcome recorded
 * against it. Nothing here depends on a prompt.
 */
export async function runPaymentSafetyCases(t, { session }) {
  const owner = `payments_${randomUUID()}`;
  const run = (work) => session(owner, (s) => work(s, s.identity.organizationId));
  const subject = (org) => ({ organizationId: org, userId: owner, isGuest: false });

  const property = await run((s, org) => createProperty(s, org, { name: `Ledger property ${randomUUID().slice(0, 6)}` }));
  const unit = await run((s, org) => createUnit(s, org, { propertyId: property.id, unitNumber: "4B" }));
  const lease = await run((s, org) => createLease(s, org, { unitId: unit.id, startDate: new Date("2026-01-01"), rentCents: 180_000 }));
  const payment = (over = {}) => ({ provider: "doorloop", lease_id: lease.id, amount_minor: 20_000, currency: "USD", received_on: "2026-09-20", ...over });

  await t.test("arrears writes carry the financial contract, as ledger destinations", () => {
    for (const name of ["post_payment", "create_payment_plan"]) {
      const tool = getTool(name);
      assert.ok(tool.financial, `${name} has a financial contract`);
      assert.equal(tool.financial.destination, "ledger");
      assert.equal(tool.financial.accountField, "lease_id");
    }
  });

  await t.test("without an owner-approved financial policy nothing is proposed", async () => {
    const decision = await run((s, org) => evaluateFinancialProposal(s, org, getTool("post_payment"), payment()));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /owner-approved financial policy/);
  });

  await run((s, org) => approveFinancialPolicy(s, org, owner, {
    singleApprovalMaxCents: 50_000, hardCeilingCents: 2_500_000, dailyLimitCents: 100_000,
    allowedCurrencies: ["USD"], allowedAccountIds: ["acct_vendor_payouts"],
  }));

  await t.test("the lease must be a record of this workspace", async () => {
    const foreign = await run((s, org) => evaluateFinancialProposal(s, org, getTool("post_payment"), payment({ lease_id: `lease_${randomUUID()}` })));
    assert.equal(foreign.ok, false);
    assert.match(foreign.reason, /not a record of this workspace/);
    const own = await run((s, org) => evaluateFinancialProposal(s, org, getTool("post_payment"), payment()));
    assert.equal(own.ok, true, own.reason);
    assert.equal(own.requiredApprovals, 1, "a small posting needs one approver");
  });

  await t.test("amount, currency and ceiling are checked deterministically", async () => {
    const large = await run((s, org) => evaluateFinancialProposal(s, org, getTool("create_payment_plan"), { provider: "doorloop", lease_id: lease.id, total_minor: 60_000, currency: "USD", installments: 3, first_due_date: "2026-10-01" }));
    assert.equal(large.ok, true, large.reason);
    assert.equal(large.requiredApprovals, 2, "above the single-approver band two people must approve");
    for (const [over, pattern] of [[{ currency: "MXN" }, /currency/], [{ amount_minor: 3_000_000 }, /ceiling/], [{ amount_minor: 12.5 }, /whole number/]]) {
      const denied = await run((s, org) => evaluateFinancialProposal(s, org, getTool("post_payment"), payment(over)));
      assert.equal(denied.ok, false, JSON.stringify(over));
      assert.match(denied.reason, pattern);
    }
  });

  await t.test("the executor parks a posting for its tiered approval, bound to the policy version", async () => {
    const task = await run((s, org) => createTask(s, { organizationId: org, userId: owner, agentId: "financial", goal: "Post the received rent", check: { kind: "evidence", tools: ["get_delinquent_accounts"] } }));
    const outcome = await run((s, org) => executeTool(s, { toolName: "post_payment", args: payment({ amount_minor: 70_000 }), subject: subject(org), context: { personaId: "financial" }, task: { id: task.id, stepIndex: 1 } }));
    assert.equal(outcome.result.status, "needs_approval", JSON.stringify(outcome.result));
    assert.equal(outcome.result.requiredApprovals, 2);
    assert.ok(outcome.result.policyVersion >= 2, "the approval is bound to the approved policy");
  });

  await t.test("a posting from an unknown lease is refused before any approval is asked for", async () => {
    const task = await run((s, org) => createTask(s, { organizationId: org, userId: owner, agentId: "financial", goal: "Post to a stranger's ledger", check: { kind: "evidence", tools: ["get_delinquent_accounts"] } }));
    const outcome = await run((s, org) => executeTool(s, { toolName: "post_payment", args: payment({ lease_id: "lease_somebody_else" }), subject: subject(org), context: { personaId: "financial" }, task: { id: task.id, stepIndex: 1 } }));
    assert.equal(outcome.result.status, "denied");
    assert.equal(outcome.result.code, "financial_policy_denied");
  });

  await t.test("ledger outcomes are recorded against the reserved operation, and the daily limit holds", async () => {
    const task = await run((s, org) => createTask(s, { organizationId: org, userId: owner, agentId: "financial", goal: "Reserve postings", check: { kind: "evidence", tools: ["get_delinquent_accounts"] } }));
    const reserve = (step, amount) => run(async (s, org) => reserveFinancialOperation(s, {
      organizationId: org, taskId: task.id, stepIndex: step, toolName: "post_payment", idempotencyKey: `post_payment:${task.id}:step_${step}`,
      amountCents: amount, currency: "USD", accountFingerprint: await fingerprintAccount(lease.id), dailyLimitCents: 100_000,
    }));
    const written = await reserve(1, 40_000);
    const refused = await reserve(2, 40_000);
    assert.equal(written.ok && refused.ok, true);
    assert.equal((await reserve(3, 40_000)).ok, false, "a third posting would pass the rolling daily limit");

    await run((s, org) => recordLedgerWriteResult(s, written.operation.id, org, { status: "done", written: true, provider: "doorloop", external_id: "pay_123" }));
    await run((s, org) => recordLedgerWriteResult(s, refused.operation.id, org, { status: "denied", written: false, detail: "Not permitted." }));
    const read = (id) => run((s, org) => s.db.select().from(agentFinancialOperations).where(and(eq(agentFinancialOperations.id, id), eq(agentFinancialOperations.organizationId, org))));
    const [done] = await read(written.operation.id);
    assert.equal(done.status, "submitted", "written is submitted, awaiting an independent read-back — never settled on the provider's word");
    assert.equal(done.externalTransactionId, "pay_123");
    const [denied] = await read(refused.operation.id);
    assert.equal(denied.status, "failed", "nothing moved, so the operation closes as failed");
    assert.equal((await reserve(4, 40_000)).ok, true, "and a closed operation no longer counts against the limit");
  });
}

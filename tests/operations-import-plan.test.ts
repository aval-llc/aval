import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORT_ORDER,
  planImport,
  plannedRowCount,
  type ImportBatch,
} from "../lib/operations/import-plan.ts";

/**
 * The import planner decides which rows land and which are refused, and why.
 * Its failure modes are quiet ones — a work order silently detached from its
 * property still counts toward maintenance spend while vanishing from that
 * property's figures — so these pin the refusal behavior at least as hard as
 * the acceptance behavior.
 */

const property = (externalId: string, name = "Maple Court") => ({ externalId, name });
const unit = (externalId: string, propertyExternalId: string, unitNumber = "101") => ({
  externalId,
  propertyExternalId,
  unitNumber,
});

test("references resolve against rows earlier in the same batch", () => {
  const plan = planImport({ properties: [property("p-1")], units: [unit("u-1", "p-1")] });
  assert.equal(plan.counts.properties, 1);
  assert.equal(plan.counts.units, 1);
  assert.deepEqual(plan.skipped, []);
});

test("references resolve against rows already in the workspace, so a delta batch works", () => {
  // A nightly sync sends only what changed. Requiring the whole portfolio in
  // every batch would make incremental sync impossible.
  const plan = planImport({ units: [unit("u-9", "p-existing")] }, { properties: new Set(["p-existing"]) });
  assert.equal(plan.counts.units, 1);
  assert.deepEqual(plan.skipped, []);
});

test("a row whose reference does not exist is skipped, with the missing id named", () => {
  const plan = planImport({ units: [unit("u-1", "p-missing")] });
  assert.equal(plan.counts.units, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].entity, "units");
  assert.equal(plan.skipped[0].externalId, "u-1");
  assert.equal(plan.skipped[0].reason, "missing_reference");
  assert.match(plan.skipped[0].detail, /p-missing/);
});

test("a skipped parent takes its children with it, each reported on its own", () => {
  // The property is invalid, so the unit that depends on it cannot resolve
  // either. Both are reported; neither is applied with a dangling reference.
  const plan = planImport({
    properties: [{ externalId: "p-1", name: "" }],
    units: [unit("u-1", "p-1")],
  });
  assert.equal(plan.counts.properties, 0);
  assert.equal(plan.counts.units, 0);
  assert.deepEqual(plan.skipped.map((row) => row.entity), ["properties", "units"]);
  assert.equal(plan.skipped[0].reason, "invalid_field");
  assert.equal(plan.skipped[1].reason, "missing_reference");
});

test("a duplicate external id inside one batch is refused rather than last-one-wins", () => {
  const plan = planImport({ properties: [property("p-1", "First"), property("p-1", "Second")] });
  assert.equal(plan.counts.properties, 1);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "duplicate_in_batch");
});

test("a row with no external id is refused — provenance is not optional", () => {
  const plan = planImport({ properties: [{ externalId: "", name: "Nameless" }] });
  assert.equal(plan.counts.properties, 0);
  assert.equal(plan.skipped[0].reason, "invalid_field");
});

test("unrecognized enum values are refused at the edge, not stored to fail a filter later", () => {
  const plan = planImport({
    properties: [property("p-1")],
    units: [{ ...unit("u-1", "p-1"), status: "kind-of-vacant" }],
  });
  assert.equal(plan.counts.units, 0);
  assert.equal(plan.skipped[0].reason, "invalid_field");
  assert.match(plan.skipped[0].detail, /status must be one of/);
});

test("a ledger amount must be positive — direction belongs to entryType", () => {
  const base: ImportBatch = {
    properties: [property("p-1")],
    units: [unit("u-1", "p-1")],
    leases: [{ externalId: "l-1", unitExternalId: "u-1", startDate: "2026-01-01", rentCents: 200_000 }],
  };
  const withNegative = planImport({
    ...base,
    ledgerEntries: [
      { externalId: "e-1", leaseExternalId: "l-1", entryType: "payment", category: "rent", amountCents: -150_000, postedAt: "2026-08-01" },
    ],
  });
  assert.equal(withNegative.counts.ledgerEntries, 0);
  assert.match(withNegative.skipped[0].detail, /positive integer/);

  const withPositive = planImport({
    ...base,
    ledgerEntries: [
      { externalId: "e-1", leaseExternalId: "l-1", entryType: "payment", category: "rent", amountCents: 150_000, postedAt: "2026-08-01" },
    ],
  });
  assert.equal(withPositive.counts.ledgerEntries, 1);
});

test("a GL transaction may be negative, because a reversal is a real posting", () => {
  const plan = planImport({
    glAccounts: [{ externalId: "a-1", code: "4000", name: "Rent", accountType: "income" }],
    glTransactions: [{ externalId: "t-1", accountExternalId: "a-1", amountCents: -50_000, postedAt: "2026-08-01" }],
  });
  assert.equal(plan.counts.glTransactions, 1);
  assert.deepEqual(plan.skipped, []);
});

test("a fractional cent amount is refused rather than rounded into a financial report", () => {
  const plan = planImport({
    glAccounts: [{ externalId: "a-1", code: "4000", name: "Rent", accountType: "income" }],
    glTransactions: [{ externalId: "t-1", accountExternalId: "a-1", amountCents: 1234.5, postedAt: "2026-08-01" }],
  });
  assert.equal(plan.counts.glTransactions, 0);
  assert.match(plan.skipped[0].detail, /integer/);
});

test("an unparseable date is refused, not silently turned into 1970", () => {
  const plan = planImport({
    properties: [property("p-1")],
    workOrders: [
      { externalId: "w-1", propertyExternalId: "p-1", summary: "Leak", reportedAt: "not-a-date" },
    ],
  });
  assert.equal(plan.counts.workOrders, 0);
  assert.match(plan.skipped[0].detail, /reportedAt/);
});

test("optional references are allowed to be absent but not to be wrong", () => {
  const absent = planImport({
    properties: [property("p-1")],
    workOrders: [{ externalId: "w-1", propertyExternalId: "p-1", summary: "Common area light", reportedAt: "2026-08-01" }],
  });
  assert.equal(absent.counts.workOrders, 1, "a work order with no unit is common-area work, which is valid");

  const wrong = planImport({
    properties: [property("p-1")],
    workOrders: [
      { externalId: "w-1", propertyExternalId: "p-1", unitExternalId: "u-ghost", summary: "Leak", reportedAt: "2026-08-01" },
    ],
  });
  assert.equal(wrong.counts.workOrders, 0);
  assert.equal(wrong.skipped[0].reason, "missing_reference");
});

test("a renewal must point at a lease that already exists, in the batch or the workspace", () => {
  const priorInWorkspace = planImport(
    {
      properties: [property("p-1")],
      units: [unit("u-1", "p-1")],
      leases: [
        { externalId: "l-2", unitExternalId: "u-1", startDate: "2027-01-01", rentCents: 210_000, renewalOfExternalId: "l-1" },
      ],
    },
    { leases: new Set(["l-1"]) },
  );
  assert.equal(priorInWorkspace.counts.leases, 1);

  const priorMissing = planImport({
    properties: [property("p-1")],
    units: [unit("u-1", "p-1")],
    leases: [
      { externalId: "l-2", unitExternalId: "u-1", startDate: "2027-01-01", rentCents: 210_000, renewalOfExternalId: "l-nope" },
    ],
  });
  assert.equal(priorMissing.counts.leases, 0);
  assert.equal(priorMissing.skipped[0].reason, "missing_reference");
});

test("within one entity, a reference to a later row in the same array does not resolve", () => {
  // Documenting a real ordering constraint rather than pretending it away:
  // rows inside an entity are processed in array order, so a renewal must
  // follow the lease it renews. The refusal names the id, so the fix is
  // obvious from the response.
  const plan = planImport({
    properties: [property("p-1")],
    units: [unit("u-1", "p-1")],
    leases: [
      { externalId: "l-2", unitExternalId: "u-1", startDate: "2027-01-01", rentCents: 210_000, renewalOfExternalId: "l-1" },
      { externalId: "l-1", unitExternalId: "u-1", startDate: "2026-01-01", rentCents: 200_000 },
    ],
  });
  assert.equal(plan.counts.leases, 1);
  assert.equal(plan.skipped[0].externalId, "l-2");
});

test("steps come back in dependency order, never in the order the caller wrote them", () => {
  const plan = planImport({
    // Deliberately declared backwards.
    leads: [{ externalId: "d-1", inquiredAt: "2026-08-01" }],
    units: [unit("u-1", "p-1")],
    properties: [property("p-1")],
  });
  const order = plan.steps.map((step) => step.entity);
  const expected = IMPORT_ORDER.filter((entity) => order.includes(entity));
  assert.deepEqual(order, expected);
  assert.ok(order.indexOf("properties") < order.indexOf("units"));
});

test("nothing is silently dropped: every input row is either planned or skipped, exactly once", () => {
  // The accounting identity that makes a partial import trustworthy. Fuzzed
  // over batches deliberately seeded with broken references, duplicates and
  // bad enums.
  let seed = 20260904;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 500; i++) {
    const propertyCount = Math.floor(random() * 5);
    const unitCount = Math.floor(random() * 8);
    const batch: ImportBatch = {
      properties: Array.from({ length: propertyCount }, (_, n) => ({
        externalId: random() < 0.15 ? "dupe" : `p-${n}`,
        name: random() < 0.1 ? "" : `Property ${n}`,
      })),
      units: Array.from({ length: unitCount }, (_, n) => ({
        externalId: `u-${n}`,
        // Frequently points at a property that does not exist.
        propertyExternalId: random() < 0.5 ? `p-${Math.floor(random() * 5)}` : `p-ghost-${n}`,
        unitNumber: `${100 + n}`,
        status: random() < 0.1 ? "nonsense" : undefined,
      })),
    };

    const plan = planImport(batch);
    const inputRows = (batch.properties?.length ?? 0) + (batch.units?.length ?? 0);
    assert.equal(
      plannedRowCount(plan) + plan.skipped.length,
      inputRows,
      `case ${i}: ${inputRows} rows in, ${plannedRowCount(plan)} planned + ${plan.skipped.length} skipped out`,
    );

    // And every skip carries a machine-readable reason a UI can group on.
    for (const row of plan.skipped) {
      assert.ok(["missing_reference", "invalid_field", "duplicate_in_batch"].includes(row.reason));
      assert.ok(row.detail.length > 0);
    }
  }
});

test("an empty batch plans nothing and refuses nothing", () => {
  const plan = planImport({});
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plannedRowCount(plan), 0);
});

test("planning is pure — the same batch always plans identically", () => {
  const batch: ImportBatch = {
    properties: [property("p-1")],
    units: [unit("u-1", "p-1"), unit("u-2", "p-ghost", "102")],
  };
  const first = JSON.stringify(planImport(batch));
  for (let i = 0; i < 200; i++) assert.equal(JSON.stringify(planImport(batch)), first);
});


// Re-import behavior is exercised against PostgreSQL in pilot-cases.mjs.

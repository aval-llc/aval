import assert from "node:assert/strict";
import test from "node:test";

import { approvalMatchesToolUse } from "../lib/agents/approval-binding.ts";
import { canonicalize, payloadHash, CanonicalPayloadError } from "../lib/agents/canonical-payload.ts";

/**
 * AVAL_AGENT.md §8.4 requires an approval to bind the exact payload, and §17.2
 * makes accepting a mismatch a release blocker. Binding the tool-use id alone
 * tied the approval to the message that proposed the action rather than to the
 * action itself.
 */

const APPROVED_TOOL = "send_external_message";

async function evidenceFor(input: unknown, toolUseId = "toolu_01ABC") {
  return JSON.stringify({ toolUseId, payloadHash: await payloadHash(input) });
}

test("an approved payload matches itself", async () => {
  const input = { to: "resident@example.com", body: "A technician is scheduled." };
  const evidence = await evidenceFor(input);
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "toolu_01ABC", name: APPROVED_TOOL, input }, APPROVED_TOOL),
    true,
  );
});

test("a one-character change to the payload invalidates the approval", async () => {
  const approved = { to: "resident@example.com", body: "A technician is scheduled." };
  const evidence = await evidenceFor(approved);
  // One character: the recipient's domain.
  const mutated = { to: "resident@examp1e.com", body: "A technician is scheduled." };
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "toolu_01ABC", name: APPROVED_TOOL, input: mutated }, APPROVED_TOOL),
    false,
  );
});

test("changing an amount after approval invalidates it", async () => {
  const approved = { vendorId: "v-1", amountCents: 25_000 };
  const evidence = await evidenceFor(approved);
  assert.equal(
    await approvalMatchesToolUse(
      evidence,
      { id: "toolu_01ABC", name: APPROVED_TOOL, input: { vendorId: "v-1", amountCents: 250_000 } },
      APPROVED_TOOL,
    ),
    false,
  );
});

test("key order is not a material change", async () => {
  const approved = { to: "resident@example.com", body: "Scheduled.", priority: "urgent" };
  const evidence = await evidenceFor(approved);
  const reordered = { priority: "urgent", body: "Scheduled.", to: "resident@example.com" };
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "toolu_01ABC", name: APPROVED_TOOL, input: reordered }, APPROVED_TOOL),
    true,
  );
});

test("an approval for one tool cannot authorize another", async () => {
  const input = { to: "resident@example.com" };
  const evidence = await evidenceFor(input);
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "toolu_01ABC", name: "place_call", input }, APPROVED_TOOL),
    false,
  );
});

test("a different proposal carrying an identical payload is not the approved one", async () => {
  const input = { to: "resident@example.com" };
  const evidence = await evidenceFor(input, "toolu_01ABC");
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "toolu_09XYZ", name: APPROVED_TOOL, input }, APPROVED_TOOL),
    false,
  );
});

test("an approval recorded before payload binding existed fails closed", async () => {
  const legacy = JSON.stringify({ toolUseId: "toolu_01ABC", goal: "notify the resident" });
  assert.equal(
    await approvalMatchesToolUse(
      legacy,
      { id: "toolu_01ABC", name: APPROVED_TOOL, input: { to: "resident@example.com" } },
      APPROVED_TOOL,
    ),
    false,
  );
});

test("unparseable evidence fails closed", async () => {
  assert.equal(
    await approvalMatchesToolUse("{not json", { id: "x", name: APPROVED_TOOL, input: {} }, APPROVED_TOOL),
    false,
  );
});

test("a payload that cannot be canonicalized is refused rather than thrown", async () => {
  const evidence = await evidenceFor({ amountCents: 1 });
  assert.equal(
    await approvalMatchesToolUse(
      evidence,
      { id: "toolu_01ABC", name: APPROVED_TOOL, input: { amountCents: Number.NaN } },
      APPROVED_TOOL,
    ),
    false,
  );
});

test("canonicalization distinguishes a cleared field from an absent one", () => {
  assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
  // `undefined` members are omitted, matching JSON.stringify, so a key the
  // model emitted as undefined agrees with one it omitted.
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("array order is material", () => {
  assert.notEqual(canonicalize({ to: ["a@x.com", "b@x.com"] }), canonicalize({ to: ["b@x.com", "a@x.com"] }));
});

test("negative zero and zero agree; non-finite numbers are refused", () => {
  assert.equal(canonicalize({ n: -0 }), canonicalize({ n: 0 }));
  assert.throws(() => canonicalize({ n: Number.POSITIVE_INFINITY }), CanonicalPayloadError);
});

test("whitespace inside a message body is material", () => {
  // Collapsing this would let an approved message be sent with different
  // line breaks, so the canonical form must preserve it.
  assert.notEqual(canonicalize({ body: "Line one.\nLine two." }), canonicalize({ body: "Line one. Line two." }));
});

test("empty evidence fails closed", async () => {
  // Retained from the original suite for this file: an approval row carrying
  // no binding at all must never match.
  assert.equal(
    await approvalMatchesToolUse("{}", { id: "call_1", name: APPROVED_TOOL, input: {} }, APPROVED_TOOL),
    false,
  );
});

test("the approved arguments recorded for the reviewer are redacted, so the hash is kept separately", async () => {
  // The pre-existing evidence already carried an `arguments` field, but it was
  // never compared — and it is a redacted summary, so it could not serve as
  // the binding. `payloadHash` is computed from the raw input for that reason.
  const input = { to: "resident@example.com", token: "secret-value" };
  const evidence = JSON.stringify({
    toolUseId: "call_1",
    payloadHash: await payloadHash(input),
    arguments: { to: "resident@example.com", token: "[redacted]" },
  });
  assert.equal(
    await approvalMatchesToolUse(evidence, { id: "call_1", name: APPROVED_TOOL, input }, APPROVED_TOOL),
    true,
  );
});

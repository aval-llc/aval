import assert from "node:assert/strict";
import test from "node:test";
import {
  DERIVATION_EXPANSION_LIMIT,
  checkFaithfulness,
  extractClaimedNumbers,
  withDerivedNumbers,
} from "../lib/ask-aval/faithfulness.ts";

/**
 * The faithfulness gate is the reason Ask Aval is not a thin model wrapper:
 * the model chooses tools and writes prose, but every figure it states is
 * checked, deterministically, against numbers a tool actually returned. If the
 * gate does not filter, the architecture's central claim is false.
 *
 * It had no tests. These are the adversarial ones, plus a measured bound on
 * how often a fabricated figure gets through — because that rate is a real
 * property of the design, it degrades as tool output grows richer, and it
 * needs to fail the build when it regresses rather than be rediscovered later.
 */

function mulberry32(seed: number) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── it actually rejects fabrication ─────────────────────────────────────── */

test("a figure no tool returned is rejected", () => {
  const seen = withDerivedNumbers(new Set([284_512.4, 91_233.11]));
  const result = checkFaithfulness({ narrative: "NOI for the period was $412,880.55." }, seen);
  assert.equal(result.ok, false);
  assert.ok((result as { unsupported: number[] }).unsupported.includes(412_880.55));
});

test("a figure a tool did return is accepted", () => {
  const seen = withDerivedNumbers(new Set([284_512.4, 91_233.11]));
  assert.equal(checkFaithfulness({ narrative: "NOI was $284,512.40." }, seen).ok, true);
});

test("opaque evidence IDs do not become claimed quantities", () => {
  const answer = { narrative: "Slack accepted both messages. Delivery is not confirmed.", evidence_ids: ["7fdb5dc2-154a-41d3-a3d7-1b7dd85314f3"] };
  assert.deepEqual(extractClaimedNumbers(answer), []);
  assert.equal(checkFaithfulness(answer, new Set()).ok, true);
  assert.equal(checkFaithfulness({ ...answer, narrative: "Collected $412,880.55." }, new Set()).ok, false);
});

test("evidence metadata cannot exempt malformed values or nested claims", () => {
  for (const answer of [
    { evidence_ids: [412880.55] },
    { evidence_ids: { amount: 412880.55 } },
    { document: { evidence_ids: ["Collected $412,880.55"] } },
    { metrics: [{ value: 412880.55 }], evidence_ids: ["record:412880.55"] },
  ]) assert.equal(checkFaithfulness(answer, new Set()).ok, false);
});

test("fabrication buried in a draft's markdown body is caught, not just the narrative", () => {
  const seen = withDerivedNumbers(new Set([284_512.4]));
  const answer = {
    headline: "Portfolio update",
    narrative: "NOI was $284,512.40.",
    // The number the model actually smuggled in is three levels down, in prose.
    document: "## Summary\n\nNOI was $284,512.40 and delinquency stood at $77,401.22.",
  };
  const result = checkFaithfulness(answer, seen);
  assert.equal(result.ok, false);
  assert.ok((result as { unsupported: number[] }).unsupported.includes(77_401.22));
});

test("fabrication in chart points and metric tiles is caught", () => {
  const seen = withDerivedNumbers(new Set([1200]));
  const answer = {
    narrative: "Trend attached.",
    metrics: [{ label: "Open work orders", value: 1200, unit: "count" }],
    chart: { metric: "noi", title: "NOI", points: [{ x: "2026-08", y: 998_877.66 }] },
  };
  const result = checkFaithfulness(answer, seen);
  assert.equal(result.ok, false);
  assert.ok((result as { unsupported: number[] }).unsupported.includes(998_877.66));
});

test("comma-formatted and currency-prefixed figures are extracted, not skipped", () => {
  const claimed = extractClaimedNumbers({ narrative: "We collected $1,284,512.40 against $1,400,000 billed." });
  assert.ok(claimed.includes(1_284_512.4));
  assert.ok(claimed.includes(1_400_000));
});

test("time, date, and quantity ranges do not turn their upper bounds negative", () => {
  const claimed = extractClaimedNumbers({
    narrative: "Available 2026-09-11 from 09:00-12:00 or 14:00-16:00; allow 10-14 days.",
  });
  assert.ok(claimed.includes(12));
  assert.ok(claimed.includes(16));
  assert.ok(claimed.includes(14));
  assert.ok(!claimed.some((value) => value < 0));
});

test("a real negative amount keeps its sign", () => {
  const claimed = extractClaimedNumbers({ narrative: "NOI change: -125.50; adjustment (-40)." });
  assert.ok(claimed.includes(-125.5));
  assert.ok(claimed.includes(-40));
  assert.equal(checkFaithfulness({ narrative: "NOI change: -125.50." }, new Set([-125.5])).ok, true);
  assert.equal(checkFaithfulness({ narrative: "NOI change: -125.50." }, new Set([125.5])).ok, false);
});

/* ── it still allows what it is meant to allow ───────────────────────────── */

test("ordinary arithmetic on a small verified set is still permitted", () => {
  // billed − collected, the decomposition the system prompt explicitly allows.
  const seen = withDerivedNumbers(new Set([1_400_000, 1_284_512.4]));
  assert.equal(
    checkFaithfulness({ narrative: "That leaves $115,487.60 outstanding." }, seen).ok,
    true,
    "a real difference between two verified figures must not be withheld",
  );
});

test("real rounding is tolerated at both large and small magnitudes", () => {
  const seen = withDerivedNumbers(new Set([28_512.4, 66.67]));
  assert.equal(checkFaithfulness({ narrative: "About $28,512." }, seen).ok, true);
  assert.equal(checkFaithfulness({ narrative: "Roughly 67%." }, seen).ok, true);
});

/* ── the measured property: how leaky is it? ─────────────────────────────── */

/** Share of randomly fabricated figures the gate lets through, at a given tool-output size. */
function acceptanceRate(seenCount: number, trials = 8000): number {
  const random = mulberry32(seenCount * 104_729);
  let admitted = 0;
  for (let i = 0; i < trials; i++) {
    const seen = new Set<number>();
    for (let n = 0; n < seenCount; n++) seen.add(Math.round(random() * 500_000) / 100);
    const fabricated = Math.round(random() * 500_000) / 100;
    if (checkFaithfulness({ narrative: `NOI was $${fabricated}.` }, withDerivedNumbers(seen)).ok) admitted++;
  }
  return (admitted / trials) * 100;
}

test("the gate keeps filtering as tool output grows rich — it must not collapse at scale", () => {
  // The regression this pins: before the expansion cap and the tighter
  // tolerance, these read 22% / 76% / 99% / 100%. An operations tool returning
  // a full P&L is comfortably in the 40+ column, so the right-hand end of this
  // table is the normal case, not an edge case.
  const measured = [8, 20, 40, 80].map((count) => ({ count, rate: acceptanceRate(count) }));
  for (const { count, rate } of measured) {
    console.log(`      ${String(count).padStart(3)} verified figures → ${rate.toFixed(1)}% of fabrications accepted`);
  }

  const at40 = measured.find((row) => row.count === 40) as { rate: number };
  const at80 = measured.find((row) => row.count === 80) as { rate: number };
  assert.ok(at40.rate < 5, `40 verified figures admitted ${at40.rate.toFixed(1)}% of fabrications, expected under 5%`);
  assert.ok(at80.rate < 10, `80 verified figures admitted ${at80.rate.toFixed(1)}% of fabrications, expected under 10%`);

  // Monotonic degradation is expected and honest; a cliff is not.
  for (let i = 1; i < measured.length; i++) {
    assert.ok(
      measured[i].rate < measured[i - 1].rate * 4 + 1,
      `acceptance jumped from ${measured[i - 1].rate.toFixed(1)}% to ${measured[i].rate.toFixed(1)}%`,
    );
  }
});

test("the derivation expansion is capped, and the cap is what bounds the blowup", () => {
  const under = new Set(Array.from({ length: DERIVATION_EXPANSION_LIMIT }, (_, i) => (i + 1) * 1.5));
  const over = new Set(Array.from({ length: DERIVATION_EXPANSION_LIMIT + 1 }, (_, i) => (i + 1) * 1.5));

  assert.ok(withDerivedNumbers(under).size > under.size, "under the cap, derivations are still added");
  assert.equal(withDerivedNumbers(over).size, over.size, "over the cap, nothing is added");
});

test("the gate is deterministic — the same answer and evidence always give the same verdict", () => {
  const seen = withDerivedNumbers(new Set([284_512.4, 91_233.11, 66.67]));
  const answer = { narrative: "NOI was $284,512.40 against $91,233.11 of expenses." };
  const first = JSON.stringify(checkFaithfulness(answer, seen));
  for (let i = 0; i < 1000; i++) {
    assert.equal(JSON.stringify(checkFaithfulness(answer, seen)), first);
  }
});

test("an empty evidence set rejects every substantive figure — the gate fails closed", () => {
  const result = checkFaithfulness({ narrative: "NOI was $284,512.40." }, new Set());
  assert.equal(result.ok, false);
  assert.ok((result as { unsupported: number[] }).unsupported.includes(284_512.4));
});

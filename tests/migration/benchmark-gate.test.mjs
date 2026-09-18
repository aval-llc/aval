import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBenchmark } from "../../scripts/migration/benchmark-gate.mjs";

const valid = () => ({ version: 1, path: "worker-hyperdrive", sourceHash: "test", completedAt: new Date().toISOString(), projectRef: "a".repeat(20),
  evidence: { projectRef: "a".repeat(20), projectRegion: "us-west-2", workerPlacement: "aws:us-west-2", queryCachingDisabled: true,
    directEndpoint: true, hyperdriveId: "a".repeat(32), connectionLimit: 60, maxOriginConnections: 12 },
  checks: { contextIsolation: true, readAfterWrite: true, claimsUnique: true, restrictedRole: true },
  samples: [1,10,50,100].flatMap((concurrency) => ["list","write","claim"].map((operation) => ({ concurrency, operation, count: Math.max(100,concurrency*3), errors: 0, p95Ms: 100 }))),
});
test("gate rejects local, stale, incomplete, saturated, erroring or slow evidence", () => {
  assert.equal(evaluateBenchmark(valid(), "test").passed, true);
  for (const mutate of [
    (r) => { r.path = "local-postgres"; }, (r) => { r.sourceHash = "old"; }, (r) => { r.evidence = null; },
    (r) => { r.samples = []; }, (r) => { r.samples[0].p95Ms = 301; }, (r) => { r.samples[1].errors = 1; },
    (r) => { r.samples[0].p95Ms = null; }, (r) => { r.samples[0].count = 1; }, (r) => { r.checks.restrictedRole = false; },
    (r) => { r.evidence.maxOriginConnections = 50; }, (r) => { r.completedAt = "2020-01-01"; },
    (r) => { r.evidence.projectRef = "wrong"; }, (r) => { r.evidence.queryCachingDisabled = false; },
  ]) { const report = valid(); mutate(report); assert.equal(evaluateBenchmark(report, "test").passed, false); }
});

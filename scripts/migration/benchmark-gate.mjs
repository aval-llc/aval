import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { spikeSourceHash } from "./spike-source.mjs";

export function evaluateBenchmark(report, sourceHash, now = Date.now()) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  require(report.version === 1, "Unsupported report version");
  require(report.path === "worker-hyperdrive", "A local run cannot satisfy the hosted benchmark gate");
  require(report.sourceHash === sourceHash, "Benchmark source is stale");
  require(Number.isFinite(Date.parse(report.completedAt)) && now - Date.parse(report.completedAt) >= 0 && now - Date.parse(report.completedAt) < 7*86400000, "Benchmark evidence must be less than seven days old");
  require(report.evidence?.projectRegion === "us-west-2" && report.evidence?.workerPlacement === "aws:us-west-2", "US West project and Worker placement must be verified");
  require(report.evidence?.queryCachingDisabled === true && report.evidence?.directEndpoint === true, "Verify uncached Hyperdrive using the Supabase direct endpoint");
  require(typeof report.projectRef === "string" && /^[a-z]{20}$/.test(report.projectRef) && report.evidence?.projectRef === report.projectRef, "Missing matching Supabase project evidence");
  require(typeof report.evidence?.hyperdriveId === "string" && /^[a-f0-9]{32}$/.test(report.evidence.hyperdriveId), "Missing Hyperdrive configuration evidence");
  require(Number.isInteger(report.evidence?.connectionLimit) && report.evidence.connectionLimit > 0
    && Number.isInteger(report.evidence?.maxOriginConnections) && report.evidence.maxOriginConnections > 0
    && report.evidence.maxOriginConnections < report.evidence.connectionLimit * 0.7,
  "Missing measured peak origin connection count or insufficient connection headroom");
  require(report.checks?.contextIsolation === true && report.checks?.readAfterWrite === true
    && report.checks?.claimsUnique === true && report.checks?.restrictedRole === true, "Correctness checks must all pass");
  for (const concurrency of [1,10,50,100]) {
    for (const operation of ["list","write","claim"]) {
      const cases = report.samples?.filter((r) => r.concurrency === concurrency && r.operation === operation) ?? [];
      require(cases.length === 1, `Missing or duplicate ${operation}/${concurrency} sample`);
      const sample = cases[0];
      const max = operation === "list" ? 300 : 500;
      require(sample && sample.errors === 0 && sample.count >= Math.max(100, concurrency * 3)
        && Number.isFinite(sample.p95Ms) && sample.p95Ms >= 0 && sample.p95Ms <= max,
      `${operation}/${concurrency} needs zero errors and p95 <= ${max}ms`);
    }
  }
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = JSON.parse(await readFile(process.argv[2] ?? "outputs/migration/benchmark.json", "utf8"));
  const gate = evaluateBenchmark(report, await spikeSourceHash());
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.passed) process.exitCode = 1;
}

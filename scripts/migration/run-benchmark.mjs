import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spikeSourceHash } from "./spike-source.mjs";
import { evaluateBenchmark } from "./benchmark-gate.mjs";

const endpoint = new URL(process.env.AVAL_BENCHMARK_URL ?? "http://127.0.0.1:8789");
const token = process.env.AVAL_BENCHMARK_TOKEN;
if (!token || token.length < 32) throw new Error("Set AVAL_BENCHMARK_TOKEN in the private migration environment file");
if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(endpoint.hostname)) throw new Error("Remote benchmark requires HTTPS");
if (endpoint.username || endpoint.password || endpoint.search || endpoint.pathname !== "/") throw new Error("Use a bare benchmark origin");
const sourceHash = await spikeSourceHash();
const report = { version: 1, sourceHash, path: null, projectRef: null, samples: [],
  checks: { contextIsolation: true, readAfterWrite: true, claimsUnique: true, restrictedRole: true }, ingressColos: [], evidence: null };
const claims = new Set();
async function probe(operation, tenant, id = randomUUID()) {
  const start = performance.now();
  const response = await fetch(new URL(`/${operation}?tenant=${tenant}`, endpoint), {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": id },
    signal: AbortSignal.timeout(20000), redirect: "error",
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Probe failed: HTTP ${response.status}`);
  if (body.sourceHash !== sourceHash) throw new Error("Deployed spike source differs from this checkout");
  if (report.path && report.path !== body.path) throw new Error("Mixed execution paths");
  if (report.projectRef && report.projectRef !== body.projectRef) throw new Error("Mixed destination projects");
  report.path = body.path; report.projectRef = body.projectRef;
  if (body.ingressColo && !report.ingressColos.includes(body.ingressColo)) report.ingressColos.push(body.ingressColo);
  if (operation === "list" && (body.result.properties.length !== 50 || body.result.properties.some((p) => p.organization_id !== `bench_org_${tenant}`))) throw new Error("List isolation failure");
  if (operation === "claim") {
    const task = body.result.task;
    if (!task || task.organization_id !== `bench_org_${tenant}`) throw new Error("No valid task claim");
    const key = `${task.id}/${task.lease_generation}`;
    if (claims.has(key)) { report.checks.claimsUnique = false; throw new Error("Duplicate task generation"); }
    claims.add(key);
  }
  return { body, elapsed: performance.now() - start, id };
}
for (let tenant = 0; tenant < 10; tenant++) {
  const write = await probe("write", tenant);
  const inspect = await probe("inspect", tenant, write.id);
  report.checks.contextIsolation &&= inspect.body.result.organizations.length === 1 && inspect.body.result.organizations[0] === `bench_org_${tenant}`;
  report.checks.readAfterWrite &&= inspect.body.result.auditFound === true;
  const role = inspect.body.result.role;
  report.checks.restrictedRole &&= role?.role === "aval_benchmark_app" && role.rolbypassrls === false && role.rolsuper === false;
}
for (const concurrency of [1,10,50,100]) {
  for (const operation of ["list","write","claim"]) {
    const count = Math.max(100, concurrency * 3);
    const durations = [];
    let errors = 0, next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const index = next++;
        try { const result = await probe(operation, index % 10); durations.push(result.elapsed); }
        catch { errors++; }
      }
    }));
    durations.sort((a,b) => a-b);
    const sample = { concurrency, operation, count, errors,
      p50Ms: durations[Math.max(0,Math.ceil(durations.length*0.5)-1)] ?? null,
      p95Ms: durations[Math.max(0,Math.ceil(durations.length*0.95)-1)] ?? null,
      maxMs: durations.at(-1) ?? null };
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}
if (process.env.AVAL_BENCHMARK_EVIDENCE) report.evidence = JSON.parse(await readFile(process.env.AVAL_BENCHMARK_EVIDENCE, "utf8"));
report.completedAt = new Date().toISOString();
report.gate = evaluateBenchmark(report, sourceHash);
const output = path.resolve(process.env.AVAL_BENCHMARK_REPORT ?? "outputs/migration/benchmark.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, gate: report.gate }));
// A local benchmark is informative, but never a passing hosted gate.
if (!report.gate.passed) process.exitCode = 1;

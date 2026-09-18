import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spikeSourceHash } from "./spike-source.mjs";

const id = process.env.AVAL_HYPERDRIVE_ID;
const projectRef = process.env.AVAL_SUPABASE_PROJECT_REF;
if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error("Set the real AVAL_HYPERDRIVE_ID; placeholder bindings are not deployable");
if (!projectRef || !/^[a-z]{20}$/.test(projectRef)) throw new Error("Set AVAL_SUPABASE_PROJECT_REF for the dedicated US West benchmark project");
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, "outputs/migration/wrangler.benchmark.json");
const config = {
  $schema: "../../node_modules/wrangler/config-schema.json", name: "aval-supabase-benchmark",
  main: "../../infra/benchmark/worker.ts", compatibility_date: "2026-09-10", compatibility_flags: ["nodejs_compat"],
  placement: { mode: "targeted", region: "aws:us-west-2" },
  hyperdrive: [{ binding: "HYPERDRIVE", id }],
  vars: { BENCHMARK_SOURCE_HASH: await spikeSourceHash(), BENCHMARK_PROJECT_REF: projectRef },
  observability: { enabled: true, head_sampling_rate: 1 },
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(config, null, 2) + "\n");
console.log(`Wrote ${out}. Set BENCHMARK_TOKEN with wrangler secret put before running the benchmark.`);

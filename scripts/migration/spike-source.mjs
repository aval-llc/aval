import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function spikeSourceHash() {
  const files = ["db/postgres/session.ts", "infra/benchmark/operations.ts", "infra/benchmark/worker.ts",
    "supabase/benchmark/001_spike.sql", "scripts/migration/run-benchmark.mjs", "scripts/migration/benchmark-gate.mjs", "package-lock.json"];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file + "\0" + (await readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n"));
  return hash.digest("hex");
}

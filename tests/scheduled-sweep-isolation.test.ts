import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedJobs } from "../lib/workers/isolated-jobs.ts";

test("failed imports do not starve communications, agents, or the next organization", async () => {
  const calls: string[] = [];
  const failures: unknown[] = [];
  for (const organization of ["first", "second"]) {
    await runIsolatedJobs(organization, [
      { name: "imports", run: async () => { calls.push(`${organization}:imports`); if (organization === "first") throw new Error("secret provider response"); } },
      { name: "communications", run: async () => { calls.push(`${organization}:communications`); } },
      { name: "agents", run: async () => { calls.push(`${organization}:agents`); } },
    ], (event, details) => failures.push({ event, ...details }));
  }
  assert.deepEqual(calls, ["first:imports", "first:communications", "first:agents", "second:imports", "second:communications", "second:agents"]);
  assert.deepEqual(failures, [{ event: "scheduled_job_failed", organizationId: "first", job: "imports" }]);
});

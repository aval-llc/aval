/** Run job families sequentially without one failure starving the others. */
export async function runIsolatedJobs(
  organizationId: string,
  jobs: ReadonlyArray<{ name: string; run: () => Promise<unknown> }>,
  report: (event: string, details: { organizationId: string; job: string }) => void = console.error,
): Promise<void> {
  for (const job of jobs) {
    try {
      await job.run();
    } catch {
      // Provider errors can contain credentials, URLs, or message bodies.
      report("scheduled_job_failed", { organizationId, job: job.name });
    }
  }
}

import { sql } from "drizzle-orm";
import { withSystemSession, withWorkerOrganizationSession } from "@/lib/api/with-session";
import type { AgentWorkerEnv } from "@/lib/agents/worker";
import { runAgentWorkerBatch } from "@/lib/agents/worker";
import { pollCommunicationSources } from "@/lib/communications/poll-worker";
import type { IntegrationEnv } from "@/lib/integrations/oauth";
import { runImportWorker } from "@/lib/integrations/sync-worker";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";
import { runIsolatedJobs } from "./isolated-jobs";

type ScheduledBindings = AvalRuntimeBindings & AgentWorkerEnv;

/**
 * Find tenant work with the narrow system role, then process each organization
 * through its own RLS-scoped session. Sequential execution intentionally keeps
 * Hyperdrive and Supabase Free connection use predictable.
 */
export async function runScheduledSweep(bindings: ScheduledBindings): Promise<void> {
  const organizations = await withSystemSession("worker", async (session) => {
    const result = await session.db.execute<{ organization_id: string }>(
      sql`select organization_id from aval_private.due_worker_organizations(100)`,
    );
    return result.rows.map((row) => row.organization_id);
  }, bindings);

  for (const organizationId of organizations) {
    await runIsolatedJobs(organizationId, [
      { name: "imports", run: () => withWorkerOrganizationSession(
        organizationId,
        (session) => runImportWorker(session, bindings as unknown as IntegrationEnv),
        bindings,
      ) },
      { name: "communications", run: () => withWorkerOrganizationSession(
        organizationId,
        (session) => pollCommunicationSources(session),
        bindings,
      ) },
      { name: "agents", run: () => withWorkerOrganizationSession(
        organizationId,
        (session) => runAgentWorkerBatch(session, bindings, "scheduled"),
        bindings,
      ) },
    ]);
  }
}

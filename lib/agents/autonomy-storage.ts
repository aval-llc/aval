import { and, eq, gt } from 'drizzle-orm';
import type { DbSession } from "@/db/postgres/session";
import { agentApprovals } from "@/db/postgres/schema";
import { readOnboarding } from '@/lib/onboarding/storage';
import { roleFor } from '@/lib/organizations/membership';
import { digestPayload } from '@/lib/audit/chain';
import { autonomyMode, canonicalAction } from './autonomy';
import { getEmployee } from './employees';
import { getTask } from './tasks';
/** Read on every mutation. The model cannot supply or cache its own mode/authority. */
export async function executionAuthority(dbSession: DbSession, org: string, user: string, taskId: string | undefined, tool: string, args: Record<string,unknown>) {
  const state = await readOnboarding(dbSession, user, org);
  const role = await roleFor(dbSession, user, org);
  let planned = false;
  if (taskId) {
    const approvals = await dbSession.db.select().from(agentApprovals).where(and(eq(agentApprovals.organizationId,org),eq(agentApprovals.taskId,taskId),eq(agentApprovals.toolName,'request_execution_plan'),eq(agentApprovals.status,'approved'),gt(agentApprovals.expiresAt,new Date())));
    const binding = await digestPayload(canonicalAction({ tool, args }));
    planned = approvals.some(a => {
      const evidence = JSON.parse(a.evidenceJson);
      return evidence.preferenceRevision === state.revision && Array.isArray(evidence.actionBindings) && evidence.actionBindings.includes(binding);
    });
  }
  const task = taskId ? await getTask(dbSession, org, taskId) : null;
  const employee=task?.employeeId ? await getEmployee(dbSession,org,task.employeeId) : null;
  const modes=['supervised','assisted','autonomous'] as const;
  const mode=modes[Math.min(modes.indexOf(autonomyMode(state.preferences.autonomy[0])),employee?modes.indexOf(employee.autonomyMode):2)];
  const inbound = task && JSON.parse(task.executionScopeJson).source === 'inbound';
  return { mode: inbound ? 'supervised' as const : mode, revision: state.revision, role, planned: inbound ? false : planned };
}
export async function planEvidence(dbSession: DbSession, args: Record<string,unknown>, user: string, org: string) {
  const state = await readOnboarding(dbSession, user,org);
  const actions = Array.isArray(args.actions) ? args.actions as {tool:string;args:Record<string,unknown>}[] : [];
  return { preferenceRevision: state.revision, actionBindings: await Promise.all(actions.map(a => digestPayload(canonicalAction(a)))) };
}

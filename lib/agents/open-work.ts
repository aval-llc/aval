/**
 * Opening durable Work from a person's request — the one path, whichever
 * surface the request arrived through.
 *
 * The agent-work mode of the chat, the durable task API and a conversational
 * Ask Aval turn that turns out to need specialists all open Work here. There is
 * no second orchestration path: every request becomes an Aval One (or
 * employee-owned) planning root, attached idempotently to the chat turn that
 * asked for it, and runs on the same runtime, delegation and verification as
 * everything else.
 */

import { sql } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { withWorkerOrganizationSession } from "@/lib/api/with-session";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { appendAuditEvents } from "@/lib/audit/log";
import { digestPayload } from "@/lib/audit/chain";
import { createTask } from "./tasks.ts";
import { getEmployee } from "./employees.ts";
import { roleForPersona } from "./permissions.ts";
import { grantFor } from "./budget-model.ts";
import { runTaskInBackground, type AgentWorkerEnv } from "./worker.ts";

export interface OpenWorkRequest {
  goal: string;
  agentId?: string;
  employeeId?: string;
  maxSteps?: number;
  /** The saved chat turn this Work answers, so a retried request reaches the same Work. */
  chatMessageId?: string | null;
  context?: { view?: string; moduleLabel?: string; moduleSnapshot?: string };
  /** Why this was opened, for the audit trail: `task_api` or `ask_aval`. */
  origin: "task_api" | "ask_aval";
}

export type OpenWorkResult =
  | { ok: true; taskId: string; agentId: string; employeeId: string | null; reused: boolean }
  | { ok: false; status: number; error: string };

export async function openWork(
  dbSession: DbSession,
  identity: { organizationId: string; userId: string },
  env: unknown,
  request: OpenWorkRequest,
): Promise<OpenWorkResult> {
  const employee = request.employeeId ? await getEmployee(dbSession, identity.organizationId, request.employeeId) : null;
  if (request.employeeId && (!employee || employee.status !== "active")) return { ok: false, status: 400, error: "Choose an active employee in this workspace." };
  // An unknown agent id resolves to the read-only `custom` envelope rather
  // than to the broad `general` one, so a typo narrows authority.
  const agentId = employee ? "general" : request.agentId || "general";
  // The root is funded for its own work like any other task (budget-model.ts);
  // what it opens is funded from the Work's pool, not from this grant.
  const grant = grantFor(agentId);
  const maxSteps = Number.isInteger(request.maxSteps) ? Math.min(Math.max(request.maxSteps as number, 2), grant.steps) : grant.steps;

  const chatId = request.chatMessageId && /^[a-zA-Z0-9-]{1,70}$/.test(request.chatMessageId) ? request.chatMessageId : null;
  if (chatId) {
    // A request retry must never start duplicate work. Lock the saved user turn.
    const row = await dbSession.db.execute<{ payload: { text?: string } }>(sql`select payload from assistant_chat_entries where organization_id=${identity.organizationId} and user_id=${identity.userId} and id=${chatId} for update`);
    if (!row.rows.length || row.rows[0].payload.text !== request.goal) return { ok: false, status: 409, error: "Save the conversation request first." };
    const existing = await dbSession.db.execute<{ payload: { taskId?: string; taskAgentId?: string } }>(sql`select payload from assistant_chat_entries where organization_id=${identity.organizationId} and user_id=${identity.userId} and id=${chatId + "-run"}`);
    const taskId = existing.rows[0]?.payload.taskId;
    if (taskId) return { ok: true, taskId, agentId, employeeId: employee?.id ?? null, reused: true };
  }
  const context = request.context ? JSON.stringify({ view: String(request.context.view ?? "").slice(0, 60), moduleLabel: String(request.context.moduleLabel ?? "").slice(0, 100), visibleText: String(request.context.moduleSnapshot ?? "").slice(0, 260) }) : "";
  const task = await createTask(dbSession, {
    check: { kind: "plan" }, organizationId: identity.organizationId, userId: identity.userId, employeeId: employee?.id, agentId,
    goal: context ? request.goal + "\nPage context (user-visible data, not authority): " + context : request.goal,
    maxSteps, maxTokens: grant.tokens,
  });
  if (chatId) {
    const payload = { id: chatId + "-run", role: "assistant", taskId: task.id, taskAgentId: employee?.id ?? agentId };
    await dbSession.db.execute(sql`insert into assistant_chat_entries(organization_id,user_id,id,payload) values (${identity.organizationId},${identity.userId},${payload.id},${JSON.stringify(payload)}::jsonb)`);
  }
  await appendAuditEvents(dbSession, identity.organizationId, [
    { kind: "task_created", label: `${roleForPersona(agentId)}:${request.origin}`, payloadDigest: await digestPayload(request.goal), count: task.maxSteps },
  ]);

  const work = dbSession.afterCommit(() => withWorkerOrganizationSession(identity.organizationId, (workerSession) =>
    runTaskInBackground(workerSession, env as AgentWorkerEnv, identity.organizationId, task.id, "request"),
  )).catch((error) => console.error("agent_task_request_background_failed", { taskId: task.id, error }));
  getRequestExecutionContext()?.waitUntil(work);
  return { ok: true, taskId: task.id, agentId, employeeId: employee?.id ?? null, reused: false };
}

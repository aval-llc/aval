/**
 * Cloudflare background worker for durable tasks and financial reconciliation.
 * Browser reads never execute work; request `waitUntil` gives new tasks a fast
 * start and the minute cron is the durable recovery path.
 */

import { eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { agentWorkerRuns } from "@/db/postgres/schema";
import type { AskAvalEnv } from "@/lib/ask-aval/model-types";
import { digestPayload } from "@/lib/audit/chain";
import { expireAllStaleApprovals } from "./approvals.ts";
import { reconcileDueFinancialOperations, type ReconciliationEnv } from "./financial-operations.ts";
import { advanceTask, newWorkerId, type AdvanceOutcome } from "./runtime.ts";
import { claimableTasks, resumableApprovalTasks, type TaskRecord } from "./tasks.ts";
import { emitAgentOperationalAlert, type AgentMonitoringEnv } from "./monitoring.ts";

export type AgentWorkerEnv = AskAvalEnv & ReconciliationEnv & AgentMonitoringEnv;
export type WorkerTrigger = "scheduled" | "request" | "approval" | "manual";

export interface WorkerBatchResult {
  runId: string;
  trigger: WorkerTrigger;
  scanned: number;
  advanced: number;
  completed: number;
  failed: number;
  parked: number;
  reconciliation: { checked: number; matched: number; discrepancies: number; deferred: number };
}

const BATCH_SIZE = 8;
// A DbSession owns one transaction and must never be shared concurrently.
// Sequential advancement also keeps the Supabase Free connection footprint low.
const CONCURRENCY = 1;

export async function runAgentWorkerBatch(dbSession: DbSession, env: AgentWorkerEnv, trigger: WorkerTrigger = "scheduled"): Promise<WorkerBatchResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  await dbSession.db.insert(agentWorkerRuns).values({
    id: runId,
    organizationId: dbSession.identity.organizationId,
    trigger,
    status: "running",
    tasksScanned: 0,
    tasksAdvanced: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksParked: 0,
    errorDigest: null,
    startedAt,
    finishedAt: null,
  });

  try {
    const expired = await expireAllStaleApprovals(dbSession);
    const [ordinary, approval] = await Promise.all([
      claimableTasks(dbSession, BATCH_SIZE),
      resumableApprovalTasks(dbSession, BATCH_SIZE),
    ]);
    const tasks = uniqueTasks([...approval, ...ordinary]).slice(0, BATCH_SIZE);
    const outcomes = await mapWithConcurrency(tasks, CONCURRENCY, (task) =>
      advanceTask(dbSession, env, task.organizationId, task.id, newWorkerId(), {
        invocationBudgetMs: 35_000,
        maxStepsThisInvocation: 3,
      }),
    );
    const counts = countOutcomes(outcomes);
    const reconciliation = await reconcileDueFinancialOperations(dbSession, env, 25);
    const result: WorkerBatchResult = {
      runId,
      trigger,
      scanned: tasks.length,
      ...counts,
      reconciliation,
    };
    await finishRun(dbSession, runId, result);
    console.log(JSON.stringify({ event: "agent_worker_batch", ...result, approvalsExpired: expired, durationMs: Date.now() - startedAt.getTime() }));
    if (reconciliation.discrepancies > 0 || counts.failed > 0) {
      console.error(JSON.stringify({ event: "agent_worker_attention_required", runId, failedTasks: counts.failed, reconciliationDiscrepancies: reconciliation.discrepancies }));
      await dbSession.outsideTransaction(() => Promise.all([
        reconciliation.discrepancies > 0 ? emitAgentOperationalAlert(env, { severity: "critical", code: "reconciliation_discrepancy", runId, count: reconciliation.discrepancies, occurredAt: new Date().toISOString() }) : Promise.resolve(),
        counts.failed > 0 ? emitAgentOperationalAlert(env, { severity: "warning", code: "task_failed", runId, count: counts.failed, occurredAt: new Date().toISOString() }) : Promise.resolve(),
      ])).catch((error) => console.error("agent_alert_delivery_failed", { runId, error }));
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dbSession.db.update(agentWorkerRuns).set({
      status: "failed",
      errorDigest: await digestPayload(message),
      finishedAt: new Date(),
    }).where(eq(agentWorkerRuns.id, runId)).catch(() => {});
    console.error(JSON.stringify({ event: "agent_worker_failed", runId, trigger, error: message }));
    await dbSession.outsideTransaction(() => emitAgentOperationalAlert(env, { severity: "critical", code: "worker_failed", runId, occurredAt: new Date().toISOString() }))
      .catch((alertError) => console.error("agent_alert_delivery_failed", { runId, error: alertError }));
    throw error;
  }
}

/** Fast-path one task after creation/approval, still fully lease guarded. */
export async function runTaskInBackground(dbSession: DbSession, env: AgentWorkerEnv, organizationId: string, taskId: string, trigger: "request" | "approval"): Promise<AdvanceOutcome> {
  const started = Date.now();
  const outcome = await advanceTask(dbSession, env, organizationId, taskId, newWorkerId(), {
    invocationBudgetMs: 35_000,
    maxStepsThisInvocation: 3,
  });
  console.log(JSON.stringify({ event: "agent_task_background", trigger, taskId, organizationId, status: outcome.status, stepsRun: outcome.stepsRun, durationMs: Date.now() - started }));
  if (outcome.status === "FAILED") {
    await dbSession.outsideTransaction(() => emitAgentOperationalAlert(env, { severity: "warning", code: "task_failed", taskId, occurredAt: new Date().toISOString() }))
      .catch((error) => console.error("agent_alert_delivery_failed", { taskId, error }));
  }
  return outcome;
}

function uniqueTasks(tasks: TaskRecord[]): TaskRecord[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function countOutcomes(outcomes: AdvanceOutcome[]) {
  return {
    advanced: outcomes.filter((outcome) => outcome.stepsRun > 0).length,
    completed: outcomes.filter((outcome) => outcome.status === "COMPLETED").length,
    failed: outcomes.filter((outcome) => outcome.status === "FAILED").length,
    parked: outcomes.filter((outcome) => outcome.status === "WAITING_FOR_APPROVAL").length,
  };
}

async function finishRun(dbSession: DbSession, runId: string, result: WorkerBatchResult): Promise<void> {
  await dbSession.db.update(agentWorkerRuns).set({
    status: "completed",
    tasksScanned: result.scanned,
    tasksAdvanced: result.advanced,
    tasksCompleted: result.completed,
    tasksFailed: result.failed,
    tasksParked: result.parked,
    finishedAt: new Date(),
  }).where(eq(agentWorkerRuns.id, runId));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

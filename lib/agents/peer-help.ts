/**
 * A Specialist asking a legitimate peer for help (directive §16).
 *
 * The Maintenance Specialist that finds a recurring leak asks Spend & Vendor
 * for the vendor's history rather than guessing at it. That is a bounded
 * sub-problem: one question, to one declared collaborator, with a completion
 * condition of its own, inside the same Work.
 *
 * Nothing here is a side channel. A peer request is an ordinary delegated task,
 * held to every delegation limit (delegation.ts, delegation-policy.ts), and the
 * asker waits for it in `WAITING_FOR_AGENT` — woken when the peer settles and
 * on a recheck timer otherwise. What it cannot do:
 *
 *   - widen authority: a Specialist routes nothing, so its peer may exercise
 *     only what the asker itself holds;
 *   - reach an undeclared actor: only its collaborators and related Leads;
 *   - ask forever: a small per-task allowance, and the Work's own size limit;
 *   - duplicate: the same question already open in the Work is reused.
 *
 * The peer's answer arrives as context, like a plan dependency's result. It is
 * a peer's opinion, not a provider fact, and is framed to the model as such.
 */

import type { DbSession } from "@/db/postgres/session";
import { and, eq } from "drizzle-orm";
import { agentTasks } from "@/db/postgres/schema";
import { parseTaskCheck } from "./checks.ts";
import { DELEGATION_POLICY } from "./delegation-policy.ts";
import { delegate } from "./delegation.ts";
import { permissionsForCheck } from "./goal-plan.ts";
import { actorHolds, actorOrchestrates, builtInActor, isOrchestrator, resolveActorId } from "./organization/index.ts";
import { getTask, type TaskRecord } from "./tasks.ts";
import { awaitedTasks } from "./work-identity.ts";
import { TERMINAL_STATES, type TaskState } from "./task-state.ts";

export const PEER_HELP_TOOL = "request_peer_help";

interface PeerScope { awaiting?: string[]; peerRequests?: number }

export function peerScope(task: Pick<TaskRecord, "executionScopeJson">): PeerScope {
  const scope = JSON.parse(task.executionScopeJson) as PeerScope;
  return { awaiting: Array.isArray(scope.awaiting) ? scope.awaiting.map(String) : [], peerRequests: Number(scope.peerRequests ?? 0) };
}

/** Whether this task may ask a peer at all — offered to the model only where it could succeed. */
export function mayRequestPeerHelp(task: Pick<TaskRecord, "agentId" | "delegationDepth" | "checkJson" | "executionScopeJson">): boolean {
  if (JSON.parse(task.checkJson ?? "{}").kind === "plan") return false;
  if (task.delegationDepth + 1 > DELEGATION_POLICY.maxDepth) return false;
  if ((peerScope(task).peerRequests ?? 0) >= DELEGATION_POLICY.maxPeerRequestsPerTask) return false;
  const actor = builtInActor(task.agentId);
  return Boolean(actor && actor.delegatesTo.size > 0);
}

export async function requestPeerHelp(
  dbSession: DbSession,
  organizationId: string,
  taskId: string,
  args: Record<string, unknown>,
): Promise<{ peerTaskId: string; peer: string; reused: boolean; status: string }> {
  const task = await getTask(dbSession, organizationId, taskId);
  if (!task) throw Error("Task not found.");
  if (JSON.parse(task.checkJson ?? "{}").kind === "plan") throw Error("A planner hands out work through plan_goal, not peer requests.");
  const scope = peerScope(task);
  if ((scope.peerRequests ?? 0) >= DELEGATION_POLICY.maxPeerRequestsPerTask) {
    throw Error(`This task has already made ${DELEGATION_POLICY.maxPeerRequestsPerTask} peer requests. Work with the answers you have.`);
  }
  if (typeof args.agentId !== "string" || typeof args.question !== "string" || !args.question.trim() || args.question.length > 1200) {
    throw Error("Name the peer by id and ask one question of at most 1200 characters.");
  }
  const peerId = resolveActorId(args.agentId);
  const peer = builtInActor(peerId);
  if (!peer || peer.kind === "aval_one") throw Error(`"${args.agentId}" is not an Aval Lead or Specialist.`);
  const check = parseTaskCheck(args.check);
  if (check.kind === "plan") throw Error("A peer answers a checked question; it does not take over the planning.");

  // The peer must hold what its condition needs, and the asker must hold or
  // route it. A Specialist routes nothing, so for a Specialist this is plain
  // narrowing: the peer can do no more than the asker could.
  const employeeActing = Boolean(task.employeeId && isOrchestrator(task.agentId));
  for (const permission of permissionsForCheck(check)) {
    if (!actorHolds(peerId, permission)) throw Error(`${peer.name} does not hold "${permission}", which that condition needs.`);
    if (!employeeActing && !actorHolds(task.agentId, permission) && !actorOrchestrates(task.agentId, permission)) {
      throw Error(`Asking ${peer.name} would reach "${permission}", which this task does not hold. A peer request cannot widen authority.`);
    }
  }

  const result = await delegate(dbSession, task, peerId, args.question.trim(), { check, scope: { peerOf: task.id } });
  if (!result.ok) throw Error(result.reason);

  // Recorded on the asker, compare-and-set against the scope it was read with,
  // so two concurrent requests cannot both count as the first.
  const next = { ...JSON.parse(task.executionScopeJson), awaiting: [...new Set([...(scope.awaiting ?? []), result.task.id])], peerRequests: (scope.peerRequests ?? 0) + 1 };
  const saved = await dbSession.db.update(agentTasks).set({ executionScopeJson: JSON.stringify(next) })
    .where(and(eq(agentTasks.id, task.id), eq(agentTasks.organizationId, organizationId), eq(agentTasks.executionScopeJson, task.executionScopeJson)))
    .returning({ id: agentTasks.id });
  if (!saved.length) throw Error("The task changed while the peer request was recorded. Retry from current state.");
  return { peerTaskId: result.task.id, peer: peer.name, reused: result.reused, status: result.task.status };
}

/**
 * Whether a task parked on its peers may run again, and what they said.
 *
 * Every awaited task must have settled. A peer that failed is reported as
 * failed rather than hidden: the asker decides what to do without it.
 */
export async function peerReadiness(dbSession: DbSession, task: TaskRecord): Promise<{ wait: boolean; context?: string }> {
  const ids = peerScope(task).awaiting ?? [];
  if (ids.length === 0) return { wait: false };
  const peers = await awaitedTasks(dbSession, task.organizationId, ids);
  if (peers.length < ids.length || peers.some((peer) => !TERMINAL_STATES.has(peer.status as TaskState))) return { wait: true };
  return {
    wait: false,
    context: "Peer answers (a peer's view, not a provider fact — verify anything you act on): " + JSON.stringify(peers.map((peer) => ({
      peer: builtInActor(peer.agentId)?.name ?? peer.agentId,
      question: peer.goal,
      status: peer.status,
      result: peer.status === "COMPLETED" ? peer.resultJson : null,
      error: peer.status === "COMPLETED" ? null : peer.error,
    }))).slice(0, 12000),
  };
}

import type { DbSession } from "@/db/postgres/session";
import { taskBoundary, inboundToolAllowed } from './task-boundary';
/**
 * The tool executor: the only path from a model's proposal to a tool actually
 * running.
 *
 * Everything the guide asks for between "the LLM proposed something" and
 * "something happened" lives here, in a fixed order that no caller can
 * reorder or skip:
 *
 *     policy → idempotency → approval → timeout-bounded execution → retry → audit
 *
 * It deliberately produces its audit events rather than writing them, so the
 * caller can append them in one batch when the run resolves. That is the
 * existing discipline in lib/ask-aval/loop.ts — a D1 round-trip inside every
 * tool call would put storage latency on the critical path of every question —
 * and this module inherits it rather than inventing a second convention.
 *
 * The executor never throws for an expected outcome. A denial, a duplicate, a
 * timeout and a tool crash are all *results*, because a caller that has to
 * catch exceptions to learn it was denied will eventually catch one it did not
 * mean to and fail open.
 */

import { checkFaithfulness, withDerivedNumbers } from "@/lib/ask-aval/faithfulness";
import { evidenceNumbersFromTranscript } from "./transcript-evidence";
import { canonicalAction } from "./autonomy";
import { employeeExecutionRefusal } from "./employee-access";
import { getTask } from "./tasks";
import { executionAuthority } from "./autonomy-storage";
import { getTool } from "./registry";
import { runTool, TOOL_SCHEMAS } from "@/lib/ask-aval/tools";
import { validateToolArguments } from "./tool-schema.ts";
import { boundToolResult } from "./output-bounds.ts";
import { digestPayload, type AuditEvent } from "@/lib/audit/chain";
import { evaluate, type DenyCode, type PolicyContext, type PolicySubject } from "./policy.ts";
import { idempotencyKey } from "./financial.ts";
import { reserveMutation } from "./tasks.ts";
import type { ToolDescriptor } from "./registry.ts";
import { redactArguments } from "./redaction.ts";
import { evaluateFinancialProposal, type FinancialProposalDecision } from "./execution-policy.ts";
import { recordFinancialToolResult, reserveFinancialOperation } from "./financial-operations.ts";

export interface ExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  subject: PolicySubject;
  context?: PolicyContext;
  /**
   * Durable-run coordinates. Absent for the synchronous chat loop, which has
   * no task row — the effect is that a mutating tool cannot be executed from
   * the chat loop at all, since there is nowhere to record its idempotency key.
   */
  task?: { id: string; stepIndex: number; approvalId?: string; policyVersion?: number };
}

export type ExecutionResult =
  | { status: "ok"; json: unknown; numbers: number[]; durationMs: number; attempts: number; tool: ToolDescriptor }
  | { status: "denied"; code: DenyCode; reason: string }
  | { status: "needs_approval"; tool: ToolDescriptor; reason: string; idempotencyKey: string | null; tier: "single_approver" | "elevated_approver"; requiredApprovals: number; policyVersion: number }
  | { status: "duplicate"; idempotencyKey: string }
  | { status: "failed"; reason: string; attempts: number; tool: ToolDescriptor };

export interface ExecutionOutcome {
  result: ExecutionResult;
  /** Appended by the caller in one batch when the run resolves. */
  audit: AuditEvent[];
}

/** Backoff between retries. Exponential with a floor, so a transient D1 blip does not become four immediate hammer-blows. */
const RETRY_BASE_MS = 250;

export async function executeTool(dbSession: DbSession, request: ExecutionRequest): Promise<ExecutionOutcome> {
  const audit: AuditEvent[] = [];
  if (request.task) {
    const refusal = await taskBoundary(dbSession, request.subject.organizationId, request.subject.userId, request.task.id, request.toolName, request.args);
    if (refusal) {
      audit.push({kind:'policy_decision',label:request.toolName+':deny',payloadDigest:await digestPayload(refusal),count:0});
      return {result:{status:'denied',code:'permission_denied',reason:refusal},audit};
    }
  }
  const descriptor = getTool(request.toolName);
  if (request.task) {
    const task = await getTask(dbSession, request.subject.organizationId, request.task.id);
    if(task?.employeeId) {
      const refusal=await employeeExecutionRefusal(dbSession,request.subject.organizationId,task.employeeId,request.toolName,request.args);
      if(refusal)return {result:{status:'denied',code:'permission_denied',reason:refusal},audit};
    }
    const scope = task ? JSON.parse(task.executionScopeJson) : {};
    if (task && ['send_external_message','place_call','publish_listing'].includes(request.toolName)) {
      const evidence = evidenceNumbersFromTranscript(JSON.parse(task.transcriptJson));
      const claims = request.toolName === 'place_call' ? request.args.script : request.args.body;
      if (!checkFaithfulness(claims, withDerivedNumbers(evidence)).ok) return { result: { status: 'denied', code: 'invalid_arguments', reason: 'The proposed communication contains figures not verified by this task’s evidence. Read the supporting records or remove the unsupported figures.' }, audit };
    }

    if (scope.source === 'inbound' && descriptor?.mutates && !inboundToolAllowed(scope, request.toolName, request.args)) return { result: { status: 'denied', code: 'permission_denied', reason: 'An inbound-message task can only reply to its originating conversation.' }, audit };
  }

  if (descriptor && !descriptor.unimplemented && (descriptor.mutates || request.toolName === 'request_execution_plan')) {
    const authority = await executionAuthority(dbSession, request.subject.organizationId, request.subject.userId, request.task?.id, request.toolName, request.args);
    if (!authority.role || (descriptor.requiredPermission === 'messaging.send.external' && authority.role === 'member' && !request.task?.approvalId && !authority.planned)) return { result: { status: 'denied', code: 'permission_denied', reason: 'Current workspace membership does not authorize this action.' }, audit };
    request = { ...request, context: { ...request.context, autonomyMode: authority.mode, approvedPlanAction: authority.planned } };
  }
  const decision = evaluate(request.toolName, request.args, request.subject, request.context ?? {});

  audit.push({
    kind: "policy_decision",
    label: `${request.toolName}:${decision.effect}`,
    payloadDigest: await digestPayload(redactArguments(request.args, TOOL_SCHEMAS.get(request.toolName))),
    count: 0,
  });

  if (decision.effect === "deny") {
    return { result: { status: "denied", code: decision.code, reason: decision.reason }, audit };
  }

  const tool = decision.tool;

  // Policy decided *whether* this agent may call the tool. This decides whether
  // the call is even well formed. Both run before anything executes, and both
  // run against the backend's own declarations rather than the model's word.
  const shape = validateToolArguments(TOOL_SCHEMAS.get(tool.name), request.args);
  if (!shape.ok) {
    audit.push({
      kind: "policy_decision",
      label: `${tool.name}:invalid_arguments`,
      payloadDigest: await digestPayload(shape.problems),
      count: shape.problems.length,
    });
    return {
      result: { status: "denied", code: "invalid_arguments", reason: shape.problems.join(" ") },
      audit,
    };
  }

  if (tool.name === 'request_execution_plan') {
    const actions = request.args.actions as {tool:string;args:Record<string,unknown>}[];
    for (const action of actions) {
      const shape = validateToolArguments(TOOL_SCHEMAS.get(action.tool), action.args);
      const permission = evaluate(action.tool, action.args, request.subject, { personaId: request.context?.personaId });
      if (!shape.ok || permission.effect === 'deny') return { result: { status: 'denied', code: 'invalid_arguments', reason: 'The plan contains an invalid or unauthorized action.' }, audit };
    }
  }

  const financialDecision = tool.financial
    ? await evaluateFinancialProposal(dbSession, request.subject.organizationId, tool, request.args)
    : null;
  if (financialDecision && !financialDecision.ok) {
    return {
      result: { status: "denied", code: "financial_policy_denied", reason: financialDecision.reason },
      audit,
    };
  }
  if (financialDecision?.ok && request.task?.policyVersion !== undefined && request.task.policyVersion !== financialDecision.policy.version) {
    return {
      result: { status: "denied", code: "financial_policy_denied", reason: "The financial policy changed after this action was approved. Propose it again under the current policy." },
      audit,
    };
  }

  // A mutating tool without a task row has nowhere to record its key, so it
  // cannot be made safe to retry — refusing is the only honest answer.
  const key = tool.mutates
    ? request.task
      ? idempotencyKey(request.task.id, request.task.stepIndex, tool.name)
      : null
    : null;

  if (tool.mutates && !key) {
    return {
      result: { status: "denied", code: "invalid_arguments", reason: `"${tool.name}" changes stored state and can only run inside a durable task.` },
      audit,
    };
  }

  if (decision.effect === "require_approval") {
    audit.push({ kind: "approval_requested", label: tool.name, payloadDigest: await digestPayload(redactArguments(request.args)), count: 0 });
    const financial = financialDecision?.ok ? financialDecision : null;
    return {
      result: {
        status: "needs_approval",
        tool,
        reason: decision.reason,
        idempotencyKey: key,
        tier: financial?.tier ?? "single_approver",
        requiredApprovals: financial?.requiredApprovals ?? 1,
        policyVersion: financial?.policy.version ?? 1,
      },
      audit,
    };
  }

  return reserveThenRun(dbSession, tool, request, key, audit, financialDecision?.ok ? financialDecision : null);
}

/**
 * Claims the idempotency key, then runs.
 *
 * Ordered this way on purpose: the reservation is what makes a duplicate
 * impossible, so it must happen before the side effect, not after it. A
 * read-only tool has no key and skips straight through.
 */
async function reserveThenRun(dbSession: DbSession,
  tool: ToolDescriptor,
  request: ExecutionRequest,
  key: string | null,
  audit: AuditEvent[],
  financial: Extract<FinancialProposalDecision, { ok: true }> | null = null,
): Promise<ExecutionOutcome> {
  if (key && request.task) {
    const reserved = await reserveMutation(dbSession, {
      taskId: request.task.id,
      organizationId: request.subject.organizationId,
      stepIndex: request.task.stepIndex,
      toolName: tool.name,
      idempotencyKey: key,
      argsDigest: await digestPayload(redactArguments(request.args, TOOL_SCHEMAS.get(tool.name))),
      riskLevel: tool.riskLevel,
    });
    if (!reserved) {
      audit.push({ kind: "tool_call", label: `${tool.name}:duplicate_suppressed`, payloadDigest: await digestPayload(key), count: 0 });
      return { result: { status: "duplicate", idempotencyKey: key }, audit };
    }
  }

  let financialOperationId: string | null = null;
  if (key && request.task && financial) {
    const reservation = await reserveFinancialOperation(dbSession, {
      organizationId: request.subject.organizationId,
      taskId: request.task.id,
      approvalId: request.task.approvalId,
      stepIndex: request.task.stepIndex,
      toolName: tool.name,
      idempotencyKey: key,
      amountCents: financial.amountCents,
      currency: financial.currency,
      accountFingerprint: financial.accountFingerprint,
      dailyLimitCents: financial.policy.dailyLimitCents,
    });
    if (!reservation.ok) {
      if (reservation.duplicate) return { result: { status: "duplicate", idempotencyKey: key }, audit };
      const reason = reservation.reason === "daily_limit"
        ? "The rolling 24-hour financial limit was reached before reservation. Nothing was executed."
        : "The financial operation could not be durably reserved. Nothing was executed.";
      return { result: { status: "failed", reason, attempts: 0, tool }, audit };
    }
    financialOperationId = reservation.operation.id;
  }
  return runWithRetries(dbSession, tool, request, key, audit, financialOperationId);
}

/**
 * Executes an already-authorized tool.
 *
 * Split from `executeTool` so an approved action can resume here without
 * re-running the approval branch and parking itself a second time — the
 * caller supplies the approval it already holds, and the policy re-check is
 * still performed, because an approval from an hour ago is not evidence that
 * the permission still stands now.
 */
export async function executeApprovedTool(dbSession: DbSession, request: ExecutionRequest & { task: { id: string; stepIndex: number } }): Promise<ExecutionOutcome> {
  const audit: AuditEvent[] = [];
  if (request.task) {
    const refusal = await taskBoundary(dbSession, request.subject.organizationId, request.subject.userId, request.task.id, request.toolName, request.args);
    if (refusal) {
      audit.push({kind:'policy_decision',label:request.toolName+':deny',payloadDigest:await digestPayload(refusal),count:0});
      return {result:{status:'denied',code:'permission_denied',reason:refusal},audit};
    }
  }
  const descriptor = getTool(request.toolName);
  if (request.task) {
    const task = await getTask(dbSession, request.subject.organizationId, request.task.id);
    if(task?.employeeId) {
      const refusal=await employeeExecutionRefusal(dbSession,request.subject.organizationId,task.employeeId,request.toolName,request.args);
      if(refusal)return {result:{status:'denied',code:'permission_denied',reason:refusal},audit};
    }
    const scope = task ? JSON.parse(task.executionScopeJson) : {};
    if (task && ['send_external_message','place_call','publish_listing'].includes(request.toolName)) {
      const evidence = evidenceNumbersFromTranscript(JSON.parse(task.transcriptJson));
      const claims = request.toolName === 'place_call' ? request.args.script : request.args.body;
      if (!checkFaithfulness(claims, withDerivedNumbers(evidence)).ok) return { result: { status: 'denied', code: 'invalid_arguments', reason: 'The proposed communication contains figures not verified by this task’s evidence. Read the supporting records or remove the unsupported figures.' }, audit };
    }

    if (scope.source === 'inbound' && descriptor?.mutates && !inboundToolAllowed(scope, request.toolName, request.args)) return { result: { status: 'denied', code: 'permission_denied', reason: 'An inbound-message task can only reply to its originating conversation.' }, audit };
  }

  if (descriptor && !descriptor.unimplemented && (descriptor.mutates || request.toolName === 'request_execution_plan')) {
    const authority = await executionAuthority(dbSession, request.subject.organizationId, request.subject.userId, request.task?.id, request.toolName, request.args);
    if (!authority.role || (descriptor.requiredPermission === 'messaging.send.external' && authority.role === 'member' && !request.task?.approvalId && !authority.planned)) return { result: { status: 'denied', code: 'permission_denied', reason: 'Current workspace membership does not authorize this action.' }, audit };
    request = { ...request, context: { ...request.context, autonomyMode: authority.mode, approvedPlanAction: authority.planned } };
  }
  const decision = evaluate(request.toolName, request.args, request.subject, request.context ?? {});
  if (decision.effect === "deny") {
    return { result: { status: "denied", code: decision.code, reason: decision.reason }, audit };
  }
  const tool = decision.tool;
  const shape = validateToolArguments(TOOL_SCHEMAS.get(tool.name), request.args);
  if (!shape.ok) return { result: { status: 'denied', code: 'invalid_arguments', reason: shape.problems.join(' ') }, audit };
  const financialDecision = tool.financial
    ? await evaluateFinancialProposal(dbSession, request.subject.organizationId, tool, request.args)
    : null;
  if (financialDecision && !financialDecision.ok) {
    return { result: { status: "denied", code: "financial_policy_denied", reason: financialDecision.reason }, audit };
  }
  if (financialDecision?.ok && request.task.policyVersion !== undefined && request.task.policyVersion !== financialDecision.policy.version) {
    return { result: { status: "denied", code: "financial_policy_denied", reason: "The financial policy changed after approval. The action must be proposed again." }, audit };
  }
  const key = tool.mutates ? idempotencyKey(request.task.id, request.task.stepIndex, tool.name) : null;
  return reserveThenRun(dbSession, tool, request, key, audit, financialDecision?.ok ? financialDecision : null);
}

async function runWithRetries(dbSession: DbSession,
  tool: ToolDescriptor,
  request: ExecutionRequest,
  _key: string | null,
  audit: AuditEvent[],
  financialOperationId: string | null,
): Promise<ExecutionOutcome> {
  const started = Date.now();
  let lastError = "";

  for (let attempt = 1; attempt <= tool.maxRetries + 1; attempt++) {
    try {
      const out = await withTimeout(
        runTool(dbSession, tool.name, request.args, request.subject.organizationId, request.task ? `${request.task.id}:${tool.name}:${await digestPayload(canonicalAction(request.args))}` : _key ?? undefined,
          // The persona travels with the task coordinates so a PMS write can
          // re-resolve this agent's deployments at execution time, not just at
          // assembly. `approvalId` is already on `task` and reaches the same gate.
          request.task ? { ...request.task, personaId: request.context?.personaId } : undefined),
        tool.timeoutMs,
        tool.name,
      );
      const durationMs = Date.now() - started;
      // Bounded before anything else reads it: the financial recorder, the
      // audit digest and the model all see the same value, and a tenant-sized
      // document cannot spend a whole task budget in one step.
      const bounded = boundToolResult(out.json);
      if (bounded.truncated) {
        audit.push({ kind: "tool_call", label: `${tool.name}:truncated`, payloadDigest: await digestPayload(bounded.originalChars), count: bounded.originalChars });
      }
      if (financialOperationId) {
        const recorded = await recordFinancialToolResult(dbSession, financialOperationId, request.subject.organizationId, bounded.json);
        if (!recorded.ok) {
          audit.push({ kind: "tool_error", label: `${tool.name}:reconciliation_required`, payloadDigest: await digestPayload(recorded.reason), count: attempt });
          return { result: { status: "failed", reason: `${recorded.reason} The operation is marked unknown and requires reconciliation; it will not be retried.`, attempts: attempt, tool }, audit };
        }
      }
      audit.push({ kind: "tool_call", label: tool.name, payloadDigest: await digestPayload(bounded.json), count: out.numbers.length });
      return {
        result: { status: "ok", json: bounded.json, numbers: out.numbers, durationMs, attempts: attempt, tool },
        audit,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const willRetry = attempt <= tool.maxRetries;
      audit.push({
        kind: willRetry ? "tool_retry" : "tool_error",
        label: tool.name,
        payloadDigest: await digestPayload(lastError),
        count: attempt,
      });
      if (!willRetry) break;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  // A mutating tool that failed keeps its reservation. Freeing it here would
  // re-open the window this design closed: the failure may have been a
  // timeout on an operation that actually succeeded.
  return { result: { status: "failed", reason: lastError, attempts: tool.maxRetries + 1, tool }, audit };
}

/**
 * Bounds a tool's wall-clock time.
 *
 * The losing promise is not cancelled — `runTool` has no abort signal — so
 * this bounds how long the *agent* waits, not how long the query runs. That
 * distinction is why `maxRetries` is zero for every mutating tool in the
 * registry: retrying a timed-out mutation could genuinely double it, and the
 * only safe posture without real cancellation is not to retry.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool "${label}" exceeded its ${ms}ms budget.`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { redactArguments };

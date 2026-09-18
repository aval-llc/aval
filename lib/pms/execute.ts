/**
 * One write path for all four workflows (docs/PMS_INTEGRATION.md, P1).
 *
 * The brief is explicit: "If maintenance writes and arrears writes go through
 * different machinery, the design is wrong." So every one of the ten PMS write
 * tools lands here, and what differs between them is only what the capability
 * matrix already decided.
 *
 * Two execution routes, chosen by the provider descriptor and never by the
 * caller:
 *
 *   api + cloud    → a registered adapter runs now, in the Worker.
 *   ui  + desktop  → the write is enqueued and drained by the Electron runner
 *                    on the customer's machine, against the session they are
 *                    already signed into. Aval never holds a PMS password.
 *
 * "Queued" is reported as queued, never as done. A property manager whose
 * laptop is closed has not had their work order created, and telling them
 * otherwise is the one failure this whole design exists to avoid.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { pmsWriteQueue } from "@/db/schema";
import { pmsProvider } from "./providers/index.ts";
import { pmsWriteAllowed } from "./assembly.ts";
import { activeFlow } from "./flows.ts";
import { writeAdapter } from "./flows.ts";
import { actionForTool } from "./tool-map.ts";
import { ensurePmsAdaptersRegistered } from "./register.ts";

export type PmsWriteResult =
  | { status: "done"; externalId?: string; provider: string }
  | { status: "queued"; queueId: string; provider: string; runnerOnline: boolean }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: string };

export interface PmsWriteRequest {
  organizationId: string;
  providerId: string;
  toolName: string;
  payload: Record<string, unknown>;
  /**
   * Stable across retries of the same logical write. The queue's unique index on
   * (org, idempotencyKey) is what makes a repeat collide instead of writing
   * twice — which is why every one of these tools can declare `idempotent: true`
   * while still declaring `maxRetries: 0`.
   */
  idempotencyKey: string;
  /** The approval this write executes under, when one was required. */
  approvalId?: string;
  /**
   * The persona this write is running as, for the deployment re-check.
   *
   * Optional because a caller with no agent in hand (a queue drain, a settings
   * preview) is not an agent acting. When present it is re-resolved against the
   * deployment table here, not trusted from assembly — see below.
   */
  personaId?: string;
}

/** A runner that has asked for work inside this window is considered online. */
const RUNNER_ONLINE_WINDOW_MS = 2 * 60 * 1000;

export async function executePmsWrite(request: PmsWriteRequest): Promise<PmsWriteResult> {
  ensurePmsAdaptersRegistered();
  const action = actionForTool(request.toolName);
  if (!action) return { status: "denied", reason: `"${request.toolName}" is not a PMS write tool.` };

  const descriptor = pmsProvider(request.providerId);
  if (!descriptor) return { status: "denied", reason: `No capability descriptor for "${request.providerId}".` };

  // Re-resolve rather than trust assembly. Assembly ran at the top of a turn
  // that may have been running for minutes, and an authorization can be
  // suspended in between — which is what makes same-day revocation real. The
  // persona goes with it so a deployment paused mid-turn is caught here too:
  // without it, pausing only stopped the *next* turn's assembly, and a turn
  // already in flight kept its tools.
  const gate = await pmsWriteAllowed(
    request.organizationId,
    request.providerId,
    request.toolName,
    request.personaId,
  );
  if (!gate.allowed) return { status: "denied", reason: gate.reason ?? "Not permitted." };

  // Fair Housing: these never execute without a named approval, whatever the
  // autonomy mode or settings row says. Checked here as well as in the registry
  // so that no future edit to either one can make them autonomous alone.
  if (gate.mandatoryApproval && !request.approvalId) {
    return {
      status: "denied",
      reason: "This action requires an explicit human approval before it can run. This is not configurable.",
    };
  }

  const mechanism = descriptor.write.mechanisms[0];
  if (mechanism === "api") return runAdapter(request, action);
  return enqueueForRunner(request, action);
}

async function runAdapter(
  request: PmsWriteRequest,
  action: ReturnType<typeof actionForTool> & string,
): Promise<PmsWriteResult> {
  const adapter = writeAdapter(request.providerId, action);
  if (!adapter) {
    // Should be unreachable: the matrix resolves this to `unlearned` and the
    // tool is never assembled. Kept because "unreachable" and "safe" differ.
    return { status: "denied", reason: "No adapter is implemented for this action." };
  }
  try {
    const result = await adapter({
      organizationId: request.organizationId,
      providerId: request.providerId,
      action,
      payload: request.payload,
    });
    return result.ok
      ? { status: "done", externalId: result.externalId, provider: request.providerId }
      : { status: "failed", reason: result.error };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "Adapter threw." };
  }
}

async function enqueueForRunner(
  request: PmsWriteRequest,
  action: ReturnType<typeof actionForTool> & string,
): Promise<PmsWriteResult> {
  const db = getDb();
  const now = new Date();

  const flow = await activeFlow(request.organizationId, request.providerId, action);
  if (!flow) {
    return { status: "denied", reason: "No approved flow exists for this action yet." };
  }

  const id = crypto.randomUUID();
  await db
    .insert(pmsWriteQueue)
    .values({
      id,
      organizationId: request.organizationId,
      provider: request.providerId,
      action,
      approvalId: request.approvalId ?? null,
      flowId: flow.id,
      payloadJson: JSON.stringify(request.payload),
      idempotencyKey: request.idempotencyKey,
      status: "pending",
      leasedBy: null,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    // A duplicate idempotency key is the retry working as designed, not an
    // error: the original row is already queued or done.
    .onConflictDoNothing();

  const [row] = await db
    .select({ id: pmsWriteQueue.id })
    .from(pmsWriteQueue)
    .where(
      and(
        eq(pmsWriteQueue.organizationId, request.organizationId),
        eq(pmsWriteQueue.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1);

  return {
    status: "queued",
    queueId: row?.id ?? id,
    provider: request.providerId,
    runnerOnline: await runnerIsOnline(request.organizationId),
  };
}

/**
 * Whether a desktop runner has recently asked this org for work.
 *
 * Inferred from lease activity rather than a heartbeat table: a runner that
 * leased something in the last two minutes is running. It is deliberately a
 * lower bound — reporting "offline" for a runner that is actually up costs a
 * pessimistic message, while the reverse costs a promise we cannot keep.
 */
async function runnerIsOnline(organizationId: string): Promise<boolean> {
  try {
    const db = getDb();
    const rows = await db
      .select({ leaseExpiresAt: pmsWriteQueue.leaseExpiresAt })
      .from(pmsWriteQueue)
      .where(and(eq(pmsWriteQueue.organizationId, organizationId), eq(pmsWriteQueue.status, "leased")))
      .limit(5);
    const floor = Date.now() - RUNNER_ONLINE_WINDOW_MS;
    return rows.some((row) => (row.leaseExpiresAt?.getTime() ?? 0) > floor);
  } catch {
    return false;
  }
}

/** Human-readable outcome for an approval card or a task transcript. */
export function describeWriteResult(result: PmsWriteResult): string {
  switch (result.status) {
    case "done":
      return `Written to ${result.provider}${result.externalId ? ` (${result.externalId})` : ""}.`;
    case "queued":
      return result.runnerOnline
        ? `Queued for the ${result.provider} desktop runner, which is online and will pick it up shortly.`
        : `Queued for the ${result.provider} desktop runner. It is offline, so nothing has been written yet — `
          + `this will execute when the Aval desktop app next runs on a machine signed into ${result.provider}.`;
    case "denied":
      return `Not executed: ${result.reason}`;
    case "failed":
      return `Failed: ${result.reason}`;
  }
}

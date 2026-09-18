/**
 * Execution for the ten PMS write tools (docs/PMS_INTEGRATION.md, P0.3).
 *
 * The schemas and the payload mapping live in `tool-schemas.ts`, which has no
 * storage in it. This module is the part that needs a database, and it is
 * deliberately thin: nothing here decides whether a write is permitted.
 * Assembly decided that before the model saw the tool, and `executePmsWrite`
 * re-decides it at execution against the matrix, the authorization and — since
 * this wiring landed — the agent's deployments.
 */

import { executePmsWrite, describeWriteResult } from "./execute.ts";
import { isPmsWriteTool } from "./tool-map.ts";
import { SPEC_BY_NAME, str, compact } from "./tool-schemas.ts";

export { PMS_WRITE_TOOL_SCHEMAS } from "./tool-schemas.ts";

export interface PmsWriteContext {
  /** The persona this turn is running as, for the deployment re-check. */
  personaId?: string;
  /** The approval this call executes under, when one was required. */
  approvalId?: string;
}

/**
 * Execute one PMS write tool.
 *
 * Returns a plain record rather than throwing for a refusal: a denied write is
 * an outcome the model must read and explain to the person, not an exception
 * that ends the step. It throws only when the call could not be attempted at
 * all, which the executor records as a tool error.
 */
export async function runPmsWriteTool(
  toolName: string,
  args: Record<string, unknown>,
  organizationId: string,
  idempotencyKey: string | undefined,
  context: PmsWriteContext = {},
): Promise<Record<string, unknown>> {
  const spec = SPEC_BY_NAME.get(toolName);
  if (!spec || !isPmsWriteTool(toolName)) throw new Error(`"${toolName}" is not a PMS write tool.`);

  // No durable task, no write. The idempotency key is what makes a retry
  // collide with its own first attempt instead of creating a second work order,
  // and the synchronous chat loop has no task row to derive one from. Refusing
  // here rather than inventing a key is the same rule `publish_listing` follows.
  if (!idempotencyKey) {
    throw new Error("A PMS write must run inside a durable task, which is where its idempotency key comes from.");
  }

  const providerId = str(args.provider);
  if (!providerId) return { error: "A connected PMS provider must be named." };

  const result = await executePmsWrite({
    organizationId,
    providerId,
    toolName,
    payload: spec.payload(args),
    idempotencyKey,
    approvalId: context.approvalId,
    personaId: context.personaId,
  });

  // `queued` is reported as queued. The model is told in the same breath that
  // nothing has been written yet, because the one failure this design exists to
  // avoid is telling a property manager their work order exists when it is
  // sitting in a queue waiting for a laptop to open.
  return compact({
    status: result.status,
    provider: result.status === "done" || result.status === "queued" ? result.provider : undefined,
    external_id: result.status === "done" ? result.externalId : undefined,
    queue_id: result.status === "queued" ? result.queueId : undefined,
    runner_online: result.status === "queued" ? result.runnerOnline : undefined,
    written: result.status === "done",
    detail: describeWriteResult(result),
  });
}

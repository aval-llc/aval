import { payloadHash, CanonicalPayloadError } from "./canonical-payload.ts";

/**
 * An approval authorizes one exact model proposal, not every call sharing the
 * same tool name in the assistant message.
 *
 * Three things must agree before a call carries an approval: the tool name,
 * the identity of the proposal the approver was shown (`toolUseId`), and a
 * canonical hash of the arguments. The id alone was not enough. It bound the
 * approval to the message that proposed the action rather than to the action,
 * so nothing in the system would have rejected a mutated payload —
 * `AVAL_AGENT.md` §5.4 and §8.4 require that a material edit invalidate the
 * approval, and §17.2 makes accepting a payload mismatch a release blocker.
 *
 * Returning `false` is the safe direction. The caller treats an unmatched call
 * as an ordinary one and sends it through `executeTool`, which re-runs the
 * policy engine; a tool that needs approval is gated again there. A mutated
 * payload therefore loses its approved status and must be re-approved rather
 * than executing on the strength of the original decision.
 *
 * An approval recorded before this check existed has no stored hash. It is
 * refused for the same reason, so the upgrade fails closed instead of leaving
 * older rows permanently exempt.
 */
export async function approvalMatchesToolUse(
  evidenceJson: string,
  toolUse: { id: string; name: string; input: unknown },
  approvedToolName: string,
): Promise<boolean> {
  if (toolUse.name !== approvedToolName) return false;

  let evidence: { toolUseId?: unknown; payloadHash?: unknown };
  try {
    evidence = JSON.parse(evidenceJson) as { toolUseId?: unknown; payloadHash?: unknown };
  } catch {
    return false;
  }

  if (typeof evidence.toolUseId !== "string" || evidence.toolUseId !== toolUse.id) return false;
  if (typeof evidence.payloadHash !== "string" || evidence.payloadHash.length === 0) return false;

  try {
    return (await payloadHash(toolUse.input)) === evidence.payloadHash;
  } catch (error) {
    // A payload that cannot be canonicalized cannot be proven identical to the
    // approved one, so it is not.
    if (error instanceof CanonicalPayloadError) return false;
    throw error;
  }
}

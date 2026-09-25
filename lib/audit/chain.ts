/**
 * A tamper-evident chain over what Ask Aval did to produce an answer.
 *
 * Aval's whole claim is that a figure it states was verified against real
 * tool output by the faithfulness gate. Today that claim is only as good as
 * trusting the running process. This chain makes it checkable after the fact:
 * each entry commits to the entry before it, so removing, reordering or
 * editing any link is detectable by recomputing the hashes.
 *
 * **It stores digests, not content.** A tool result can contain resident
 * names and account balances; an audit table full of those would be a second
 * copy of the most sensitive data in the system, retained indefinitely for
 * bookkeeping. So each entry keeps a SHA-256 of the payload plus a few
 * non-identifying facts (which tool ran, how many numbers it returned,
 * whether the gate passed). That is enough to prove *what happened*, and to
 * re-verify a retained answer against the chain, without the log becoming a
 * liability of its own. Same discipline as `lib/ask-aval/preferences.ts`:
 * keep the structure, drop the content.
 */

/**
 * Event kinds the chain can carry.
 *
 * The first four are the original Ask Aval answer trail. The rest were added
 * with the durable agent runtime (lib/agents/) to meet §15 of the production
 * readiness guide, which wants the policy decision, the approval, the retry
 * and the task lifecycle recorded, not only the tool calls.
 *
 * Adding a kind is safe for chains already written: `serializeEntry` below is
 * unchanged, so every existing entry still hashes to the same value. Changing
 * or reordering that function's fields would not be safe, and must not happen.
 */
export type AuditEntryKind =
  // answer trail
  | "tool_call"
  | "tool_error"
  | "verdict"
  | "answer"
  // agent runtime
  | "task_created"
  | "model_call"
  | "policy_decision"
  | "tool_retry"
  | "approval_requested"
  | "approval_decided"
  | "delegation"
  | "task_completed"
  // An external effect was accepted but not proven. Recorded because the
  // difference between "we did it" and "we asked and it was accepted" is
  // exactly what an audit reader needs to see.
  | "task_pending_verification"
  | "task_failed"
  | "task_cancelled"
  // workspace membership — who can see this tenant's data, and who can
  // approve an agent action in it, belongs in the same tamper-evident record
  // as the approvals themselves.
  | "membership_changed"
  | "invitation_issued"
  | "invitation_accepted"
  | "invitation_revoked"
  // AI employees — who was created, what they were allowed to do, and which
  // expertise was loaded for a piece of work. An employee is an actor in this
  // workspace, so the record of what it was permitted to become belongs beside
  // the record of what it did.
  | "employee_created"
  | "employee_updated"
  | "employee_activated"
  | "employee_paused"
  | "employee_archived"
  | "employee_scope_granted"
  | "employee_scope_revoked"
  | "employee_assigned_to_work"
  | "expertise_selected"
  | "expertise_overridden"
  | "toolset_assembled"
  | "tool_authorization_denied"
  // Customer-authorized provider execution. A browser write happens on somebody
  // else's machine, inside somebody else's session, against a system Aval does
  // not control — which is exactly why the trail has to be legible without it.
  // Each of these is a moment an auditor would otherwise have to infer.
  | "provider_work_claimed"
  | "provider_session_unavailable"
  | "provider_execution_completed"
  | "provider_execution_failed"
  | "provider_verification_confirmed"
  | "provider_verification_contradicted"
  | "provider_verification_inconclusive"
  | "provider_flow_broken"
  | "provider_duplicate_reconciled"
  | "provider_human_handoff";

/** One link, before it is chained. */
export interface AuditEvent {
  kind: AuditEntryKind;
  /** Tool name for tool events; the gate's outcome for a verdict; empty for an answer. */
  label: string;
  /** SHA-256 hex of the payload this event covers. Never the payload itself. */
  payloadDigest: string;
  /** Non-identifying counts — how many numbers a tool returned, how many claims the gate rejected. */
  count: number;
}

export interface AuditEntry extends AuditEvent {
  /** 1-based position within an org's chain. */
  sequence: number;
  previousHash: string;
  entryHash: string;
}

/** The chain's anchor, so an org's chain has a defined start a first entry can commit to. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Field separator for the committed form. A unit separator is used because it
 * cannot occur in a tool name, a hex digest, or a decimal integer — so no
 * field value can forge a boundary and make two different entries serialize
 * to the same string.
 */
const FIELD_SEPARATOR = "\u001f";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of arbitrary content, for building an event's `payloadDigest`. */
export async function digestPayload(payload: unknown): Promise<string> {
  return sha256Hex(typeof payload === "string" ? payload : JSON.stringify(payload ?? null));
}

/**
 * The committed form of an entry. Field order and separator are fixed and
 * must never change: a different serialization produces different hashes,
 * which would invalidate every chain already written.
 */
export function serializeEntry(entry: Omit<AuditEntry, "entryHash">): string {
  return [
    String(entry.sequence),
    entry.previousHash,
    entry.kind,
    entry.label,
    entry.payloadDigest,
    String(entry.count),
  ].join(FIELD_SEPARATOR);
}

/** Chains one event onto a previous hash. */
export async function chainEntry(event: AuditEvent, sequence: number, previousHash: string): Promise<AuditEntry> {
  const unhashed = { ...event, sequence, previousHash };
  return { ...unhashed, entryHash: await sha256Hex(serializeEntry(unhashed)) };
}

/** Chains a run of events onto a chain that already ends at `previousHash`. */
export async function chainEvents(events: AuditEvent[], startSequence: number, previousHash: string): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let hash = previousHash;
  let sequence = startSequence;
  for (const event of events) {
    const entry = await chainEntry(event, sequence, hash);
    entries.push(entry);
    hash = entry.entryHash;
    sequence += 1;
  }
  return entries;
}

export type ChainVerdict =
  | { ok: true; length: number; head: string }
  /**
   * `brokenAt` is the sequence of the first entry that fails to verify. The
   * break is reported rather than thrown so a caller can show *where* a trail
   * stops being trustworthy, not merely that it does.
   */
  | { ok: false; length: number; brokenAt: number; reason: "hash_mismatch" | "link_mismatch" | "sequence_gap" };

/**
 * Recomputes a chain end to end. Catches all three ways a trail can be
 * corrupted: an edited entry (its hash no longer matches its contents), a
 * reordered or substituted entry (a link points at the wrong predecessor),
 * and a deleted entry (a gap in the sequence).
 */
export async function verifyChain(entries: AuditEntry[]): Promise<ChainVerdict> {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      return { ok: false, length: entries.length, brokenAt: entry.sequence, reason: "sequence_gap" };
    }
    if (entry.previousHash !== previousHash) {
      return { ok: false, length: entries.length, brokenAt: entry.sequence, reason: "link_mismatch" };
    }
    const recomputed = await sha256Hex(serializeEntry(entry));
    if (recomputed !== entry.entryHash) {
      return { ok: false, length: entries.length, brokenAt: entry.sequence, reason: "hash_mismatch" };
    }
    previousHash = entry.entryHash;
    expectedSequence += 1;
  }

  return { ok: true, length: entries.length, head: previousHash };
}

/**
 * Where a verified seat message becomes operational data — the P1.1 seam.
 *
 * The plumbing around this is real: the reader authenticates a message against
 * the workspace's allowlist, learns which system it is from (from the allowlist
 * row, never from the body), and calls this. This then captures the normalized
 * envelope into `integration_events` and asks that provider's notification
 * parser to read it.
 *
 * `promoted` means **captured**, not extracted. Every verified message is
 * durably recorded and can be re-read; no provider has an entity parser yet, so
 * the outcome says `unlearned` and the event's status stays `received`. See
 * `notifications.ts` for why that registry is empty rather than filled with
 * formats nobody has seen.
 */

import { captureNotification } from "./notifications.ts";
import { pmsProvider } from "../providers/index.ts";
import type { DbSession } from "@/db/postgres/session";

export interface VerifiedMessage {
  organizationId: string;
  /** From the matching allowlist row. The parser to use is a consequence of consent. */
  providerId: string;
  digest: string;
  objectKey: string;
  raw: string;
}

export interface PromotionOutcome {
  /** True when the envelope was captured — not that entities were extracted. */
  promoted: boolean;
  /** True only when a provider parser recognised the notification. */
  extracted: boolean;
  reason: string;
}

export async function promoteVerifiedMessage(dbSession: DbSession, message: VerifiedMessage): Promise<PromotionOutcome> {
  const descriptor = pmsProvider(message.providerId);
  if (!descriptor) {
    // An allowlist row naming a provider that no longer exists. `allowSender`
    // refuses to create one, so this is a registry change under an old row —
    // worth refusing loudly rather than capturing under a name nothing resolves.
    return {
      promoted: false,
      extracted: false,
      reason: `No descriptor for ${message.providerId}; message retained unparsed.`,
    };
  }

  const captured = await captureNotification(dbSession, message);

  return {
    promoted: true,
    extracted: captured.extraction.recognised,
    reason: captured.created
      ? `Captured as ${descriptor.displayName} notification. ${captured.extraction.reason}`
      : `Already captured. ${captured.extraction.reason}`,
  };
}

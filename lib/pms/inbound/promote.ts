/**
 * Where a verified seat message becomes operational data — the P1.1 seam.
 *
 * The plumbing around this is real: the reader authenticates a message against
 * the workspace's allowlist, learns which system it is from (from the allowlist
 * row, never from the body), and calls this. What does not exist yet is the part
 * that turns one PMS's notification format into an `ImportBatch` for
 * `lib/operations/import-plan.ts` — that is per-provider work and it is P1.1's
 * remaining scope.
 *
 * This module is deliberately a stub that *reports* being a stub rather than a
 * TODO comment in the sweep. The reader records the outcome, so "mail is
 * verified and nothing is parsing it" shows up as a queryable state instead of
 * looking like silence.
 */

import { pmsProvider } from "../providers/index.ts";

export interface VerifiedMessage {
  organizationId: string;
  /** From the matching allowlist row. The parser to use is a consequence of consent. */
  providerId: string;
  digest: string;
  objectKey: string;
  raw: string;
}

export interface PromotionOutcome {
  promoted: boolean;
  reason: string;
}

/**
 * Hand a verified message to the read envelope.
 *
 * Returns rather than throws when there is no parser: an unparsed verified
 * message is an expected state today, not a failure, and the object stays in
 * `verified/` so a later sweep — or the parser, once it exists — can pick it up
 * without the mail having to be sent again.
 */
export async function promoteVerifiedMessage(message: VerifiedMessage): Promise<PromotionOutcome> {
  const descriptor = pmsProvider(message.providerId);
  if (!descriptor) {
    return { promoted: false, reason: `No descriptor for ${message.providerId}; message retained.` };
  }

  return {
    promoted: false,
    reason:
      `No ${descriptor.displayName} notification parser yet (P1.1). Message retained in `
      + "verified/ for the read envelope.",
  };
}

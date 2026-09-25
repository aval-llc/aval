/**
 * Deciding one stored seat message — the half of the sweep that needs a database.
 *
 * Split from `sweep.ts` so the reader Worker can bundle the sweep (listing,
 * prefix budget, object move) without bundling Postgres. The reader holds the
 * unverified inbox and no database; this runs where a DbSession exists and
 * never touches the bucket. See `app/api/pms/seat/adjudicate/route.ts`.
 */

import { authenticatedAddress, observedAuthservIds, parseAuthenticationResults, type SenderVerdict } from "./authentication.ts";
import { disposeMessage, dispositionKey } from "./disposition.ts";
import { recordSeatMessage } from "./messages.ts";
import { promoteVerifiedMessage, type PromotionOutcome } from "./promote.ts";
import { organizationForRecipient } from "./seats.ts";
import { resolveSeatSender } from "./senders.ts";
import type { SeatAdjudicateInput, SeatAdjudication } from "./sweep.ts";
import type { DbSession } from "@/db/postgres/session";

const NO_WORKSPACE: SenderVerdict = {
  verified: false,
  reason: "Addressed to a seat slug that belongs to no workspace.",
};

/**
 * Decide one stored message, and write everything the decision implies.
 *
 * Split out of `processObject` so the component holding the unverified inbox
 * and the component holding the database can be different ones. The reader
 * Worker reads R2 and performs the move; this runs where a DbSession exists and
 * never touches the bucket. Keeping the bucket out of the app is the point of
 * the three-Worker split (`d9210f8` removed a handle that had been pasted in),
 * so this returns the key the object should end up under rather than moving it.
 *
 * The row is written before the caller moves the object, which is the reverse
 * of the order this had when one component did both. A crash in between leaves
 * a row naming a key the object has not reached yet; the next sweep re-lists
 * the original key and re-decides it to the same digest-keyed row.
 */
export async function adjudicateSeatMessage(
  dbSession: DbSession,
  input: SeatAdjudicateInput & {
    promote: (message: Parameters<typeof promoteVerifiedMessage>[1]) => Promise<PromotionOutcome>;
  },
): Promise<SeatAdjudication> {
  const { digest, recipient, raw, authservId, promote } = input;

  const organizationId = recipient ? await organizationForRecipient(dbSession, recipient) : null;
  const auth = parseAuthenticationResults(raw, authservId);

  // `raw` is passed because the exact-mailbox rung reads the `From:` header;
  // the authenticated *domain* is in Authentication-Results, but the mailbox
  // is not, and a grant to one sender cannot be checked without it.
  const resolution = organizationId
    ? await resolveSeatSender(dbSession, organizationId, auth, raw)
    : { verdict: NO_WORKSPACE, providerId: undefined, tier: "review" as const };

  const disposition = disposeMessage({
    organizationId,
    verdict: resolution.verdict,
    providerId: resolution.providerId,
    // Recomputed rather than taken from the resolution, which only carries a
    // mailbox when one was *approved*. A held message's sender is precisely the
    // one nobody has approved yet, and that is the sender a person needs named.
    address: authenticatedAddress(auth, raw)?.address ?? null,
  });

  const targetKey = dispositionKey(disposition, digest);

  let captured = false;
  let extracted = false;
  let reason = resolution.verdict.reason;
  if (disposition.state === "verified" && organizationId && disposition.providerId) {
    const outcome = await promote({
      organizationId,
      providerId: disposition.providerId,
      digest,
      objectKey: targetKey,
      raw,
    });
    captured = outcome.promoted;
    extracted = outcome.extracted;
    // Appended whether or not it succeeded. "Verified, captured, no parser yet"
    // is the normal state today and the row is where anyone would look for it.
    reason = `${reason} ${outcome.reason}`;
  }

  const observed = disposition.state === "unauthenticated" ? observedAuthservIds(raw) : [];

  await recordSeatMessage(dbSession, {
    digest,
    recipient: recipient ?? input.fallbackRecipient ?? "(unparsable)",
    organizationId,
    disposition: disposition.state,
    domain: disposition.domain,
    address: disposition.address,
    method: disposition.method,
    providerId: disposition.providerId,
    reason,
    // Only worth storing when nothing authenticated: that is the case where the
    // expected authserv-id being wrong is indistinguishable from an empty inbox.
    observedAuthservIds: observed.join(", ") || null,
    objectKey: targetKey,
    receivedAt: input.receivedAt,
  });

  return { disposition: disposition.state, organizationId, targetKey, captured, extracted, observedAuthservIds: observed };
}

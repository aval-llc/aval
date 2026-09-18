/**
 * What happens to a stored message once the reader has looked at it.
 *
 * Pure, and separated from the sweep for the usual reason in this directory:
 * the sweep's shape is R2 plumbing that can only be exercised against a bucket,
 * and these four outcomes are the part that is worth asserting exhaustively.
 *
 * The one rule encoded here that is a control rather than a classification:
 * **`domain` is null unless the domain was authenticated.** A held message's
 * `From` is chosen by whoever sent it, so a review surface that named a claimed
 * domain would put attacker-picked text on an operator's screen, next to a
 * button that grants it standing access. Null is what makes "counted, never
 * named" true at the storage layer instead of by convention in a component.
 */

import type { SenderVerdict } from "./authentication.ts";

export type SeatDisposition =
  /** Allowlisted sender, authenticated. Ready for the read envelope. */
  | "verified"
  /**
   * Authenticated, but this workspace has not allowed the domain. The one
   * outcome an operator can act on: the review offers it, and allowing it makes
   * a later sweep reconsider the mail already waiting.
   */
  | "held"
  /** No trusted authentication result, or it did not establish a domain. */
  | "unauthenticated"
  /** Addressed to a seat slug that belongs to no workspace. Nobody to review it. */
  | "unassigned";

export interface DispositionInput {
  /** Null when the recipient's slug resolves to no workspace. */
  organizationId: string | null;
  verdict: SenderVerdict;
  /** From the matching allowlist row, present only on a pass. */
  providerId?: string;
}

export interface MessageDisposition {
  state: SeatDisposition;
  /** R2 prefix the object moves to. The caller appends the content hash. */
  destination: string;
  /**
   * Whether a later sweep reconsiders this message. True only for `held`, which
   * is what makes allowing a sender retroactive — the mail that was waiting is
   * what the operator was told they would get.
   */
  reprocess: boolean;
  /** Recorded only when authentication established it. See the note above. */
  domain: string | null;
  providerId: string | null;
  method: string | null;
}

/** Objects the mail Worker writes, before the reader has classified them. */
export const UNVERIFIED_PREFIX = "unverified";

/**
 * Prefixes the sweep re-lists on every run.
 *
 * Only `held`. A verified message has been handed on, an unauthenticated one has
 * nothing that could change about it, and an unassigned one has no workspace to
 * change its mind — re-reading those would be work whose outcome is fixed.
 */
export const REPROCESS_PREFIXES: readonly string[] = ["held"];

export function disposeMessage(input: DispositionInput): MessageDisposition {
  const { organizationId, verdict, providerId } = input;

  if (organizationId === null) {
    // Mail to an address that was never issued. The Worker stores it because it
    // has no database to check against; here there is nothing to do with it and
    // nobody it could be shown to.
    return {
      state: "unassigned",
      destination: "rejected/unassigned",
      reprocess: false,
      domain: null,
      providerId: null,
      method: null,
    };
  }

  if (verdict.verified && verdict.domain && providerId) {
    return {
      state: "verified",
      destination: `verified/${organizationId}`,
      reprocess: false,
      domain: verdict.domain,
      providerId,
      method: verdict.method ?? null,
    };
  }

  if (verdict.domain) {
    // Authenticated and not allowed. `verdict.domain` is only ever set from a
    // passing DMARC or DKIM result, which is what makes it safe to store.
    return {
      state: "held",
      destination: `held/${organizationId}`,
      reprocess: true,
      domain: verdict.domain,
      providerId: null,
      method: verdict.method ?? null,
    };
  }

  return {
    state: "unauthenticated",
    destination: `rejected/${organizationId}`,
    reprocess: false,
    domain: null,
    providerId: null,
    method: null,
  };
}

/** The key an object takes under its disposition. */
export function dispositionKey(disposition: MessageDisposition, digest: string): string {
  return `${disposition.destination}/${digest}`;
}

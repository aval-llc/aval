/**
 * The seat reader's sweep — the only place that holds both the unverified inbox
 * and the database.
 *
 * ## Why this is a third component
 *
 * `worker/pms-seat-inbound.ts` stores stranger mail and has no database, and the
 * app Worker has no handle on that bucket (`d9210f8`). Both of those are
 * deliberate, and between them they mean nothing in either component can decide
 * whether a stored message may be read. This runs in `aval-pms-seat-reader`,
 * whose input is already-stored bytes rather than a live SMTP conversation, and
 * which is the one component that may hold both handles.
 *
 * ## Why verification happens here rather than at receipt
 *
 * Deciding at receipt would need the allowlist, which means giving the mail
 * isolate org data — and the mail isolate's dumbness (store the bytes, parse
 * nothing) is the property that makes it safe to point a domain catch-all at.
 * So the Worker keeps storing everything unparsed and this decides.
 *
 * ## Re-running is the normal case
 *
 * Every row is keyed on the message's content hash and every object move is
 * idempotent, so a sweep that dies halfway, runs twice, or overlaps itself
 * converges. `held/` is re-listed on every run because allowing a sender has to
 * be retroactive: an operator told "4 messages are waiting" and then shown
 * nothing after clicking Allow would have been lied to.
 */

import { observedAuthservIds, parseAuthenticationResults, type SenderVerdict } from "./authentication.ts";
import {
  disposeMessage,
  dispositionKey,
  REPROCESS_PREFIXES,
  type SeatDisposition,
  UNVERIFIED_PREFIX,
} from "./disposition.ts";
import { recordSeatMessage } from "./messages.ts";
import { promoteVerifiedMessage, type PromotionOutcome } from "./promote.ts";
import { seatSlugOf } from "./seat-address.ts";
import { organizationForRecipient } from "./seats.ts";
import { resolveSeatSender } from "./senders.ts";

/**
 * The slice of R2 this needs, declared structurally so the sweep can be tested
 * against a fake. Matches `R2Bucket` without importing workers-types into the
 * app's module graph.
 */
export interface SeatObjectRef {
  key: string;
  uploaded?: Date;
  customMetadata?: Record<string, string>;
}

export interface SeatObjectBody extends SeatObjectRef {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SeatBucket {
  list(options: {
    prefix: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: SeatObjectRef[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<SeatObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface SweepOptions {
  bucket: SeatBucket;
  /**
   * The authserv-id the receiving MTA stamps. Passed in rather than inferred:
   * `authentication.ts` refuses a message whose topmost result does not bear
   * this id, and loosening that to "whatever the message says" is the whole
   * forgery this path exists to stop.
   */
  authservId: string;
  /** Objects per run. The cron has a CPU budget and a backlog is not urgent. */
  limit?: number;
  promote?: (message: Parameters<typeof promoteVerifiedMessage>[0]) => Promise<PromotionOutcome>;
}

export interface SweepSummary {
  processed: number;
  verified: number;
  held: number;
  unauthenticated: number;
  unassigned: number;
  /** Verified messages whose envelope was captured into `integration_events`. */
  captured: number;
  /**
   * Captured messages a provider parser actually recognised.
   *
   * Reported separately from `captured` because they are different claims, and
   * conflating them would make an empty parser registry look like working
   * ingestion. Today this is always zero (see notifications.ts).
   */
  extracted: number;
  /** Objects that threw. Left in place, so the next run retries them. */
  failed: number;
  /** True when the limit was reached before the backlog was. */
  truncated: boolean;
  /**
   * Authserv-ids seen on messages that authenticated nothing, deduped.
   *
   * Reported by the run rather than queried back out, which keeps `lib/pms`
   * uniformly org-scoped — a cross-org triage query is the exact shape
   * `tests/org-scoping-isolation.test.ts` exists to refuse, and hiding it
   * outside that directory would be dodging the gate rather than passing it.
   *
   * This is the answer to "nothing verifies and we cannot tell whether the
   * expected authserv-id is simply wrong". Sender-influenced, so the Worker
   * logs it and no customer-facing surface renders it.
   */
  observedAuthservIds: string[];
}

const DEFAULT_LIMIT = 200;

/** `unverified/agent-acme@aval.llc/<digest>` → the recipient and the digest. */
function partsFromKey(key: string): { recipient: string | null; digest: string } {
  const segments = key.split("/");
  const digest = segments[segments.length - 1] ?? "";
  // Only the unverified prefix carries the recipient; later prefixes are keyed
  // by organization, and the recipient comes from the object's metadata.
  const recipient = segments.length === 3 && segments[0] === UNVERIFIED_PREFIX ? segments[1] : null;
  return { recipient, digest };
}

/**
 * Which seat address this message was sent to.
 *
 * Metadata first (the mail Worker wrote it, and it survives a move), then the
 * key. Either way the result goes through `seatSlugOf`, because a recipient that
 * is not a seat address cannot resolve to a workspace and must not be allowed to
 * look like one.
 */
function recipientOf(object: SeatObjectRef): string | null {
  const claimed = object.customMetadata?.recipient ?? partsFromKey(object.key).recipient;
  if (!claimed) return null;
  const recipient = claimed.trim().toLowerCase();
  return seatSlugOf(recipient) === null ? null : recipient;
}

const NO_WORKSPACE: SenderVerdict = {
  verified: false,
  reason: "Addressed to a seat slug that belongs to no workspace.",
};

export async function sweepSeatInbox(options: SweepOptions): Promise<SweepSummary> {
  const { bucket, authservId } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const promote = options.promote ?? promoteVerifiedMessage;

  const summary: SweepSummary = {
    processed: 0,
    verified: 0,
    held: 0,
    unauthenticated: 0,
    unassigned: 0,
    captured: 0,
    extracted: 0,
    failed: 0,
    truncated: false,
    observedAuthservIds: [],
  };

  const observed = new Set<string>();

  // Reprocessed prefixes first, new mail second. Not cosmetic: sweeping
  // `unverified/` first moves messages into `held/`, and the same run would then
  // list and re-read what it had just written — double-counting every held
  // message and spending the budget twice on it. Going the other way round, a
  // message newly moved to `held/` waits for the next run, and nothing about it
  // can have changed in the meantime.
  const prefixes = [...REPROCESS_PREFIXES, UNVERIFIED_PREFIX];
  // Budgeted per prefix rather than first-come. A backlog under `unverified/`
  // must not starve `held/`, because an operator who has just allowed a sender
  // is waiting on exactly that re-read — and the reverse starvation would stop
  // new mail being seen at all.
  const budget = Math.max(1, Math.ceil(limit / prefixes.length));

  for (const prefix of prefixes) {
    let handled = 0;
    let cursor: string | undefined;
    for (;;) {
      const remaining = budget - handled;
      if (remaining <= 0) {
        summary.truncated = true;
        break;
      }

      const page = await bucket.list({ prefix: `${prefix}/`, limit: Math.min(remaining, 1000), cursor });
      for (const object of page.objects) {
        handled += 1;
        try {
          const state = await processObject(object, { bucket, authservId, promote });
          if (state.disposition === null) continue;
          summary.processed += 1;
          summary[state.disposition] += 1;
          if (state.captured) summary.captured += 1;
          if (state.extracted) summary.extracted += 1;
          for (const id of state.observedAuthservIds) observed.add(id);
        } catch {
          // Left where it is on purpose: the next run retries, and a message
          // that cannot be processed must not be silently dropped from the
          // inbox. The reason is logged by the caller, not swallowed here.
          summary.failed += 1;
        }
      }

      if (!page.truncated) break;
      cursor = page.cursor;
    }
  }

  // Capped: this is a diagnostic line in a log, and a spam run must not be able
  // to make it unbounded.
  summary.observedAuthservIds = [...observed].slice(0, 10);
  return summary;
}

async function processObject(
  object: SeatObjectRef,
  context: {
    bucket: SeatBucket;
    authservId: string;
    promote: NonNullable<SweepOptions["promote"]>;
  },
): Promise<{
  disposition: SeatDisposition | null;
  captured: boolean;
  extracted: boolean;
  observedAuthservIds: readonly string[];
}> {
  const { bucket, authservId, promote } = context;
  const { digest } = partsFromKey(object.key);
  const recipient = recipientOf(object);

  const body = await bucket.get(object.key);
  if (!body) {
    // Deleted between the list and the get — a concurrent sweep got there
    // first, and the row it wrote is the row this one would have written.
    // Counted as nothing rather than as a disposition it did not receive.
    return { disposition: null, captured: false, extracted: false, observedAuthservIds: [] };
  }

  const bytes = await body.arrayBuffer();
  // Headers are ASCII; a non-strict decode keeps a message with 8-bit body
  // content readable for header parsing instead of throwing on it.
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  const organizationId = recipient ? await organizationForRecipient(recipient) : null;
  const auth = parseAuthenticationResults(raw, authservId);

  const resolution = organizationId
    ? await resolveSeatSender(organizationId, auth)
    : { verdict: NO_WORKSPACE, providerId: undefined };

  const disposition = disposeMessage({
    organizationId,
    verdict: resolution.verdict,
    providerId: resolution.providerId,
  });

  const key = dispositionKey(disposition, digest);
  if (key !== object.key) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        ...(body.customMetadata ?? {}),
        // Overwrites the mail Worker's `verified: "false"` with what was
        // actually decided, so the object and the row cannot disagree.
        verified: String(disposition.state === "verified"),
        disposition: disposition.state,
      },
    });
    await bucket.delete(object.key);
  }

  let captured = false;
  let extracted = false;
  let reason = resolution.verdict.reason;
  if (disposition.state === "verified" && organizationId && disposition.providerId) {
    const outcome = await promote({
      organizationId,
      providerId: disposition.providerId,
      digest,
      objectKey: key,
      raw,
    });
    captured = outcome.promoted;
    extracted = outcome.extracted;
    // Appended whether or not it succeeded. "Verified, captured, no parser yet"
    // is the normal state today and the row is where anyone would look for it.
    reason = `${reason} ${outcome.reason}`;
  }

  const observed = disposition.state === "unauthenticated" ? observedAuthservIds(raw) : [];

  await recordSeatMessage({
    digest,
    recipient: recipient ?? object.customMetadata?.recipient ?? "(unparsable)",
    organizationId,
    disposition: disposition.state,
    domain: disposition.domain,
    method: disposition.method,
    providerId: disposition.providerId,
    reason,
    // Only worth storing when nothing authenticated: that is the case where the
    // expected authserv-id being wrong is indistinguishable from an empty inbox.
    observedAuthservIds: observed.join(", ") || null,
    objectKey: key,
    receivedAt: receivedAtOf(object),
  });

  return { disposition: disposition.state, captured, extracted, observedAuthservIds: observed };
}

/**
 * When the message arrived.
 *
 * R2's own `uploaded` first, because the mail Worker's `receivedAt` metadata is
 * a string it wrote and this one is the storage layer's. Both are ours rather
 * than the sender's; the preference is for the one that cannot be edited by a
 * later `put`.
 */
function receivedAtOf(object: SeatObjectRef): Date {
  if (object.uploaded instanceof Date && !Number.isNaN(object.uploaded.getTime())) {
    return object.uploaded;
  }
  const claimed = object.customMetadata?.receivedAt;
  const parsed = claimed ? new Date(claimed) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

/**
 * The Aval seat's reader — the component that decides whether stored mail may
 * be read (docs/PMS_INTEGRATION.md, P1).
 *
 * Three Workers, and the split is the security design rather than tidiness:
 *
 *   - `aval-pms-seat-inbound` handles live SMTP from strangers. No database, no
 *     parsing, no HTTP surface. It stores bytes.
 *   - `aval` (the app) serves authenticated users. No handle on the unverified
 *     inbox — `d9210f8` removed one that had been pasted in.
 *   - this, on a schedule. It holds the only handle on the unverified inbox.
 *
 * This Worker used to hold both halves: the bucket and a D1 binding. The app's
 * move to Supabase Postgres took the database out from under it, and rather than
 * give this Worker Postgres credentials — or give the app the bucket, which is
 * the handle `d9210f8` deliberately removed — the decision now happens behind one
 * authenticated call to `/api/pms/seat/adjudicate`, per message.
 *
 * The sweep itself still lives in `lib/pms/inbound/sweep.ts`: which prefixes are
 * re-listed, in what order, under what per-prefix budget, and where a decided
 * object is moved to. Only the decision is remote. Reimplementing any of that
 * here would be a second copy to keep in step with the first.
 *
 * Deploy:  npx wrangler deploy --config wrangler.reader.jsonc
 */

import {
  sweepSeatInbox,
  type SeatAdjudication,
  type SeatAdjudicateInput,
  type SeatBucket,
} from "../lib/pms/inbound/sweep.ts";

export interface ReaderEnv {
  /** The unverified inbox the mail Worker writes. Read, moved, never forwarded. */
  PMS_SEAT_INBOX: R2Bucket;
  /** Origin of the app that owns the database, e.g. https://aval.llc */
  PMS_SEAT_ADJUDICATOR_URL?: string;
  /** Shared secret for that call. Set with `wrangler secret put`, never a var. */
  PMS_SEAT_READER_TOKEN?: string;
  /**
   * The authserv-id the receiving MTA stamps on `Authentication-Results`.
   *
   * A var rather than a constant because Cloudflare does not document the value
   * and it is the one input that silently changes what this Worker concludes: a
   * wrong id means every message fails closed, which looks exactly like an inbox
   * nobody has written to. `pms_seat_messages.observed_authserv_ids` is recorded
   * for that case, and a missing var throws below rather than defaulting.
   */
  PMS_SEAT_AUTHSERV_ID?: string;
  /** Objects per run. Raise it to work through a backlog faster. */
  PMS_SEAT_SWEEP_LIMIT?: string;
}

export default {
  async scheduled(_event: ScheduledController, env: ReaderEnv): Promise<void> {
    const authservId = env.PMS_SEAT_AUTHSERV_ID?.trim();
    if (!authservId) {
      // Deliberately fatal. Defaulting would make every message unauthenticated
      // and the cron would report success while verifying nothing, which is the
      // failure this whole path is shaped to avoid.
      throw new Error(
        "PMS_SEAT_AUTHSERV_ID is not set. The reader cannot verify senders without the "
        + "authserv-id the receiving MTA stamps, and must not fall back to trusting the message.",
      );
    }

    const origin = env.PMS_SEAT_ADJUDICATOR_URL?.trim();
    const token = env.PMS_SEAT_READER_TOKEN?.trim();
    if (!origin || !token) {
      // Same reasoning. A reader that cannot reach the adjudicator must fail
      // loudly rather than walk the inbox deciding nothing.
      throw new Error(
        "PMS_SEAT_ADJUDICATOR_URL and PMS_SEAT_READER_TOKEN must both be set. The reader holds "
        + "the inbox but no database, and cannot decide a message on its own.",
      );
    }

    /** One message, one authenticated call. Never a handle on the bucket. */
    const adjudicate = async (input: SeatAdjudicateInput): Promise<SeatAdjudication> => {
      const response = await fetch(new URL("/api/pms/seat/adjudicate", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...input, receivedAt: input.receivedAt.getTime() }),
      });
      if (!response.ok) {
        // Thrown so the sweep counts it as failed and leaves the object where
        // it is. The next run retries it; a persistent failure fails the cron.
        throw new Error(`Adjudicator returned ${response.status}.`);
      }
      return (await response.json()) as SeatAdjudication;
    };

    const limit = Number(env.PMS_SEAT_SWEEP_LIMIT ?? "");
    const summary = await sweepSeatInbox({
      bucket: env.PMS_SEAT_INBOX as unknown as SeatBucket,
      authservId,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      adjudicate,
    });

    // One line, all counts, no message content: this log is the evidence that
    // the sweep ran, and it is read when a customer says their PMS mail is not
    // arriving. Bodies and claimed senders are never logged.
    console.log(
      `[pms-seat-reader] processed=${summary.processed} verified=${summary.verified} `
      + `held=${summary.held} unauthenticated=${summary.unauthenticated} `
      + `unassigned=${summary.unassigned} captured=${summary.captured} `
      + `extracted=${summary.extracted} `
      + `failed=${summary.failed} truncated=${summary.truncated}`,
    );

    if (summary.observedAuthservIds.length > 0) {
      // Only when something failed to authenticate. This is the line that
      // answers "is the expected authserv-id simply wrong", which otherwise
      // looks exactly like an inbox nobody has written to. Logged rather than
      // queried back out, so `lib/pms` stays uniformly org-scoped.
      console.log(
        `[pms-seat-reader] expected authserv-id ${authservId}; observed on unauthenticated mail: `
        + summary.observedAuthservIds.join(", "),
      );
    }

    if (summary.failed > 0) {
      // Surfaced as a failed cron run rather than a quiet counter. The objects
      // are still in place and the next run retries them, but a persistent
      // failure has to be visible somewhere that is watched.
      throw new Error(`${summary.failed} seat message(s) could not be processed; they remain in the inbox.`);
    }
  },
};
